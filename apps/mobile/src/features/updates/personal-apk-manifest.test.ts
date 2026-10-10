import { describe, expect, it } from "vite-plus/test";
import { validatePersonalApkManifest } from "./personal-apk-manifest";
const manifest = {
  schemaVersion: 1,
  channel: "beta",
  version: "2.0.1-beta.1",
  versionCode: 5216,
  minimumAndroidVersion: 26,
  architecture: "arm64-v8a",
  packageId: "com.imaorise.t3code",
  apkUrl:
    "https://github.com/olise007/t3code-imaorise/releases/download/v2.0.1-beta.1/personal.apk",
  size: 100,
  sha256: "a".repeat(64),
  certificateFingerprint: "b".repeat(64),
  sourceRevision: "c".repeat(40),
  releaseNotes: "Test",
};
describe("personal APK manifest", () => {
  it("accepts a complete personal beta", () =>
    expect(validatePersonalApkManifest(manifest, "beta")).toEqual(manifest));
  it.each([
    { packageId: "com.t3tools" },
    { architecture: "x86" },
    { versionCode: 5215 },
    { versionCode: 5216.1 },
    { sha256: "bad" },
    { certificateFingerprint: "bad" },
    { sourceRevision: "main" },
    { apkUrl: "https://evil.test/personal.apk" },
    { channel: "stable" },
    { size: 600_000_000 },
  ])("rejects mismatched release metadata %j", (patch) =>
    expect(() => validatePersonalApkManifest({ ...manifest, ...patch }, "beta")).toThrow(),
  );
});
