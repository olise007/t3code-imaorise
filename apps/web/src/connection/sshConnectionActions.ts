import type { DesktopBridge, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { sshSetupOperations } from "./sshSetupOperations";
import { sshServerLifecycle } from "./sshServerLifecycle";
import { sshSetupProgress, sshSetupTargetKey } from "./sshSetupProgress";

interface SshServerAction {
  target: DesktopSshEnvironmentTarget;
  environmentId?: string;
  label: string;
  bridge: DesktopBridge;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  notify: (message: string) => void;
}

/** Shared by explicit Start/Stop and the connection switch; never installs a runtime. */
export async function runSshServerAction(
  { target, environmentId, label, bridge, setEnabled, notify }: SshServerAction,
  action: "start" | "stop",
): Promise<boolean> {
  const targetKey = sshSetupTargetKey(target);
  const busy = () => ["starting", "stopping"].includes(sshServerLifecycle.read(target).state);
  if (busy()) return false;
  try {
    await sshSetupOperations.cancel(target);
  } catch (error) {
    sshServerLifecycle.observe(target, {
      state: "unknown",
      checkedAt: new Date().toISOString(),
      detail: error instanceof Error ? error.message : "Could not cancel the active SSH operation.",
    });
    return false;
  }
  if (busy()) return false;
  const id = sshSetupProgress.begin(target);
  let cancelled = false;
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  if (
    !sshSetupOperations.register(target, id, async () => {
      cancelled = true;
      await bridge.cancelSshSetup?.(target, id);
      await done;
    })
  ) {
    sshSetupProgress.finish(id, "cancelled");
    return false;
  }
  try {
    const succeeded = await sshServerLifecycle.run(target, action, async () => {
      await bridge.cancelSshSetup?.(target);
      if (cancelled) throw new Error("SSH lifecycle operation cancelled.");
      if (action === "stop" && !(await setEnabled(false)))
        throw new Error("Could not pause client reconnect. The server was not stopped.");
      if (cancelled) throw new Error("SSH lifecycle operation cancelled.");
      if (environmentId) sshSetupProgress.associateEnvironment(id, environmentId);
      const unsubscribe = bridge.onSshConnectionProgress?.((event) => {
        if (
          event.operationId === id ||
          (action === "stop" &&
            event.operationId === undefined &&
            sshSetupTargetKey(event.target) === targetKey)
        )
          sshSetupProgress.append(id, event.stage);
      });
      sshSetupProgress.append(
        id,
        action === "stop"
          ? "Stopping the attested remote server…"
          : "Starting the prepared remote server…",
      );
      try {
        if (action === "stop") {
          if (!bridge.stopSshEnvironment) throw new Error("Update Desktop to stop this server.");
          if (bridge.sshServerStatus && environmentId) {
            const before = await bridge.sshServerStatus(target);
            if (before.environmentId && before.environmentId !== environmentId)
              throw new Error("Remote environment identity changed. The server was not stopped.");
          }
          if (cancelled) throw new Error("SSH lifecycle operation cancelled.");
          await bridge.stopSshEnvironment(target, {
            ...(environmentId ? { expectedEnvironmentId: environmentId } : {}),
            operationId: id,
          });
        } else {
          if (cancelled) throw new Error("SSH lifecycle operation cancelled.");
          const result = await bridge.ensureSshEnvironment(target, {
            ...(environmentId ? { expectedEnvironmentId: environmentId } : {}),
            resumeStoppedServer: true,
            operationId: id,
          });
          if (cancelled) throw new Error("SSH lifecycle operation cancelled.");
          if (result.serverState === "stopped")
            throw new Error("The remote server remains explicitly stopped.");
        }
        if (!bridge.sshServerStatus)
          throw new Error(
            "Status unknown: update Desktop and repair the runtime to verify server lifecycle.",
          );
        const status = await bridge.sshServerStatus(target);
        sshSetupProgress.append(id, `Verified remote server status: ${status.state}`);
        sshSetupProgress.finish(
          id,
          status.state === (action === "stop" ? "stopped" : "running") ? "succeeded" : "failed",
        );
        if (cancelled) throw new Error("SSH lifecycle operation cancelled.");
        return status;
      } catch (error) {
        sshSetupProgress.append(
          id,
          error instanceof Error ? error.message : `Remote ${action} failed.`,
        );
        sshSetupProgress.finish(id, "failed");
        throw error;
      } finally {
        unsubscribe?.();
      }
    });
    if (!succeeded || cancelled) return false;
    if (action === "start" && !(await setEnabled(true))) return false;
    notify(
      action === "stop" ? `Remote server stopped on ${label}` : `Remote server running on ${label}`,
    );
    return true;
  } finally {
    if (sshSetupProgress.runningOperation(target) === id) {
      const error = sshServerLifecycle.read(target).error;
      if (error) sshSetupProgress.append(id, error);
      sshSetupProgress.finish(id, cancelled ? "cancelled" : "failed");
    }
    sshSetupOperations.end(target, id);
    complete();
  }
}

/** The switch controls this client. Resuming a stopped server is a separate explicit choice. */
export async function setSshConnectionEnabled(
  input: SshServerAction & { confirmStart: (signal: AbortSignal) => Promise<boolean> },
  enabled: boolean,
): Promise<boolean> {
  const { target } = input;
  if (input.environmentId) sshServerLifecycle.bind(target, input.environmentId);
  if (sshSetupOperations.isRemoving(target)) return false;
  if (!enabled) {
    await sshSetupOperations.cancel(target);
    return input.setEnabled(false);
  }
  if (["starting", "stopping"].includes(sshServerLifecycle.read(target).state)) return false;
  const id = crypto.randomUUID();
  let cancelled = false;
  const confirmation = new AbortController();
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  if (
    !sshSetupOperations.register(target, id, async () => {
      cancelled = true;
      confirmation.abort();
      await done;
    })
  )
    return false;

  try {
    let state = sshServerLifecycle.read(target);
    if (!state.stopIntent && state.state !== "stopped" && input.bridge.sshServerStatus) {
      const observed = await input.bridge.sshServerStatus(target);
      if (cancelled) return false;
      sshServerLifecycle.observe(target, observed);
      state = sshServerLifecycle.read(target);
      if (state.error) throw new Error(state.error);
    }
    if (state.stopIntent || state.state === "stopped") {
      const start = await input.confirmStart(confirmation.signal);
      if (!start || cancelled) return false;
    } else {
      // The connection runtime owns preparation and application synchronization.
      if (cancelled) return false;
      return await input.setEnabled(true);
    }
  } finally {
    sshSetupOperations.end(target, id);
    complete();
  }
  if (cancelled || sshSetupOperations.isRemoving(target)) return false;
  return runSshServerAction(input, "start");
}
