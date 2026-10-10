export interface PersonalApkManifest {
  readonly schemaVersion: 1;
  readonly channel: "stable" | "beta";
  readonly version: string;
  readonly versionCode: number;
  readonly minimumAndroidVersion: number;
  readonly architecture: "arm64-v8a";
  readonly packageId: "com.imaorise.t3code";
  readonly apkUrl: string;
  readonly size: number;
  readonly sha256: string;
  readonly certificateFingerprint: string;
  readonly sourceRevision: string;
  readonly releaseNotes: string;
}
export function validatePersonalApkManifest(
  value: unknown,
  channel: "stable" | "beta",
): PersonalApkManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid update manifest.");
  const m = value as Partial<PersonalApkManifest>;
  if (
    m.schemaVersion !== 1 ||
    m.channel !== channel ||
    m.architecture !== "arm64-v8a" ||
    m.packageId !== "com.imaorise.t3code" ||
    typeof m.version !== "string" ||
    !/^2\.\d+\.\d+(?:-beta\.\d+)?$/.test(m.version) ||
    (channel === "beta") !== m.version.includes("-beta.") ||
    !Number.isSafeInteger(m.versionCode) ||
    (m.versionCode ?? 0) <= 5215 ||
    !Number.isSafeInteger(m.minimumAndroidVersion) ||
    (m.minimumAndroidVersion ?? 0) < 1 ||
    !Number.isSafeInteger(m.size) ||
    (m.size ?? 0) <= 0 ||
    (m.size ?? 0) > 500_000_000 ||
    typeof m.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(m.sha256) ||
    typeof m.certificateFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/i.test(m.certificateFingerprint) ||
    typeof m.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/i.test(m.sourceRevision) ||
    typeof m.releaseNotes !== "string" ||
    typeof m.apkUrl !== "string" ||
    !m.apkUrl.startsWith("https://github.com/olise007/t3code-imaorise/releases/download/")
  )
    throw new Error("The personal update manifest failed validation.");
  return m as PersonalApkManifest;
}
