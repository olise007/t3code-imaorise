// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  linuxInstallScript,
  remoteRuntimeInvocation,
  windowsInstallScript,
  powershellArgs,
  runtimeStorageScript,
} from "./bundledRuntime.ts";
import { runtimeRequirements } from "./prerequisites.ts";

describe("bundled SSH runtime installation", () => {
  it.effect(
    "checks storage on the login user's runtime filesystem before upload",
    () =>
      Effect.gen(function* () {
        const platform = (yield* HostProcess.Platform) === "win32" ? "windows" : "linux";
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage's home-"));
        try {
          const requirements = {
            ...runtimeRequirements(platform, "test"),
            unpackedBytes: 1024,
            unpackedEntries: 30,
          };
          const script = (size: number) => runtimeStorageScript(platform, size, requirements);
          const invoke = (size: number) => {
            if (platform === "windows") {
              const [exe, ...args] = powershellArgs(
                script(size).replaceAll("$HOME", "$env:T3_TEST_REMOTE_HOME"),
              );
              return NodeChildProcess.spawnSync(exe!, args, {
                encoding: "utf8",
                env: { ...process.env, T3_TEST_REMOTE_HOME: home },
                timeout: 15_000,
              });
            }
            return NodeChildProcess.spawnSync("sh", ["-s"], {
              input: script(size),
              encoding: "utf8",
              env: { ...process.env, HOME: home },
              timeout: 5000,
            });
          };
          expect(invoke(1024).status).toBe(0);
          const tooLarge = invoke(2 ** 52);
          expect(tooLarge.status).not.toBe(0);
          expect(tooLarge.stderr).toContain("Insufficient remote runtime storage");
          expect(NodeFS.existsSync(NodePath.join(home, ".t3-imaorise"))).toBe(false);
        } finally {
          NodeFS.rmSync(home, { recursive: true, force: true });
        }
      }),
    40_000,
  );

  it.effect("checks free inodes at the runtime path inside a linked Linux home", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-inodes-"));
      try {
        const actualHome = NodePath.join(directory, "mounted-home");
        const home = NodePath.join(directory, "login-home");
        const runtime = NodePath.join(actualHome, ".t3-imaorise", "runtime");
        NodeFS.mkdirSync(runtime, { recursive: true });
        NodeFS.symlinkSync(actualHome, home, "dir");
        const bin = NodePath.join(directory, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.writeFileSync(
          NodePath.join(bin, "df"),
          `#!/bin/sh\nprintf '%s\\n' "$2" >> "$T3_TEST_DF_PATHS"\nprintf 'Filesystem blocks used available capacity mount\\n'\ncase "$1" in -Pi) printf 'fixture 100 99 1 99%% /home-volume\\n';; *) printf 'fixture 900000000 0 900000000 0%% /home-volume\\n';; esac\n`,
          { mode: 0o700 },
        );
        const paths = NodePath.join(directory, "paths");
        const result = NodeChildProcess.spawnSync("sh", ["-s"], {
          input: runtimeStorageScript("linux", 1024, {
            ...runtimeRequirements("linux", "test"),
            unpackedBytes: 1024,
            unpackedEntries: 100,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
            T3_TEST_DF_PATHS: paths,
          },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inodes");
        expect(NodeFS.readFileSync(paths, "utf8").trim().split("\n")).toEqual([
          NodePath.join(home, ".t3-imaorise", "runtime"),
          NodePath.join(home, ".t3-imaorise", "runtime"),
        ]);
        expect(NodeFS.readdirSync(runtime)).toEqual([]);
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("cleans only the failed Linux attempt after extraction or staging fails", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-cleanup-"));
      try {
        const parent = NodePath.join(home, ".t3-imaorise", "runtime");
        const bin = NodePath.join(home, "bin");
        NodeFS.mkdirSync(parent, { recursive: true });
        NodeFS.mkdirSync(bin);
        const bytes = Buffer.from("disposable archive");
        const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const archive = NodePath.join(parent, `upload-${hash}-fixture.tar.gz`);
        NodeFS.writeFileSync(NodePath.join(parent, "existing-server"), "preserve");
        NodeFS.writeFileSync(
          NodePath.join(bin, "tar"),
          "#!/bin/sh\nprintf 'No space left on device\\n' >&2\nexit 1\n",
          { mode: 0o700 },
        );
        const run = () =>
          NodeChildProcess.spawnSync("sh", ["-s"], {
            input: linuxInstallScript(hash, "-fixture"),
            encoding: "utf8",
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
          });
        NodeFS.writeFileSync(archive, bytes);
        const result = run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("No space left");
        expect(NodeFS.readdirSync(parent)).toEqual(["existing-server"]);
        NodeFS.writeFileSync(NodePath.join(bin, "mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
        NodeFS.writeFileSync(archive, bytes);
        expect(run().status).not.toBe(0);
        expect(NodeFS.readdirSync(parent)).toEqual(["existing-server"]);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }),
  );
  it.effect(
    "installs and reuses a Windows server archive in a path containing spaces and apostrophes",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "win32") return;
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-windows-ssh's home-"));
        const run = (script: string) => {
          // Node stands in for the T3 executable; packaged smoke runs the real native verifier.
          script = script.replaceAll("__ssh-helper verify-runtime", "--version");
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
            run(windowsInstallScript(invalid).replaceAll("$HOME", "$env:T3_TEST_REMOTE_HOME"))
              .status,
          ).not.toBe(0);
          expect(NodeFS.existsSync(NodePath.join(parent, `sha256-${invalid}`))).toBe(false);
        } finally {
          NodeFS.rmSync(home, { recursive: true, force: true });
        }
      }),
    60_000,
  );
  it.effect("installs a verified Linux archive atomically and reuses it", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
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
    }),
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
