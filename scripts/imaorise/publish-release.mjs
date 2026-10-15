import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const repo = "olise007/t3code-imaorise";
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== "refs/heads/imaorise")
  throw new Error("Publication is restricted to the personal branch.");
const {
  RELEASE_TAG: tag,
  RELEASE_VERSION: version,
  RELEASE_CHANNEL: channel,
  SOURCE_REVISION: revision,
} = process.env;
const code = Number(process.env.VERSION_CODE);
if (
  !/^v2\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag) ||
  tag !== `v${version}` ||
  !/^[a-f0-9]{40}$/.test(revision) ||
  !Number.isInteger(code) ||
  !["beta", "stable"].includes(channel) ||
  code <= 5215
)
  throw new Error("Invalid release reservation.");
const dir = "release-assets";
const files = NodeFS.readdirSync(dir);
const exactly = (predicate, label) => {
  const matches = files.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}.`);
  return matches[0];
};
const includeAndroid = process.env.INCLUDE_ANDROID !== "false";
const includeDesktop = process.env.INCLUDE_DESKTOP !== "false";
const apk = includeAndroid ? exactly((f) => f.endsWith(".apk"), "APK") : undefined;
if (!includeAndroid && files.some((f) => f.endsWith(".apk") || /^android-.*\.json$/.test(f)))
  throw new Error("Unexpected Android assets in a desktop-only release.");
const distribution = [];
if (
  !includeDesktop &&
  files.some(
    (f) =>
      /\.(exe|yml|blockmap)$/.test(f) ||
      f.endsWith("-linux-x64.tar.gz") ||
      f.endsWith("-win32-x64.zip"),
  )
)
  throw new Error("Unexpected desktop assets in an Android-only release.");
if (includeDesktop) {
  const exe = exactly((f) => f.endsWith(".exe"), "NSIS installer");
  const runtime = exactly((f) => f.endsWith("-linux-x64.tar.gz"), "matching Linux runtime");
  if (!runtime.includes(version)) throw new Error("Artifacts do not match the release version.");
  const windowsRuntime = files.filter((f) => f.endsWith("-win32-x64.zip"));
  if (process.env.INCLUDE_WINDOWS_SSH_RUNTIME === "true" && windowsRuntime.length !== 1)
    throw new Error("Matching Windows SSH runtime is missing.");
  if (windowsRuntime.length > 1 || windowsRuntime.some((f) => f !== `t3-${version}-win32-x64.zip`))
    throw new Error("Windows SSH runtime version mismatch.");
  const metadata = `${channel === "beta" ? "beta" : "latest"}.yml`;
  if (!files.includes(metadata)) throw new Error("Updater metadata is missing.");
  const yml = NodeFS.readFileSync(NodePath.join(dir, metadata), "utf8");
  if (!new RegExp(`^version: ['"]?${version.replaceAll(".", "\\.")}['"]?$`, "m").test(yml))
    throw new Error("Windows metadata version mismatch.");
  const installerBytes = NodeFS.readFileSync(NodePath.join(dir, exe));
  const sha512 = NodeCrypto.createHash("sha512").update(installerBytes).digest("base64");
  if (!yml.includes(sha512) || !yml.includes(exe))
    throw new Error("Windows updater metadata does not match the installer.");
  distribution.push(
    exe,
    runtime,
    ...windowsRuntime,
    metadata,
    ...files.filter((f) => f.endsWith(".blockmap")),
  );
}
if (apk && !apk.includes(version)) throw new Error("APK version mismatch.");
if (!includeAndroid && !includeDesktop) throw new Error("No release targets selected.");
if (includeAndroid) {
  const signature = NodeFS.readFileSync(NodePath.join(dir, "signature.txt"), "utf8");
  const certificate = signature
    .match(/certificate SHA-256 digest:\s*([a-f0-9]{64})/i)?.[1]
    ?.toLowerCase();
  const badging = NodeFS.readFileSync(NodePath.join(dir, "package.txt"), "utf8");
  if (
    !certificate ||
    !badging.includes("package: name='com.imaorise.t3code'") ||
    !badging.includes(`versionCode='${code}'`) ||
    !badging.includes(`versionName='${version}'`) ||
    !badging.includes("native-code: 'arm64-v8a'")
  )
    throw new Error("APK evidence failed verification.");
  const minimum = Number(badging.match(/sdkVersion:'(\d+)'/)?.[1]);
  if (!minimum) throw new Error("APK minimum Android version is missing.");
  const build = JSON.parse(
    NodeFS.readFileSync(NodePath.join(dir, "android-manifest.json"), "utf8"),
  );
  if (
    build.revision !== revision ||
    build.versionCode !== code ||
    build.applicationId !== "com.imaorise.t3code"
  )
    throw new Error("Android build evidence does not match the reservation.");
  const bytes = NodeFS.readFileSync(NodePath.join(dir, apk));
  const manifest = {
    schemaVersion: 1,
    channel,
    version,
    versionCode: code,
    minimumAndroidVersion: minimum,
    architecture: "arm64-v8a",
    packageId: "com.imaorise.t3code",
    apkUrl: `https://github.com/${repo}/releases/download/${tag}/${apk}`,
    size: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    certificateFingerprint: certificate,
    sourceRevision: revision,
    releaseNotes: `Personal Android ${channel} ${version}.`,
  };
  const manifestName = `android-${channel}.json`;
  NodeFS.writeFileSync(NodePath.join(dir, manifestName), JSON.stringify(manifest, null, 2) + "\n");
  distribution.push(
    apk,
    manifestName,
    "android-manifest.json",
    "signature.txt",
    "package.txt",
    "native-manifest.txt",
  );
}
const evidence = {
  sourceRevision: revision,
  version,
  versionCode: code,
  channel,
  targets: { android: includeAndroid, desktop: includeDesktop },
  assets: distribution.map((name) => {
    const data = NodeFS.readFileSync(NodePath.join(dir, name));
    return {
      name,
      size: data.length,
      sha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
    };
  }),
};
NodeFS.writeFileSync(
  NodePath.join(dir, "BUILD-MANIFEST.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
NodeFS.writeFileSync(
  NodePath.join(dir, "SHA256SUMS"),
  evidence.assets.map((a) => `${a.sha256}  ${a.name}`).join("\n") + "\n",
);
const gh = (...args) =>
  NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
const release = JSON.parse(gh("release", "view", tag, "--repo", repo, "--json", "isDraft,body"));
const reservation = JSON.parse(release.body.split("\n")[0]);
if (!release.isDraft || reservation.sourceRevision !== revision || reservation.versionCode !== code)
  throw new Error("Release is not the reserved draft.");
if (
  reservation.targets &&
  (reservation.targets.android !== includeAndroid || reservation.targets.desktop !== includeDesktop)
)
  throw new Error("Publication surfaces do not match the reserved release targets.");
gh(
  "release",
  "upload",
  tag,
  "--repo",
  repo,
  "--clobber",
  ...distribution.map((f) => NodePath.join(dir, f)),
  NodePath.join(dir, "BUILD-MANIFEST.json"),
  NodePath.join(dir, "SHA256SUMS"),
);
const assets = JSON.parse(gh("release", "view", tag, "--repo", repo, "--json", "assets")).assets;
for (const name of [...distribution, "BUILD-MANIFEST.json", "SHA256SUMS"])
  if (
    !assets.some(
      (a) => a.name === name && a.size === NodeFS.statSync(NodePath.join(dir, name)).size,
    )
  )
    throw new Error(`Draft is missing or has truncated asset ${name}.`);
if (process.env.PUBLISH_RELEASE === "true")
  gh(
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--draft=false",
    `--prerelease=${channel === "beta"}`,
    `--latest=${channel === "stable" && includeDesktop}`,
  );
