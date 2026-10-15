// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { discoverConnections, WSL_DISCOVER_SCRIPT } from "./DesktopSshDiscovery.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";

it.effect("refreshes distinct sources without starting stopped distros and isolates failures", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-sources-"));
    const commands: string[][] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = command._tag === "StandardCommand" ? [...command.args] : [];
        commands.push(args);
        const distro = args[1];
        const listed = args[0] === "--list";
        const output = listed
          ? Buffer.from(
              args.includes("--running")
                ? "Ubuntu\r\nBroken\r\n"
                : "Ubuntu\r\nDebian\r\nBroken\r\n",
              "utf16le",
            )
          : Buffer.from("ssh-config\tshared\nssh-config\tshared\n");
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(output),
          stderr: Stream.empty,
          all: Stream.make(output),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(distro === "Broken" ? 1 : 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const environment = DesktopEnvironment.layer({
      dirname: home,
      homeDirectory: home,
      platform: "win32",
      processArch: "x64",
      appVersion: "2.0.1-test",
      appPath: home,
      isPackaged: true,
      resourcesPath: home,
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(Layer.merge(NodeServices.layer, DesktopConfig.layerTest({}))));
    const discover = (load?: string) =>
      discoverConnections(load).pipe(
        Effect.provide(
          Layer.mergeAll(
            environment,
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
    try {
      NodeFS.mkdirSync(NodePath.join(home, ".ssh"));
      NodeFS.writeFileSync(NodePath.join(home, ".ssh/config"), "Host shared\n");
      const first = yield* discover();
      expect(first.hosts.filter((host) => host.alias === "shared")).toHaveLength(2);
      expect(first.sources.find((source) => source.label.includes("Debian"))?.running).toBe(false);
      expect(first.sources.find((source) => source.label.includes("Broken"))?.error).toBeTruthy();
      expect(commands.some((args) => args[1] === "Debian")).toBe(false);
      expect(yield* discover()).toEqual(first);
      const loaded = yield* discover("Debian");
      expect(loaded.hosts.filter((host) => host.alias === "shared")).toHaveLength(3);
      expect(commands.some((args) => args[1] === "Debian")).toBe(true);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);

it.effect("discovers aliases and recursive includes inside the owning Linux home", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-discovery-"));
    try {
      const ssh = NodePath.join(home, ".ssh");
      NodeFS.mkdirSync(NodePath.join(ssh, "config.d"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(ssh, "team #1"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(ssh, "config"),
        'Host workstation\n HostName localhost\nInclude config.d/*\nInclude = "team #1/*.conf" # comment\nHost * !ignored wildcard?\n',
      );
      NodeFS.writeFileSync(
        NodePath.join(ssh, "config.d", "dev"),
        "Host remote-build\nInclude ../.ssh/config\n",
      );
      NodeFS.writeFileSync(NodePath.join(ssh, "team #1", "dev.conf"), "Host=quoted-dev\n");
      NodeFS.writeFileSync(
        NodePath.join(ssh, "known_hosts"),
        "known.example ssh-ed25519 key\n|1|hashed|entry key\n",
      );
      const result = NodeChildProcess.spawnSync("sh", ["-s"], {
        input: WSL_DISCOVER_SCRIPT,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ssh-config\tworkstation");
      expect(result.stdout).toContain("ssh-config\tremote-build");
      expect(result.stdout).toContain("ssh-config\tquoted-dev");
      expect(result.stdout).toContain("known-hosts\tknown.example");
      expect(result.stdout).not.toContain("hashed");
      expect(result.stdout).not.toContain("wildcard?");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);
