import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mock = vi.hoisted(() => ({
  fetch: vi.fn(),
  download: vi.fn(),
  verify: vi.fn(),
  install: vi.fn(),
  permission: vi.fn(),
  canInstall: vi.fn(),
  flushDrafts: vi.fn(),
  flushOutbox: vi.fn(),
  installedCode: vi.fn(),
  files: new Map<string, string>(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 35 },
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: vi.fn() },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "2.0.1-beta.1", android: { package: "com.imaorise.t3code" } } },
}));
vi.mock("expo", () => ({
  requireNativeModule: () => ({
    getInstalledPersonalVersionCode: mock.installedCode,
    verifyPersonalApk: mock.verify,
    installPersonalApk: mock.install,
    canInstallPersonalApk: mock.canInstall,
    openPersonalInstallPermission: mock.permission,
  }),
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///private/",
  cacheDirectory: "file:///cache/",
  readAsStringAsync: async (uri: string) => {
    if (!mock.files.has(uri)) throw new Error("Missing");
    return mock.files.get(uri);
  },
  writeAsStringAsync: async (uri: string, text: string) => {
    mock.files.set(uri, text);
  },
  deleteAsync: async (uri: string) => {
    mock.files.delete(uri);
  },
  createDownloadResumable: () => ({ downloadAsync: mock.download }),
}));
vi.mock("../../state/use-composer-drafts", () => ({ flushComposerDrafts: mock.flushDrafts }));
vi.mock("../../state/thread-outbox", () => ({ flushThreadOutbox: mock.flushOutbox }));
const manifest = {
  schemaVersion: 1,
  channel: "beta",
  version: "2.0.1-beta.2",
  versionCode: 5217,
  minimumAndroidVersion: 26,
  architecture: "arm64-v8a",
  packageId: "com.imaorise.t3code",
  apkUrl:
    "https://github.com/olise007/t3code-imaorise/releases/download/v2.0.1-beta.2/personal.apk",
  size: 100,
  sha256: "a".repeat(64),
  certificateFingerprint: "b".repeat(64),
  sourceRevision: "c".repeat(40),
  releaseNotes: "Test",
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.files.clear();
  mock.installedCode.mockReturnValue(5216);
  vi.stubGlobal("fetch", mock.fetch);
  mock.fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes("api.github.com")
        ? [
            {
              draft: false,
              prerelease: true,
              assets: [
                {
                  name: "android-beta.json",
                  browser_download_url:
                    "https://github.com/olise007/t3code-imaorise/releases/download/v2.0.1-beta.2/android-beta.json",
                },
              ],
            },
          ]
        : manifest,
  }));
  mock.download.mockResolvedValue({ status: 200 });
  mock.verify.mockResolvedValue(true);
  mock.canInstall.mockReturnValue(true);
  mock.install.mockResolvedValue(undefined);
  mock.flushDrafts.mockResolvedValue(undefined);
  mock.flushOutbox.mockResolvedValue(undefined);
});
describe("personal APK updates", () => {
  it("confirms installation after process replacement and bypasses the old check throttle", async () => {
    let service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate(true);
    await service.downloadPersonalApkUpdate();
    await service.installPersonalApkUpdate();
    const preferences = "file:///private/personal-updates.json";
    expect(JSON.parse(mock.files.get(preferences)!)).toMatchObject({
      pendingInstallVersionCode: 5217,
    });
    vi.resetModules();
    mock.installedCode.mockReturnValue(5217);
    service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate();
    expect(mock.fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(mock.files.get(preferences)!)).toMatchObject({
      pendingInstallVersionCode: null,
      lastInstalledVersionCode: 5217,
    });
    expect(mock.install).toHaveBeenCalledOnce();
  });
  it("recovers an unfinished installation after a cold restart without reinstalling automatically", async () => {
    mock.files.set(
      "file:///private/personal-updates.json",
      JSON.stringify({
        channel: "beta",
        lastCheck: Date.now(),
        lastInstalledVersionCode: 5216,
        pendingInstallVersionCode: 5217,
      }),
    );
    const service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate();
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    expect(mock.install).not.toHaveBeenCalled();
    expect(mock.download).not.toHaveBeenCalled();
  });
  it("throttles resume checks but lets manual checks bypass throttling", async () => {
    const service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate();
    await service.checkPersonalApkUpdate();
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    await service.checkPersonalApkUpdate(true);
    expect(mock.fetch).toHaveBeenCalledTimes(4);
    expect(mock.download).not.toHaveBeenCalled();
    expect(mock.install).not.toHaveBeenCalled();
  });
  it("flushes drafts and verifies again before opening the installer", async () => {
    const service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate(true);
    await service.downloadPersonalApkUpdate();
    await service.installPersonalApkUpdate();
    expect(mock.verify).toHaveBeenCalledTimes(2);
    expect(mock.install).toHaveBeenCalledOnce();
    expect(mock.flushDrafts.mock.invocationCallOrder[0]).toBeLessThan(
      mock.install.mock.invocationCallOrder[0]!,
    );
    expect(mock.flushOutbox.mock.invocationCallOrder[0]).toBeLessThan(
      mock.install.mock.invocationCallOrder[0]!,
    );
  });
  it.each(["APK checksum mismatch", "APK signing certificate mismatch", "APK package mismatch"])(
    "never installs a rejected download: %s",
    async (message) => {
      mock.verify.mockRejectedValue(new Error(message));
      const service = await import("./personal-apk-updates");
      await service.checkPersonalApkUpdate(true);
      await service.downloadPersonalApkUpdate();
      await service.installPersonalApkUpdate();
      expect(mock.install).not.toHaveBeenCalled();
    },
  );
  it("allows retry after an interrupted download", async () => {
    mock.download.mockResolvedValueOnce(undefined);
    const service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate(true);
    await service.downloadPersonalApkUpdate();
    await service.downloadPersonalApkUpdate();
    await service.installPersonalApkUpdate();
    expect(mock.download).toHaveBeenCalledTimes(2);
    expect(mock.install).toHaveBeenCalledOnce();
  });
  it("opens per-app permission settings without handing off an installer", async () => {
    mock.canInstall.mockReturnValue(false);
    const service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate(true);
    await service.downloadPersonalApkUpdate();
    await service.installPersonalApkUpdate();
    expect(mock.permission).toHaveBeenCalledOnce();
    expect(mock.install).not.toHaveBeenCalled();
  });
  it("does not install when draft persistence fails", async () => {
    mock.flushDrafts.mockRejectedValue(new Error("Disk full"));
    const service = await import("./personal-apk-updates");
    await service.checkPersonalApkUpdate(true);
    await service.downloadPersonalApkUpdate();
    await service.installPersonalApkUpdate();
    expect(mock.install).not.toHaveBeenCalled();
  });
  it("prevents channel-switch downgrades", async () => {
    mock.fetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("api.github.com")
          ? [
              {
                draft: false,
                prerelease: false,
                assets: [
                  {
                    name: "android-stable.json",
                    browser_download_url:
                      "https://github.com/olise007/t3code-imaorise/releases/download/v2.0.1/android-stable.json",
                  },
                ],
              },
            ]
          : { ...manifest, channel: "stable", version: "2.0.1", versionCode: 5216 },
    }));
    const service = await import("./personal-apk-updates");
    await service.setPersonalApkChannel("stable");
    await service.downloadPersonalApkUpdate();
    await service.installPersonalApkUpdate();
    expect(mock.download).not.toHaveBeenCalled();
    expect(mock.install).not.toHaveBeenCalled();
  });
});
