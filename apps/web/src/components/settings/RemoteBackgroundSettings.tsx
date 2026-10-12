import type {
  DesktopBackgroundSettings,
  DesktopRuntimeRequestInput,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function RemoteBackgroundSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const allowed = useAtomValue(
    serverEnvironment.manageDesktopRuntime.permissionAtom(environmentId),
  );
  const run = useAtomCommand(serverEnvironment.manageDesktopRuntime, { reportFailure: false });
  const [settings, setSettings] = useState<DesktopBackgroundSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const act = async (input: DesktopRuntimeRequestInput) => {
    if (busy || !allowed) return;
    setBusy(true);
    setError(false);
    try {
      const result = await run({ environmentId, input });
      if (result._tag === "Success") setSettings(result.value);
      else setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <SettingsRow
        title="WSL background server"
        description={
          settings
            ? `${settings.distro}: ${settings.serverRunning ? "Running" : "Stopped or connecting"}. Stop interrupts its agents and tools.`
            : "Manage the WSL environment hosted by this desktop."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !allowed}
            onClick={() =>
              void act({ action: settings ? (settings.serverRunning ? "stop" : "start") : "get" })
            }
          >
            {settings
              ? settings.serverRunning
                ? "Stop background server"
                : "Start background server"
              : "Manage background server"}
          </Button>
        }
      />
      {settings ? (
        <SettingsRow
          title="Keep agents running when T3 closes"
          description="Changes apply on the host's next exit."
          control={
            <Switch
              checked={settings.keepAgentsRunning}
              disabled={busy || !allowed}
              aria-label="Keep agents running when T3 closes"
              onCheckedChange={(keepAgentsRunning) =>
                void act({
                  action: "set",
                  settings: { distro: settings.distro, keepAgentsRunning },
                })
              }
            />
          }
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          The desktop host could not complete this action. Check its connection and retry.
        </p>
      ) : null}
    </div>
  );
}
