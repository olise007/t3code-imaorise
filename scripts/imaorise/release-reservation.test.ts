import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve("scripts/imaorise/release-reservation.mjs");
const revision = "c".repeat(40);
function reserve(rerun: boolean) {
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
    if (a[0] === 'api') for (const r of JSON.parse(fs.readFileSync('catalog.json'))) console.log(JSON.stringify(r));
    else fs.writeFileSync('created.json', a[a.indexOf('--notes') + 1].split('\\n')[0]);
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
      output: NodeFS.readFileSync(NodePath.join(root, "output"), "utf8"),
      created: NodeFS.existsSync(NodePath.join(root, "created.json"))
        ? JSON.parse(NodeFS.readFileSync(NodePath.join(root, "created.json"), "utf8"))
        : null,
      diffs: NodeFS.readFileSync(NodePath.join(root, "diffs.jsonl"), "utf8"),
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
