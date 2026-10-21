import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Alert, AppState, Linking } from "react-native";
import { AppText } from "../../components/AppText";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  openDirectBatterySettings,
  refreshDirectAlerts,
  setDirectAlertSelection,
  supportsDirectAlerts,
  useDirectAlerts,
} from "../agent-awareness/directAlerts";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";

function DirectEnvironmentRow({
  environment,
  supported,
  onChange,
}: {
  environment: ReturnType<typeof useWorkspaceEnvironments>[number];
  supported: boolean;
  onChange: (enabled: boolean, ids: string[]) => Promise<void>;
}) {
  const state = useDirectAlerts();
  const id = environment.environmentId;
  const permitted = useEnvironmentScope(id, AuthOrchestrationReadScope);
  const selected = state.selectedIds.includes(id);
  return (
    <SettingsSwitchRow
      icon="wifi"
      label={environment.environmentLabel}
      value={selected}
      disabled={
        !supportsDirectAlerts || (!selected && (!supported || !permitted || !environment.isEnabled))
      }
      subtitle={
        !supported
          ? "Connect to an updated environment to enable alerts"
          : !permitted
            ? "Orchestration read permission required"
            : (state.statuses[id] ?? "Ready")
      }
      onValueChange={(value) => {
        const ids = value
          ? [...state.selectedIds, id]
          : state.selectedIds.filter((item) => item !== id);
        void onChange(state.enabled && ids.length > 0, ids);
      }}
    />
  );
}

export function DirectAlertsSettings() {
  const state = useDirectAlerts();
  const environments = useWorkspaceEnvironments();
  const configs = useAtomValue(environmentServerConfigsAtom);
  useEffect(() => {
    refreshDirectAlerts();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") refreshDirectAlerts();
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  const change = async (enabled: boolean, ids = state.selectedIds) => {
    try {
      if (enabled) {
        const permission = await Notifications.requestPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("Notifications disabled", "Allow notifications in Android settings first.");
          return;
        }
      }
      setDirectAlertSelection(enabled, ids);
    } catch (error) {
      Alert.alert(
        "Background alerts",
        error instanceof Error ? error.message : "Could not change background alerts.",
      );
    }
  };
  return (
    <SettingsSection title="Direct connection alerts">
      <SettingsSwitchRow
        icon="bell.badge"
        label="Background alerts over direct connections"
        value={state.enabled}
        disabled={!supportsDirectAlerts || (!state.enabled && state.selectedIds.length === 0)}
        subtitle={
          supportsDirectAlerts
            ? (state.statuses.setup ??
              (state.running ? "Listener running" : "Select an environment, then enable alerts"))
            : "Install a newer Android build to enable this feature"
        }
        onValueChange={(value) => {
          void change(value);
        }}
      />
      {environments
        .filter((environment) => !environment.isRelayManaged)
        .map((environment) => (
          <DirectEnvironmentRow
            key={environment.environmentId}
            environment={environment}
            supported={
              configs.get(environment.environmentId)?.environment.capabilities
                .directAgentActivity === true
            }
            onChange={change}
          />
        ))}
      <SettingsRow
        icon="bell.badge"
        label="Android notification settings"
        onPress={() => {
          void Linking.openSettings();
        }}
      />
      <SettingsRow
        icon="gearshape"
        label="Battery and background settings"
        onPress={openDirectBatterySettings}
      />
      <AppText className="px-4 py-3 text-sm text-foreground-muted">
        Keep Tailscale connected. Android battery restrictions can delay alerts. A persistent
        notification shows listening status. After reboot or force-stop, reopen T3 to resume.
      </AppText>
    </SettingsSection>
  );
}
