// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  linuxInstallScript,
  remoteRuntimeInvocation,
  windowsInstallScript,
  powershellArgs,
} from "./bundledRuntime.ts";

describe("bundled SSH runtime installation", () => {
  it.skipIf(Effect.runSync(HostProcess.Platform) !== "win32")(
    "installs and reuses a Windows server archive in a path containing spaces and apostrophes",
    () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-windows-ssh's home-"));
      const run = (script: string) => {
        const [command, ...args] = powershellArgs(script);
        return NodeChildProcess.spawnSync(command!, args, {
          encoding: "utf8",
          env: { ...process.env, T3_TEST_REMOTE_HOME: home },
        });
      };
      try {
        const payload = NodePath.join(home, "payload", "runtime");
        NodeFS.mkdirSync(payload, { recursive: true });
        NodeFS.copyFileSync(process.execPath, NodePath.join(payload, "t3.exe"));
        const compressed = run(
          "Compress-Archive -LiteralPath (Join-Path $env:T3_TEST_REMOTE_HOME 'payload/runtime') -DestinationPath (Join-Path $env:T3_TEST_REMOTE_HOME 'runtime.zip')",
        );
        expect(compressed.status, compressed.stderr).toBe(0);
        const bytes = NodeFS.readFileSync(NodePath.join(home, "runtime.zip"));
        const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const parent = NodePath.join(home, ".t3-imaorise", "runtime");
        NodeFS.mkdirSync(parent, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(parent, `upload-${hash}.zip`), bytes);
        const result = run(
          windowsInstallScript(hash).replaceAll("$HOME", "$env:T3_TEST_REMOTE_HOME"),
        );
        expect(result.status, result.stderr).toBe(0);
        expect(NodeFS.existsSync(NodePath.join(parent, `sha256-${hash}`, "t3.exe"))).toBe(true);
        expect(
          run(windowsInstallScript(hash).replaceAll("$HOME", "$env:T3_TEST_REMOTE_HOME")).status,
        ).toBe(0);
        const invalid = "b".repeat(64);
        NodeFS.writeFileSync(NodePath.join(parent, `upload-${invalid}.zip`), bytes);
        expect(
          run(windowsInstallScript(invalid).replaceAll("$HOME", "$env:T3_TEST_REMOTE_HOME")).status,
        ).not.toBe(0);
        expect(NodeFS.existsSync(NodePath.join(parent, `sha256-${invalid}`))).toBe(false);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
  it.skipIf(Effect.runSync(HostProcess.Platform) === "win32")(
    "installs a verified Linux archive atomically and reuses it",
    () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runtime-"));
      try {
        const payload = NodePath.join(home, "payload", "runtime");
        NodeFS.mkdirSync(payload, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(payload, "t3"), "#!/bin/sh\nprintf '2.0.1-test\\n'\n", {
          mode: 0o700,
        });
        const archive = NodePath.join(home, "runtime.tar.gz");
        expect(
          NodeChildProcess.spawnSync("tar", [
            "-czf",
            archive,
            "-C",
            NodePath.join(home, "payload"),
            "runtime",
          ]).status,
        ).toBe(0);
        const bytes = NodeFS.readFileSync(archive);
        const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const parent = NodePath.join(home, ".t3-imaorise", "runtime");
        NodeFS.mkdirSync(parent, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(parent, `upload-${hash}.tar.gz`), bytes);
        const first = NodeChildProcess.spawnSync("sh", ["-s"], {
          input: linuxInstallScript(hash),
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        });
        expect(first.stderr).toBe("");
        expect(first.status).toBe(0);
        expect(
          NodeFS.readFileSync(NodePath.join(parent, `sha256-${hash}`, ".archive-sha256"), "utf8"),
        ).toBe(hash);
        expect(NodeFS.existsSync(NodePath.join(parent, `upload-${hash}.tar.gz`))).toBe(false);
        expect(
          NodeChildProcess.spawnSync("sh", ["-s"], {
            input: linuxInstallScript(hash),
            env: { ...process.env, HOME: home },
          }).status,
        ).toBe(0);
        const bad = "a".repeat(64);
        NodeFS.writeFileSync(NodePath.join(parent, `upload-${bad}.tar.gz`), bytes);
        expect(
          NodeChildProcess.spawnSync("sh", ["-s"], {
            input: linuxInstallScript(bad),
            env: { ...process.env, HOME: home },
          }).status,
        ).not.toBe(0);
        expect(NodeFS.existsSync(NodePath.join(parent, `sha256-${bad}`))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(parent, `sha256-${bad}.lock`))).toBe(false);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
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
