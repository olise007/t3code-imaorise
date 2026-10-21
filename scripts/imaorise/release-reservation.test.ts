import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve("scripts/imaorise/release-reservation.mjs");
const revision = "c".repeat(40);
function reserve(
  rerun: boolean,
  options: {
    prose?: boolean;
    invalidIdentity?: boolean;
    unavailable?: boolean;
    oversized?: boolean;
  } = {},
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-reserve-test-"));
  const release = (surface: "android" | "desktop", source: string) => ({
    tag_name: surface === "android" ? "v2.0.1-beta.6" : "v2.0.1-beta.7",
    draft: false,
    prerelease: true,
    body: JSON.stringify({ sourceRevision: source, versionCode: 5220 }),
    assets: [
      "BUILD-MANIFEST.json",
      "SHA256SUMS",
      ...(surface === "android"
        ? ["android-beta.json", "app.apk"]
        : ["beta.yml", "app.exe", "t3-linux-x64.tar.gz"]),
    ].map((name) => ({ name, size: 10 })),
  });
  const releases = [release("desktop", "b".repeat(40)), release("android", "a".repeat(40))];
  const manifests: Record<string, string> = {};
  for (const [index, entry] of releases.entries()) {
    const id = index + 1;
    const manifest = JSON.stringify({
      sourceRevision: index === 0 ? "b".repeat(40) : "a".repeat(40),
      version: options.invalidIdentity ? "wrong-version" : entry.tag_name.slice(1),
      versionCode: options.prose && index === 1 ? 5271 : 5220,
    });
    manifests[String(id)] = manifest;
    const asset = entry.assets.find((asset) => asset.name === "BUILD-MANIFEST.json")!;
    Object.assign(asset, {
      id,
      size: options.oversized ? 262145 : NodeBuffer.Buffer.byteLength(manifest),
      digest: "sha256:" + NodeCrypto.createHash("sha256").update(manifest).digest("hex"),
    });
    if (options.prose && index === 1) entry.body = "Human-readable published release notes";
  }
  NodeFS.writeFileSync(NodePath.join(root, "manifests.json"), JSON.stringify(manifests));
  if (rerun)
    releases.unshift({
      tag_name: "v2.0.1-beta.9",
      draft: true,
      prerelease: true,
      assets: [],
      body: JSON.stringify({
        sourceRevision: revision,
        runId: "test-run",
        versionCode: 5221,
        targets: { android: true, desktop: false },
      }),
    });
  NodeFS.writeFileSync(NodePath.join(root, "catalog.json"), JSON.stringify(releases));
  NodeFS.writeFileSync(
    NodePath.join(root, "gh"),
    `#!/usr/bin/env node
    const fs = require('node:fs'); const a = process.argv.slice(2);
    if (a[0] === 'api') {
      const assetPath = a.find((part) => part.includes('/releases/assets/'));
      if (assetPath) {
        if (${Boolean(options.unavailable)}) { console.error('Metadata unavailable'); process.exit(1); }
        process.stdout.write(JSON.parse(fs.readFileSync('manifests.json'))[assetPath.split('/').at(-1)]);
      } else for (const r of JSON.parse(fs.readFileSync('catalog.json'))) console.log(JSON.stringify(r));
    } else fs.writeFileSync('created.json', a[a.indexOf('--notes') + 1].split('\\n')[0]);
  `,
    { mode: 0o700 },
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "git"),
    `#!/usr/bin/env node
    const fs = require('node:fs'); const a = process.argv.slice(2);
    fs.appendFileSync('diffs.jsonl', JSON.stringify(a) + '\\n');
    if (a.includes('${"a".repeat(40)}')) process.stdout.write('apps/mobile/src/example.ts\\0');
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
        GITHUB_OUTPUT: NodePath.join(root, "output"),
        GITHUB_REPOSITORY: "olise007/t3code-imaorise",
        GITHUB_REF: "refs/heads/imaorise",
        GITHUB_SHA: revision,
        GITHUB_RUN_ID: "test-run",
        GITHUB_RUN_NUMBER: "9",
        RELEASE_CHANNEL: "beta",
        RELEASE_TARGET: "auto",
      },
    });
    return {
      status: result.status,
      error: result.stderr,
      output: NodeFS.existsSync(NodePath.join(root, "output"))
        ? NodeFS.readFileSync(NodePath.join(root, "output"), "utf8")
        : "",
      created: NodeFS.existsSync(NodePath.join(root, "created.json"))
        ? JSON.parse(NodeFS.readFileSync(NodePath.join(root, "created.json"), "utf8"))
        : null,
      diffs: NodeFS.existsSync(NodePath.join(root, "diffs.jsonl"))
        ? NodeFS.readFileSync(NodePath.join(root, "diffs.jsonl"), "utf8")
        : "",
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
describe("release reservation", () => {
  it("compares each surface to its own published source and selects only mobile changes", () => {
    const result = reserve(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe("");
    expect(result.output).toContain("android=true\ndesktop=false\n");
    expect(result.created.versionCode).toBe(5221);
    expect(result.created.targets).toEqual({ android: true, desktop: false });
    expect(result.diffs).toContain("a".repeat(40));
    expect(result.diffs).toContain("b".repeat(40));
  });
  it("reuses the reserved targets and version code without another draft", () => {
    const result = reserve(true);
    expect(result.status).toBe(0);
    expect(result.output).toContain("version_code=5221");
    expect(result.created).toBeNull();
  });
});

it("reserves above shipped artifact codes when publication replaced reservation notes", () => {
  const result = reserve(false, { prose: true });
  expect(result.status).toBe(0);
  expect(result.created.versionCode).toBe(5272);
  expect(result.diffs).toContain("a".repeat(40));
});
it("rejects rerunning a stale lower-code reservation after a higher artifact shipped", () => {
  const result = reserve(true, { prose: true });
  expect(result.status).not.toBe(0);
  expect(result.error).toContain("A newer release has already shipped");
  expect(result.created).toBeNull();
});
it.each([{ invalidIdentity: true }, { unavailable: true }, { oversized: true }])(
  "fails closed when artifact metadata cannot be trusted: %j",
  (options) => {
    const result = reserve(false, options);
    expect(result.status).not.toBe(0);
    expect(result.created).toBeNull();
  },
);
