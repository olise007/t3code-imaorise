import type {
  DesktopBackgroundSettings,
  DesktopRuntimeRequestInput,
  EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { View } from "react-native";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ThemedSwitch } from "../../components/ThemedSwitch";

export function BackgroundServerControls({ environmentId }: { environmentId: EnvironmentId }) {
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
    <View className="gap-3">
      <AppText>
        WSL background server
        {settings
          ? ` · ${settings.distro} · ${settings.serverRunning ? "Running" : "Stopped or connecting"}`
          : ""}
      </AppText>
      <AppText className="text-sm text-foreground-muted">
        Stop interrupts this WSL environment's agents and tools.
      </AppText>
      <MaterialButton
        disabled={busy || !allowed}
        loading={busy}
        label={
          settings
            ? settings.serverRunning
              ? "Stop background server"
              : "Start background server"
            : "Manage background server"
        }
        onPress={() =>
          void act({ action: settings ? (settings.serverRunning ? "stop" : "start") : "get" })
        }
      />
      {settings ? (
        <View className="flex-row items-center justify-between gap-3">
          <AppText className="flex-1">Keep agents running when T3 closes</AppText>
          <ThemedSwitch
            accessibilityLabel="Keep agents running when T3 closes"
            value={settings.keepAgentsRunning}
            disabled={busy || !allowed}
            onValueChange={(keepAgentsRunning) =>
              void act({ action: "set", settings: { distro: settings.distro, keepAgentsRunning } })
            }
          />
        </View>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="text-danger">
          The desktop host could not complete this action. Check its connection and retry.
        </AppText>
      ) : null}
    </View>
  );
}
