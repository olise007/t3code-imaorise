import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve("scripts/imaorise/publish-release.mjs");
function publication(android: boolean, desktop: boolean, corrupt?: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-publish-test-"));
  const assets = NodePath.join(root, "release-assets");
  NodeFS.mkdirSync(assets);
  const version = "2.0.1-beta.7";
  const revision = "a".repeat(40);
  const write = (name: string, value: string) =>
    NodeFS.writeFileSync(NodePath.join(assets, name), value);
  if (desktop) {
    write(`app-${version}.exe`, "installer");
    write(`t3-${version}-linux-x64.tar.gz`, "runtime");
    write(
      "beta.yml",
      `version: ${version}\npath: app-${version}.exe\nsha512: ${NodeCrypto.createHash("sha512").update("installer").digest("base64")}\n`,
    );
  }
  if (android) {
    write(`app-${version}.apk`, "apk");
    write("signature.txt", `certificate SHA-256 digest: ${"b".repeat(64)}`);
    write(
      "package.txt",
      `package: name='com.imaorise.t3code' versionCode='5220' versionName='${version}'\nnative-code: 'arm64-v8a'\nsdkVersion:'26'`,
    );
    write(
      "android-manifest.json",
      JSON.stringify({ revision, versionCode: 5220, applicationId: "com.imaorise.t3code" }),
    );
    write("native-manifest.txt", "manifest evidence");
  }
  if (corrupt === "signature") write("signature.txt", "invalid certificate");
  if (corrupt === "version") write("package.txt", "versionCode='5215'");
  if (corrupt === "unexpected") write("unexpected.exe", "unexpected");
  // The subprocess can only reach this fake GitHub CLI; tests never publish.
  NodeFS.writeFileSync(
    NodePath.join(root, "gh"),
    `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('isDraft,body')) console.log(JSON.stringify({isDraft: true, body: JSON.stringify({ sourceRevision: '${revision}', versionCode: 5220 })}));
    else if (args.includes('assets')) console.log(JSON.stringify({assets: fs.readdirSync('release-assets').map(name => ({name, size: fs.statSync('release-assets/' + name).size}))}));
  `,
    { mode: 0o700 },
  );
  try {
    const result = NodeChildProcess.spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "olise007/t3code-imaorise",
        GITHUB_REF: "refs/heads/imaorise",
        RELEASE_TAG: `v${version}`,
        RELEASE_VERSION: version,
        RELEASE_CHANNEL: "beta",
        SOURCE_REVISION: revision,
        VERSION_CODE: "5220",
        INCLUDE_ANDROID: String(android),
        INCLUDE_DESKTOP: String(desktop),
        PUBLISH_RELEASE: "false",
      },
    });
    const manifest =
      result.status === 0
        ? JSON.parse(NodeFS.readFileSync(NodePath.join(assets, "BUILD-MANIFEST.json"), "utf8"))
        : null;
    return { result, manifest };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("partial publication", () => {
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])("accepts Android=%s Desktop=%s with matching evidence", (android, desktop) => {
    const { result, manifest } = publication(android, desktop);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(manifest.targets).toEqual({ android, desktop });
    expect(manifest.assets.some((asset: { name: string }) => asset.name.endsWith(".exe"))).toBe(
      desktop,
    );
    expect(manifest.assets.some((asset: { name: string }) => asset.name.endsWith(".apk"))).toBe(
      android,
    );
  });
  it.each(["signature", "version", "unexpected"])(
    "rejects %s failures before upload",
    (corrupt) => {
      expect(publication(true, false, corrupt).result.status).not.toBe(0);
    },
  );
});
