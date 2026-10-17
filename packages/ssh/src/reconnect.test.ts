import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { prepareBundledRuntime } from "./bundledRuntime.ts";
import { SshEnvironmentManager } from "./tunnel.ts";

vi.mock("./bundledRuntime.ts", async (original) => ({
  ...(await original<typeof import("./bundledRuntime.ts")>()),
  prepareBundledRuntime: vi.fn(() =>
    Effect.succeed({
      platform: "linux" as const,
      relativeExecutable: `.t3-imaorise/runtime/sha256-${"a".repeat(64)}/t3`,
      version: "2.0.1-test",
    }),
  ),
}));

it.effect(
  "reuses prepared runtimes and live tunnels across setup, reconnect and manager reopen",
  () =>
    Effect.gen(function* () {
      vi.mocked(prepareBundledRuntime).mockClear();
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reconnect-" });
      const scripts: string[] = [];
      let tunnels = 0;
      let killed = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
          const args = command.args;
          const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const script = yield* Deferred.make<string>();
          let running = args.includes("-N");
          if (running) tunnels++;
          const reply = args.includes("-N")
            ? Effect.succeed("")
            : args.includes("echo T3_SSH_AUTH_OK")
              ? Effect.succeed("T3_SSH_AUTH_OK\n")
              : Deferred.await(script).pipe(
                  Effect.map((value) => {
                    scripts.push(value);
                    if (value.includes("managed-start"))
                      return '{"remotePort":4773,"serverKind":"managed"}\n';
                    if (value.includes("managed-pair")) return '{"credential":"fixture"}\n';
                    if (value.includes("--version")) return "2.0.1-test\n";
                    throw new Error("Reconnect attempted an unexpected remote operation");
                  }),
                );
          const stdout = Stream.fromEffect(
            reply.pipe(Effect.map((text) => new TextEncoder().encode(text))),
          );
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1234),
            stdout,
            stderr: Stream.empty,
            all: stdout,
            stdin: Sink.forEach((bytes: Uint8Array) =>
              Deferred.succeed(script, new TextDecoder().decode(bytes)),
            ),
            exitCode: running
              ? Deferred.await(exit)
              : reply.pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            isRunning: Effect.sync(() => running),
            kill: () =>
              Effect.gen(function* () {
                if (running) {
                  running = false;
                  killed++;
                  yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
                }
              }),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      );
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const net = NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        hasListenerOnHost: () => Effect.succeed(false),
        reserveLoopbackPort: () => Effect.succeed(41773),
        findAvailablePort: (port) => Effect.succeed(port),
      });
      const bundles = {
        version: "2.0.1-test",
        linux: { path: "/unused", sha256: "a".repeat(64) },
        windows: { path: "/unused", sha256: "b".repeat(64) },
      };
      const target = {
        alias: "fixture",
        hostname: "192.0.2.1",
        username: "fixture",
        port: 22,
        manual: {
          profileId: "fixture",
          name: "Fixture",
          authentication: { type: "key" as const, identityFile: "/fixture/key" },
        },
      };
      const exercise = Effect.gen(function* () {
        const manager = Context.get(
          yield* Layer.build(
            SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed({ bundles }) }),
          ),
          SshEnvironmentManager,
        );
        yield* manager.ensureEnvironment(target, { purpose: "setup", issuePairingToken: true });
        yield* manager.ensureEnvironment(target, { purpose: "reconnect", issuePairingToken: true });
        expect(tunnels).toBe(1);
        expect(killed).toBe(0);
        expect(prepareBundledRuntime).toHaveBeenCalledTimes(1);
        yield* manager.disconnectEnvironment(target);
        const reopened = Context.get(
          yield* Layer.build(
            SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed({ bundles }) }),
          ),
          SshEnvironmentManager,
        );
        yield* reopened.ensureEnvironment(target, {
          purpose: "reconnect",
          issuePairingToken: true,
        });
        expect(tunnels).toBe(2);
        expect(prepareBundledRuntime).toHaveBeenCalledTimes(1);
        const starts = scripts.filter((script) => script.includes("managed-start"));
        expect(starts[0]).toContain("'no'");
        expect(starts.at(-1)).toContain("'no'");
        expect(scripts.join("\n")).not.toMatch(
          /Inspecting remote prerequisites|Expand-Archive|tar -x/,
        );
      });
      yield* exercise.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(NetService.NetService, net),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provide(SshAuth.SshPasswordPrompt.disabledLayer),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
