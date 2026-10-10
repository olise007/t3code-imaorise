import { useEffect, useSyncExternalStore } from "react";
import { Alert, AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import { requireNativeModule } from "expo";
import { validatePersonalApkManifest, type PersonalApkManifest } from "./personal-apk-manifest";
import { flushComposerDrafts } from "../../state/use-composer-drafts";
import { flushThreadOutbox } from "../../state/thread-outbox";

type Channel = "stable" | "beta";
interface NativeUpdater {
  getInstalledPersonalVersionCode(): number;
  verifyPersonalApk(
    uri: string,
    sha: string,
    code: number,
    certificate: string,
    size: number,
  ): Promise<boolean>;
  canInstallPersonalApk(): boolean;
  openPersonalInstallPermission(): Promise<void>;
  installPersonalApk(uri: string): Promise<void>;
}
interface UpdateState {
  channel: Channel;
  status:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  manifest: PersonalApkManifest | null;
  progress: number;
  error: string | null;
}
export const personalApkUpdatesEnabled =
  Platform.OS === "android" && Constants.expoConfig?.android?.package === "com.imaorise.t3code";
const defaultChannel: Channel = (Constants.expoConfig?.version ?? "").includes("-beta.")
  ? "beta"
  : "stable";
let state: UpdateState = {
  channel: defaultChannel,
  status: "idle",
  manifest: null,
  progress: 0,
  error: null,
};
let lastCheck = 0;
let busy = false;
let readyUri: string | null = null;
let loaded: Promise<void> | null = null;
let lastInstalledVersionCode = 0;
let pendingInstallVersionCode: number | null = null;
const listeners = new Set<() => void>();
const preferencesUri = `${FileSystem.documentDirectory}personal-updates.json`;
const installedCode = () => bridge().getInstalledPersonalVersionCode();
const bridge = () => requireNativeModule<NativeUpdater>("T3NativeControls");
function update(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
async function persist() {
  await FileSystem.writeAsStringAsync(
    preferencesUri,
    JSON.stringify({
      channel: state.channel,
      lastCheck,
      lastInstalledVersionCode,
      pendingInstallVersionCode,
    }),
  );
}
async function load() {
  loaded ??= (async () => {
    try {
      const stored: unknown = JSON.parse(await FileSystem.readAsStringAsync(preferencesUri));
      if (
        stored &&
        typeof stored === "object" &&
        "channel" in stored &&
        (stored.channel === "stable" || stored.channel === "beta")
      ) {
        update({ channel: stored.channel });
        if ("lastCheck" in stored && typeof stored.lastCheck === "number")
          lastCheck = stored.lastCheck;
        if (
          "lastInstalledVersionCode" in stored &&
          typeof stored.lastInstalledVersionCode === "number"
        )
          lastInstalledVersionCode = stored.lastInstalledVersionCode;
        if (
          "pendingInstallVersionCode" in stored &&
          typeof stored.pendingInstallVersionCode === "number"
        )
          pendingInstallVersionCode = stored.pendingInstallVersionCode;
      }
    } catch {
      /* First launch has no preferences. */
    }
    const actualVersionCode = installedCode();
    if (actualVersionCode !== lastInstalledVersionCode) lastCheck = 0;
    lastInstalledVersionCode = actualVersionCode;
    if (pendingInstallVersionCode !== null) {
      if (actualVersionCode >= pendingInstallVersionCode)
        update({ status: "current", manifest: null, error: null });
      else
        Alert.alert(
          "Update not installed",
          "The previous installation did not complete. Check for updates and retry when ready.",
        );
      pendingInstallVersionCode = null;
      lastCheck = 0;
      await persist();
    }
  })();
  await loaded;
}
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
export async function checkPersonalApkUpdate(manual = false) {
  if (!personalApkUpdatesEnabled || busy) return;
  await load();
  if (busy || (!manual && Date.now() - lastCheck < 6 * 60 * 60 * 1000)) return;
  busy = true;
  update({ status: "checking", error: null });
  try {
    lastCheck = Date.now();
    await persist();
    const releases = await fetchJson(
      "https://api.github.com/repos/olise007/t3code-imaorise/releases?per_page=100",
    );
    if (!Array.isArray(releases)) throw new Error("Invalid releases response.");
    const assetName = `android-${state.channel}.json`;
    const release = releases.find(
      (r: {
        draft?: boolean;
        prerelease?: boolean;
        assets?: { name: string; browser_download_url: string }[];
      }) =>
        !r.draft &&
        Boolean(r.prerelease) === (state.channel === "beta") &&
        r.assets?.some((asset) => asset.name === assetName),
    );
    const asset = release?.assets?.find((a: { name: string }) => a.name === assetName);
    if (
      !asset ||
      !asset.browser_download_url.startsWith(
        "https://github.com/olise007/t3code-imaorise/releases/download/",
      )
    ) {
      update({ status: "current", manifest: null });
      return;
    }
    const manifest = validatePersonalApkManifest(
      await fetchJson(asset.browser_download_url),
      state.channel,
    );
    if (manifest.versionCode <= installedCode()) {
      update({ status: "current", manifest: null });
      return;
    }
    if (Platform.OS === "android" && Number(Platform.Version) < manifest.minimumAndroidVersion)
      throw new Error("This update requires a newer Android version.");
    update({ status: "available", manifest });
    if (!manual)
      Alert.alert(
        "Personal update available",
        `${manifest.version} is available. Open Settings → About to download and install it.`,
      );
  } catch (error) {
    update({
      status: "error",
      error: error instanceof Error ? error.message : "Update check failed.",
    });
  } finally {
    busy = false;
  }
}
export async function setPersonalApkChannel(channel: Channel) {
  if (busy) return;
  await load();
  if (readyUri) await FileSystem.deleteAsync(readyUri, { idempotent: true });
  readyUri = null;
  update({ channel, status: "idle", manifest: null, progress: 0, error: null });
  lastCheck = 0;
  await persist();
  await checkPersonalApkUpdate(true);
}
export async function downloadPersonalApkUpdate() {
  const manifest = state.manifest;
  if (!manifest || busy || manifest.versionCode <= installedCode()) return;
  busy = true;
  const uri = `${FileSystem.cacheDirectory}personal-update-${manifest.versionCode}.apk`;
  update({ status: "downloading", progress: 0, error: null });
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    const download = FileSystem.createDownloadResumable(manifest.apkUrl, uri, {}, (progress) =>
      update({ progress: Math.min(1, progress.totalBytesWritten / manifest.size) }),
    );
    const result = await download.downloadAsync();
    if (!result || result.status !== 200)
      throw new Error("The APK download was interrupted. Retry the download.");
    await bridge().verifyPersonalApk(
      uri,
      manifest.sha256,
      manifest.versionCode,
      manifest.certificateFingerprint,
      manifest.size,
    );
    readyUri = uri;
    update({ status: "ready", progress: 1 });
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    readyUri = null;
    update({ status: "error", error: error instanceof Error ? error.message : "Download failed." });
  } finally {
    busy = false;
  }
}
export async function installPersonalApkUpdate() {
  const manifest = state.manifest;
  if (!readyUri || !manifest || busy) return;
  busy = true;
  try {
    if (!bridge().canInstallPersonalApk()) {
      Alert.alert(
        "Allow app updates",
        "Enable ‘Allow from this source’ for T3 Code Imaorise, then return and tap Install again.",
      );
      await bridge().openPersonalInstallPermission();
      return;
    }
    await Promise.all([flushComposerDrafts(), flushThreadOutbox()]);
    await bridge().verifyPersonalApk(
      readyUri,
      manifest.sha256,
      manifest.versionCode,
      manifest.certificateFingerprint,
      manifest.size,
    );
    pendingInstallVersionCode = manifest.versionCode;
    await persist();
    update({ status: "installing" });
    await bridge().installPersonalApk(readyUri);
  } catch (error) {
    update({ status: "error", error: error instanceof Error ? error.message : "Install failed." });
  } finally {
    busy = false;
  }
}
export function usePersonalApkUpdates() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}
export function usePersonalApkUpdateLifecycle() {
  useEffect(() => {
    if (!personalApkUpdatesEnabled) return;
    void checkPersonalApkUpdate();
    const subscription = AppState.addEventListener("change", (value) => {
      if (value !== "active") return;
      if (state.status === "installing") {
        if (state.manifest && installedCode() >= state.manifest.versionCode)
          update({ status: "current", manifest: null });
        else
          update({
            status: "ready",
            error: "Installation was cancelled or did not complete. You can retry.",
          });
        pendingInstallVersionCode = null;
        lastInstalledVersionCode = installedCode();
        void persist().catch(() => {});
      }
      void checkPersonalApkUpdate();
    });
    return () => subscription.remove();
  }, []);
}
