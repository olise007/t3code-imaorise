import { useEffect, useSyncExternalStore } from "react";
import type { DesktopBridge, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { sshSetupOperations } from "../../connection/sshSetupOperations";
import { sshServerLifecycle } from "../../connection/sshServerLifecycle";
import { sshSetupProgress, sshSetupTargetKey } from "../../connection/sshSetupProgress";
import { Button } from "../ui/button";

export function SshServerControls({
  target,
  environmentId,
  label,
  bridge,
  setEnabled,
  confirmStop,
  notify,
}: {
  target: DesktopSshEnvironmentTarget;
  environmentId?: string;
  label: string;
  bridge: DesktopBridge;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  confirmStop: () => Promise<boolean>;
  notify: (message: string) => void;
}) {
  const state = useSyncExternalStore(sshServerLifecycle.subscribe, () =>
    sshServerLifecycle.read(target),
  );
  const targetKey = sshSetupTargetKey(target);
  useEffect(() => {
    if (environmentId) sshServerLifecycle.bind(target, environmentId);
    let active = true;
    const previous = sshServerLifecycle.read(target);
    void bridge
      .sshServerStatus?.(target)
      .then((status) => {
        if (active && sshServerLifecycle.read(target) === previous)
          sshServerLifecycle.observe(target, status);
      })
      .catch((error: unknown) => {
        if (active && sshServerLifecycle.read(target) === previous)
          sshServerLifecycle.observe(target, {
            state: "unknown",
            checkedAt: new Date().toISOString(),
            detail:
              error instanceof Error
                ? error.message
                : "Could not verify remote server status. Authenticate explicitly or retry.",
          });
      });
    return () => {
      active = false;
    };
  }, [targetKey, environmentId, bridge]);
  const pending = state.state === "starting" || state.state === "stopping";
  async function perform(action: "start" | "stop") {
    if (pending || (action === "stop" && !(await confirmStop()))) return;
    const busy = () => ["starting", "stopping"].includes(sshServerLifecycle.read(target).state);
    if (busy()) return;
    try {
      await sshSetupOperations.cancel(target);
    } catch (error) {
      sshServerLifecycle.observe(target, {
        state: "unknown",
        checkedAt: new Date().toISOString(),
        detail:
          error instanceof Error ? error.message : "Could not cancel the active SSH operation.",
      });
      return;
    }
    if (busy()) return;
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
      return;
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
      if (!succeeded || cancelled) return;
      if (action === "start") await setEnabled(true);
      notify(
        action === "stop"
          ? `Remote server stopped on ${label}`
          : `Remote server running on ${label}`,
      );
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
  const names = {
    starting: "Starting",
    running: "Running",
    stopping: "Stopping",
    stopped: "Stopped",
    unknown: "Status unknown",
  };
  return (
    <div className="mt-2 space-y-2">
      <p role="status" className="text-xs">
        Remote server: {names[state.state]}
        {state.cached ? " (last confirmed; not yet verified)" : ""}
      </p>
      {state.state === "unknown" && state.lastConfirmedState ? (
        <p className="text-xs text-muted-foreground">
          Last confirmed: {names[state.lastConfirmedState]}
          {state.lastConfirmedAt ? ` at ${new Date(state.lastConfirmedAt).toLocaleString()}` : ""}
        </p>
      ) : null}
      {state.checkedAt ? (
        <p className="text-xs text-muted-foreground">
          Last checked: {new Date(state.checkedAt).toLocaleString()}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="max-w-md break-words text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        {state.stopIntent || state.state === "stopped" || state.state === "unknown" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => void perform("start")}
          >
            Start remote server
          </Button>
        ) : null}
        {state.state !== "stopped" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending || !bridge.stopSshEnvironment}
            onClick={() => void perform("stop")}
          >
            {state.error ? "Retry stop" : "Stop remote server…"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
