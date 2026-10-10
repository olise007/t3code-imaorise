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
const apk = includeAndroid ? exactly((f) => f.endsWith(".apk"), "APK") : undefined;
if (!includeAndroid && files.some((f) => f.endsWith(".apk") || /^android-.*\.json$/.test(f)))
  throw new Error("Unexpected Android assets in a desktop-only release.");
const exe = exactly((f) => f.endsWith(".exe"), "NSIS installer");
const runtime = exactly((f) => f.endsWith("-linux-x64.tar.gz"), "matching Linux runtime");
if ((apk && !apk.includes(version)) || !runtime.includes(version))
  throw new Error("Artifacts do not match the release version.");
const metadata = `${channel === "beta" ? "beta" : "latest"}.yml`;
if (!files.includes(metadata)) throw new Error("Updater metadata is missing.");
const yml = NodeFS.readFileSync(NodePath.join(dir, metadata), "utf8");
if (!new RegExp(`^version: ['"]?${version.replaceAll(".", "\\.")}['"]?$`, "m").test(yml))
  throw new Error("Windows metadata version mismatch.");
const installerBytes = NodeFS.readFileSync(NodePath.join(dir, exe));
const sha512 = NodeCrypto.createHash("sha512").update(installerBytes).digest("base64");
if (!yml.includes(sha512) || !yml.includes(exe))
  throw new Error("Windows updater metadata does not match the installer.");
const distribution = [exe, runtime, metadata, ...files.filter((f) => f.endsWith(".blockmap"))];
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
    releaseNotes: `Personal ${channel} ${version}. Plan workflow and in-app updates. Windows installer is unsigned.`,
  };
  const manifestName = `android-${channel}.json`;
  NodeFS.writeFileSync(NodePath.join(dir, manifestName), JSON.stringify(manifest, null, 2) + "\n");
  distribution.push(apk, manifestName);
}
const evidence = {
  sourceRevision: revision,
  version,
  versionCode: code,
  channel,
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
if (!release.isDraft || JSON.parse(release.body.split("\n")[0]).sourceRevision !== revision)
  throw new Error("Release is not the reserved draft.");
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
    `--latest=${channel === "stable"}`,
  );
