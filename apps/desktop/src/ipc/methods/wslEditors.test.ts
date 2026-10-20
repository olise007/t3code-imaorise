import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { beforeEach, vi } from "vite-plus/test";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import {
  BackendInstanceId,
  type DesktopBackendInstance,
  type DesktopBackendStartConfig,
} from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  unref: vi.fn(),
  installed: new Set(["vscode", "trae", "zed", "webstorm"]),
}));
vi.mock("electron", () => ({ shell: { openExternal: state.open } }));
vi.mock("@t3tools/shared/editor", () => ({
  resolveEditorCommand: (editor: { id: string }) =>
    Effect.succeed(
      state.installed.has(editor.id)
        ? Option.some({ command: editor.id, baseArgs: editor.id === "cursor" ? ["--classic"] : [] })
        : Option.none(),
    ),
}));

import { openWslEditor, probeLocalEditors } from "./window.ts";

beforeEach(() => {
  state.open.mockReset();
  state.unref.mockReset();
  state.installed = new Set(["vscode", "trae", "zed", "webstorm"]);
});

/** Detached fake process: record arguments without launching any real editor. */
const spawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected standard command");
      state.open(command.command, command.args);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.sync(() => {
          state.unref();
          return Effect.void;
        }),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  ),
);

const config: DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: [],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "test",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Debian",
};

function testLayer(backendId = "primary", ready = true) {
  const instance: DesktopBackendInstance = {
    id: BackendInstanceId(backendId),
    label: Effect.succeed("WSL"),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeedSome(config),
    snapshot: Effect.succeed({
      desiredRunning: true,
      ready,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(ready),
  };
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(
      DesktopEnvironment,
      DesktopEnvironment.of({ platform: "win32" } as DesktopEnvironment["Service"]),
    ),
    DesktopBackendPool.layerTest([instance]),
    Layer.succeed(HostProcess.Environment, {}),
    // Argument construction is platform-independent; shared shell tests own .cmd escaping.
    Layer.succeed(HostProcess.Platform, "linux"),
    spawnerLayer,
  );
}

describe("desktop WSL editor IPC", () => {
  it.effect("detects all catalog installations, including editors without WSL adapters", () =>
    Effect.gen(function* () {
      const editors = yield* probeLocalEditors.handler(undefined);
      assert.deepEqual(editors, ["trae", "vscode", "zed", "webstorm"]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "opens a concrete distro for both primary and default-tracking secondary backends",
    () =>
      Effect.gen(function* () {
        for (const backendId of ["primary", "wsl:default"]) {
          const opened = yield* openWslEditor
            .handler({
              backendId,
              distro: "Debian",
              editor: "vscode",
              path: "/home/me/a Ω.ts",
              line: 8,
              column: 2,
            })
            .pipe(Effect.provide(testLayer(backendId)));
          assert.isTrue(opened);
        }
        assert.deepEqual(state.open.mock.calls, [
          ["vscode", ["--open-url", "vscode://vscode-remote/wsl+Debian/home/me/a%20%CE%A9.ts:8:2"]],
          ["vscode", ["--open-url", "vscode://vscode-remote/wsl+Debian/home/me/a%20%CE%A9.ts:8:2"]],
        ]);
        assert.strictEqual(state.unref.mock.calls.length, 2);
      }),
  );

  it.effect("preserves Cursor's IDE flag before opening a WSL URL", () =>
    Effect.gen(function* () {
      state.installed.add("cursor");
      assert.isTrue(
        yield* openWslEditor.handler({
          backendId: "primary",
          distro: "Debian",
          editor: "cursor",
          path: "/work",
        }),
      );
      assert.deepEqual(state.open.mock.calls, [
        ["cursor", ["--classic", "--open-url", "cursor://vscode-remote/wsl+Debian/work"]],
      ]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "rejects stale distributions, unknown backends, unsupported editors and invalid paths",
    () =>
      Effect.gen(function* () {
        state.open.mockClear();
        const input = {
          backendId: "primary",
          distro: "Debian",
          editor: "vscode" as const,
          path: "/work",
        };
        for (const changed of [
          { distro: "Ubuntu" },
          { backendId: "wsl:missing" },
          { editor: "zed" as const },
          { editor: "cursor" as const },
          { path: "C:\\work" },
        ]) {
          assert.isFalse(yield* openWslEditor.handler({ ...input, ...changed }));
        }
        assert.strictEqual(state.open.mock.calls.length, 0);
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect("does not launch while its backend is stopped", () =>
    openWslEditor
      .handler({ backendId: "primary", distro: "Debian", editor: "vscode", path: "/work" })
      .pipe(
        Effect.tap((opened) => Effect.sync(() => assert.isFalse(opened))),
        Effect.provide(testLayer("primary", false)),
      ),
  );
});
