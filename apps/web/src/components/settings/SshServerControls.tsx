import { useEffect, useSyncExternalStore } from "react";
import type { DesktopBridge, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { runSshServerAction } from "../../connection/sshConnectionActions";
import { sshServerLifecycle } from "../../connection/sshServerLifecycle";
import { sshSetupTargetKey } from "../../connection/sshSetupProgress";
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
    await runSshServerAction(
      { target, ...(environmentId ? { environmentId } : {}), label, bridge, setEnabled, notify },
      action,
    );
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
