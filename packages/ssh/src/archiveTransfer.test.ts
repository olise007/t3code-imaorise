import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runSshCommand } from "./command.ts";
import { uploadRuntimeArchive } from "./bundledRuntime.ts";

vi.mock("./command.ts", async (original) => ({
  ...(await original<typeof import("./command.ts")>()),
  runSshCommand: vi.fn(),
}));

it.effect.each([0, 1])(
  "keeps the archive in its saved WSL source (resolver exit %s)",
  (exitCode) => {
    const commands: ChildProcess.Command[] = [];
    const path = "/mnt/c/Program Files/T3/runtime's [archive].zip";
    const spawner = ChildProcessSpawner.make((command) => {
      commands.push(command);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(new TextEncoder().encode(path + "\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          stdin: Sink.drain,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    });
    return Effect.gen(function* () {
      vi.mocked(runSshCommand).mockReset();
      vi.mocked(runSshCommand).mockReturnValue(
        Effect.succeed({
          stdout: Buffer.from("D:\\User home\\.t3-imaorise\\runtime\\upload.zip").toString(
            "base64",
          ),
          stderr: "",
        }),
      );
      const target = {
        alias: "same-alias",
        hostname: "host",
        username: "user",
        port: 2222,
        executionSource: { type: "wsl" as const, distro: "Ubuntu 26.04" },
      };
      const result = yield* Effect.result(
        uploadRuntimeArchive(
          target,
          {},
          "windows",
          "C:\\Program Files\\T3\\runtime's [archive].zip",
          "a".repeat(64),
          "-fixture",
        ),
      );
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      if (command._tag !== "StandardCommand")
        throw new Error("Expected a direct WSL source operation.");
      assert.equal(command.command, "wsl.exe");
      assert.deepEqual(command.args.slice(0, 5), [
        "--distribution",
        "Ubuntu 26.04",
        "--exec",
        "wslpath",
        "-u",
      ]);
      if (exitCode === 0) {
        assert.equal(result._tag, "Success");
        assert.equal(vi.mocked(runSshCommand).mock.calls.length, 2);
        assert.deepEqual(vi.mocked(runSshCommand).mock.calls[1]![1]!.upload, {
          localPath: path,
          remotePath: "/D:/User home/.t3-imaorise/runtime/upload.zip",
        });
        assert.deepEqual(
          vi.mocked(runSshCommand).mock.calls[1]![0].executionSource,
          target.executionSource,
        );
      } else {
        assert.equal(result._tag, "Failure");
        assert.equal(vi.mocked(runSshCommand).mock.calls.length, 1);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
  },
);
