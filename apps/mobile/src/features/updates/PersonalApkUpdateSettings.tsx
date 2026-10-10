import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  checkPersonalApkUpdate,
  downloadPersonalApkUpdate,
  installPersonalApkUpdate,
  personalApkUpdatesEnabled,
  setPersonalApkChannel,
  usePersonalApkUpdates,
} from "./personal-apk-updates";
export function PersonalApkUpdateSettings() {
  const state = usePersonalApkUpdates();
  if (!personalApkUpdatesEnabled) return null;
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  return (
    <SettingsSection title="Personal app updates">
      <View className="gap-3 p-4">
        <View className="flex-row gap-4">
          {(["stable", "beta"] as const).map((channel) => (
            <Pressable
              key={channel}
              accessibilityRole="button"
              accessibilityState={{ selected: state.channel === channel }}
              disabled={busy}
              onPress={() => void setPersonalApkChannel(channel)}
            >
              <Text
                className={state.channel === channel ? "text-primary" : "text-foreground-muted"}
              >
                {channel === "stable" ? "Stable" : "Beta"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text>
          {state.status === "downloading"
            ? `Downloading ${Math.round(state.progress * 100)}%`
            : state.status === "current"
              ? "Up to date"
              : state.status}
        </Text>
        {state.manifest ? (
          <>
            <Text className="font-t3-bold">{state.manifest.version}</Text>
            <Text>{state.manifest.releaseNotes}</Text>
          </>
        ) : null}
        {state.error ? <Text accessibilityRole="alert">{state.error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void checkPersonalApkUpdate(true)}
        >
          <Text className="text-primary">Check for updates</Text>
        </Pressable>
        {state.manifest && state.status !== "ready" && state.status !== "installing" ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void downloadPersonalApkUpdate()}
          >
            <Text className="text-primary">
              {state.status === "error" ? "Retry download" : "Download"}
            </Text>
          </Pressable>
        ) : null}
        {state.status === "ready" ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void installPersonalApkUpdate()}
          >
            <Text className="text-primary">Install</Text>
          </Pressable>
        ) : null}
        <Text className="text-foreground-muted">
          Android confirms installation. Your personal profiles and drafts are preserved.
        </Text>
      </View>
    </SettingsSection>
  );
}
