import type { DesktopSshEnvironmentTarget, DesktopSshServerStatus } from "@t3tools/contracts";
import { sanitizeSetupOutput } from "@t3tools/shared/setupDetails";
import { sshSetupTargetKey } from "./sshSetupProgress";

type ServerState = DesktopSshServerStatus["state"] | "starting" | "stopping";
export interface SshServerState {
  readonly state: ServerState;
  readonly stopIntent: boolean;
  readonly cached: boolean;
  readonly lastConfirmedState?: "running" | "stopped";
  readonly lastConfirmedAt?: string;
  readonly checkedAt?: string;
  readonly error?: string;
  readonly environmentId?: string;
}
const unknown: SshServerState = { state: "unknown", stopIntent: false, cached: false };
const storageKey = "t3:ssh-server-lifecycle:v1";

/** Client stop intent is durable; cached observations never establish current server ownership. */
export function createSshServerLifecycle(storage?: Pick<Storage, "getItem" | "setItem">) {
  const states = new Map<string, SshServerState>();
  const operations = new Map<string, symbol>();
  const listeners = new Set<() => void>();
  try {
    const rows: unknown = JSON.parse(storage?.getItem(storageKey) ?? "[]");
    if (Array.isArray(rows))
      for (const row of rows.slice(-100)) {
        if (
          !Array.isArray(row) ||
          typeof row[0] !== "string" ||
          !row[1] ||
          typeof row[1] !== "object"
        )
          continue;
        const value = row[1] as Record<string, unknown>;
        if (!["running", "stopped", "unknown"].includes(String(value.state))) continue;
        states.set(row[0], {
          state: value.state as DesktopSshServerStatus["state"],
          stopIntent: value.stopIntent === true,
          cached: true,
          ...(typeof value.checkedAt === "string" ? { checkedAt: value.checkedAt } : {}),
          ...(value.lastConfirmedState === "running" || value.lastConfirmedState === "stopped"
            ? { lastConfirmedState: value.lastConfirmedState }
            : {}),
          ...(typeof value.lastConfirmedAt === "string"
            ? { lastConfirmedAt: value.lastConfirmedAt }
            : {}),
          ...(typeof value.environmentId === "string"
            ? { environmentId: value.environmentId }
            : {}),
        });
      }
  } catch {
    /* Storage failure must not prevent managing a connection. */
  }
  const notify = () => {
    try {
      storage?.setItem(
        storageKey,
        JSON.stringify(
          [...states].slice(-100).map(([key, value]) => [
            key,
            {
              state:
                value.state === "starting" || value.state === "stopping" ? "unknown" : value.state,
              stopIntent: value.stopIntent,
              lastConfirmedState: value.lastConfirmedState,
              lastConfirmedAt: value.lastConfirmedAt,
              checkedAt: value.checkedAt,
              environmentId: value.environmentId,
            },
          ]),
        ),
      );
    } catch {
      /* Session state still works when storage is unavailable. */
    }
    for (const listener of listeners) listener();
  };
  const read = (target: DesktopSshEnvironmentTarget) =>
    states.get(sshSetupTargetKey(target)) ?? unknown;
  const group = (target: DesktopSshEnvironmentTarget) =>
    read(target).environmentId ?? sshSetupTargetKey(target);
  const write = (target: DesktopSshEnvironmentTarget, state: SshServerState) => {
    states.set(sshSetupTargetKey(target), state);
    if (state.environmentId)
      for (const [key, other] of states) {
        if (other.environmentId === state.environmentId) states.set(key, state);
      }
    notify();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read,
    bind: (target: DesktopSshEnvironmentTarget, environmentId: string) => {
      if (read(target).environmentId === environmentId) return;
      const shared = [...states.values()].find((state) => state.environmentId === environmentId);
      write(target, { ...(shared ?? read(target)), environmentId });
    },
    observe: (target: DesktopSshEnvironmentTarget, status: DesktopSshServerStatus) => {
      if (operations.has(group(target))) return;
      const previous = read(target);
      if (
        status.environmentId &&
        previous.environmentId &&
        status.environmentId !== previous.environmentId
      ) {
        write(target, {
          ...previous,
          state: "unknown",
          cached: false,
          error: "Remote environment identity changed. Repair this connection explicitly.",
        });
        return;
      }
      write(target, {
        ...previous,
        state: status.state,
        ...(status.state !== "unknown"
          ? { lastConfirmedState: status.state, lastConfirmedAt: status.checkedAt }
          : {}),
        checkedAt: status.checkedAt,
        cached: false,
        stopIntent: previous.stopIntent || status.state === "stopped",
        error: status.detail ? sanitizeSetupOutput(status.detail).slice(0, 2000) : undefined,
      });
    },
    run: async (
      target: DesktopSshEnvironmentTarget,
      action: "start" | "stop",
      work: () => Promise<DesktopSshServerStatus>,
    ) => {
      const key = group(target);
      if (operations.has(key)) return false;
      const token = Symbol();
      operations.set(key, token);
      write(target, {
        ...read(target),
        state: action === "start" ? "starting" : "stopping",
        stopIntent: action === "stop" || read(target).stopIntent,
        cached: false,
        error: undefined,
      });
      try {
        const result = await work();
        if (operations.get(key) !== token) return false;
        const expected = action === "stop" ? "stopped" : "running";
        if (result.state !== expected)
          throw new Error(
            result.detail ??
              `Server ${action} could not be verified. Check progress details and retry.`,
          );
        const previous = read(target);
        if (
          result.environmentId &&
          previous.environmentId &&
          result.environmentId !== previous.environmentId
        )
          throw new Error(
            "Remote environment identity changed. Repair this connection explicitly.",
          );
        write(target, {
          ...previous,
          state: expected,
          lastConfirmedState: expected,
          lastConfirmedAt: result.checkedAt,
          stopIntent: action === "stop",
          checkedAt: result.checkedAt,
          cached: false,
          error: undefined,
        });
        return true;
      } catch (error) {
        if (operations.get(key) === token)
          write(target, {
            ...read(target),
            state: "unknown",
            cached: false,
            error: sanitizeSetupOutput(
              error instanceof Error ? error.message : `Could not ${action} remote server.`,
            ).slice(0, 2000),
          });
        return false;
      } finally {
        if (operations.get(key) === token) operations.delete(key);
      }
    },
    forgetEnvironment: (environmentId: string, targets: readonly DesktopSshEnvironmentTarget[]) => {
      const keys = new Set(targets.map(sshSetupTargetKey));
      operations.delete(environmentId);
      for (const [key, state] of states)
        if (state.environmentId === environmentId || keys.has(key)) {
          operations.delete(key);
          states.delete(key);
        }
      notify();
    },
  };
}
const storage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
export const sshServerLifecycle = createSshServerLifecycle(storage());
