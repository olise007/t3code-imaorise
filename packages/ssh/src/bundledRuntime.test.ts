// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  linuxInstallScript,
  remoteRuntimeInvocation,
  windowsInstallScript,
} from "./bundledRuntime.ts";

describe("bundled SSH runtime installation", () => {
  it.skipIf(process.platform === "win32")(
    "installs a verified Linux archive atomically and reuses it",
    () => {
      const home = mkdtempSync(join(tmpdir(), "t3-ssh-runtime-"));
      try {
        const payload = join(home, "payload", "runtime");
        mkdirSync(payload, { recursive: true });
        writeFileSync(join(payload, "t3"), "#!/bin/sh\nprintf '2.0.1-test\\n'\n", { mode: 0o700 });
        const archive = join(home, "runtime.tar.gz");
        expect(
          spawnSync("tar", ["-czf", archive, "-C", join(home, "payload"), "runtime"]).status,
        ).toBe(0);
        const bytes = readFileSync(archive);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const parent = join(home, ".t3-imaorise", "runtime");
        mkdirSync(parent, { recursive: true });
        writeFileSync(join(parent, `upload-${hash}.tar.gz`), bytes);
        const first = spawnSync("sh", ["-s"], {
          input: linuxInstallScript(hash),
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        });
        expect(first.stderr).toBe("");
        expect(first.status).toBe(0);
        expect(readFileSync(join(parent, `sha256-${hash}`, ".archive-sha256"), "utf8")).toBe(hash);
        expect(existsSync(join(parent, `upload-${hash}.tar.gz`))).toBe(false);
        expect(
          spawnSync("sh", ["-s"], {
            input: linuxInstallScript(hash),
            env: { ...process.env, HOME: home },
          }).status,
        ).toBe(0);
        const bad = "a".repeat(64);
        writeFileSync(join(parent, `upload-${bad}.tar.gz`), bytes);
        expect(
          spawnSync("sh", ["-s"], {
            input: linuxInstallScript(bad),
            env: { ...process.env, HOME: home },
          }).status,
        ).not.toBe(0);
        expect(existsSync(join(parent, `sha256-${bad}`))).toBe(false);
        expect(existsSync(join(parent, `sha256-${bad}.lock`))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects interpolated arguments on both remote shell paths", () => {
    const command = `a'b ; $(touch /tmp/should-not-exist)`;
    const windows = remoteRuntimeInvocation(
      { platform: "windows", relativeExecutable: ".t3-imaorise/runtime/t3.exe", version: "test" },
      [command],
    );
    expect(windows.remoteCommandArgs).toContain("-EncodedCommand");
    expect(windows.remoteCommandArgs.join(" ")).not.toContain(command);
    expect(windows.stdin).toContain("'a''b ; $(touch /tmp/should-not-exist)'");
    expect(windowsInstallScript("b".repeat(64))).toContain("Get-FileHash");
  });
});
