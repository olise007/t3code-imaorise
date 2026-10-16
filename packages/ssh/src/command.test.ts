import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  baseSshArgs,
  getLastNonEmptyOutputLine,
  parseSshResolveOutput,
  remoteStateKey,
  targetConnectionKey,
  runSshCommand,
} from "./command.ts";
import { SshCommandError } from "./errors.ts";
import { isSshAuthFailure } from "./auth.ts";

const encoder = new TextEncoder();

const makeFailedProcess = (input: { readonly stdout: string; readonly stderr?: string }) => {
  const stdoutStream = Stream.make(encoder.encode(input.stdout));
  const stderrStream = input.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: stderrStream,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeNeverFinishingProcess = () => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

describe("ssh command", () => {
  it.effect.each(["local", "wsl"] as const)(
    "routes %s archive transfers through the source's native SFTP client",
    (source) => {
      const commands: ChildProcess.Command[] = [];
      const spawner = ChildProcessSpawner.make((command) => {
        commands.push(command);
        return Effect.succeed({
          ...makeFailedProcess({ stdout: "" }),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        });
      });
      return Effect.gen(function* () {
        const result = yield* runSshCommand(
          {
            alias: "2001:db8::1",
            hostname: "2001:db8::1",
            username: "ACME\\developer",
            port: 2222,
            executionSource:
              source === "wsl" ? { type: "wsl", distro: "Ubuntu 26.04" } : { type: "local" },
          },
          {
            upload: {
              localPath: "C:/runtime's files/[archive].zip",
              remotePath: "/D:/User home/runtime.zip",
            },
          },
        );
        assert.equal(result.stdout, "");
        const command = commands[0]!;
        assert.equal(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") return;
        assert.equal(command.command, source === "wsl" ? "wsl.exe" : "scp.exe");
        assert.include(command.args, source === "wsl" ? "scp" : "-s");
        assert.include(command.args, "-P");
        assert.include(command.args, "2222");
        assert.equal(command.args.at(-2), "C:/runtime's files/[archive].zip");
        assert.equal(
          command.args.at(-1),
          "ACME\\developer@[2001:db8::1]:/D:/User home/runtime.zip",
        );
        if (source === "wsl") assert.include(command.args, "Ubuntu 26.04");
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

  it.effect("explains a disabled remote SFTP subsystem without replaying transfer", () => {
    let count = 0;
    const spawner = ChildProcessSpawner.make(() => {
      count++;
      return Effect.succeed(
        makeFailedProcess({ stdout: "", stderr: "subsystem request failed on channel 0" }),
      );
    });
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          { alias: "fixture", hostname: "fixture", username: null, port: 22 },
          { upload: { localPath: "/tmp/archive.tar.gz", remotePath: "/home/user/runtime.tar.gz" } },
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.include(result.failure.message, "SFTP subsystem");
      assert.equal(count, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
  it.effect("keeps rejected credentials retryable after display sanitizing", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeFailedProcess({
          stdout: "",
          stderr: "fixture: Permission denied (publickey,password,keyboard-interactive).\r\n",
        }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand({ alias: "fixture", hostname: "fixture", username: null, port: 22 }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.isTrue(isSshAuthFailure(result.failure));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
  it.effect(
    "retains CRLF host-key evidence for authentication without displaying it",
    () => {
      const record = `T3_SSH_PROMPT:${Buffer.from("Host SHA256:fixture (yes/no)?").toString("base64")}`;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeFailedProcess({
            stdout: "",
            stderr: `${record}\r\nHost key verification failed.\r\n`,
          }),
        ),
      );
      return Effect.gen(function* () {
        const result = yield* Effect.result(
          runSshCommand(
            { alias: "fixture", hostname: "fixture", username: null, port: 22 },
            { interactiveAuth: true },
          ),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          assert.include(result.failure.stderr, record);
          assert.notInclude(result.failure.message, record);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
    },
    30_000,
  );
  it.effect("bounds extraction errors and summarizes an exhausted destination", () => {
    const stderr =
      "tar: No space left on device\n" +
      "tar: Cannot mkdir: No such file or directory\n".repeat(15_000);
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: "", stderr })),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand({ alias: "fixture", hostname: "fixture", username: null, port: 22 }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.include(result.failure.message, "ran out of storage");
        assert.isBelow(result.failure.message.length, 600);
        assert.isBelow(result.failure.stderr.length, 4100);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
  it.effect("withholds diagnostics when a privileged operation consumes a secret", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeFailedProcess({ stdout: "sudo-fixture-secret", stderr: "sudo-fixture-secret" }),
      ),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          { alias: "fixture", hostname: "fixture", username: null, port: 22 },
          {
            sensitiveInput: true,
            stdin: "sudo-fixture-secret\n",
            remoteCommandArgs: ["sudo", "-S"],
          },
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.stdout, "");
        assert.notInclude(result.failure.message, "sudo-fixture-secret");
        assert.notInclude(result.failure.stderr, "sudo-fixture-secret");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
  it.effect("parses resolved ssh config output into a target", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshResolveOutput(
          "devbox",
          ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
        ),
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      );
    }),
  );

  it.effect("builds interactive ssh args without forcing batch mode", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { batchMode: "no" },
        ),
        [
          "-o",
          "BatchMode=no",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "StrictHostKeyChecking=ask",
          "-p",
          "2222",
        ],
      );
    }),
  );

  // Remote servers store state under this key, so it must not change across releases.
  it.effect("derives a stable remote state key", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* remoteStateKey({
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        }),
        "711bc738002d72fd",
      );
      assert.equal(
        yield* remoteStateKey({
          alias: "fixture",
          hostname: "fixture",
          username: null,
          port: null,
        }),
        "326264c4f08c8a0c",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains a manual server after profile edits while isolating local credentials and tunnels",
    () =>
      Effect.gen(function* () {
        const first = {
          alias: "Manual",
          hostname: "192.0.2.1",
          username: "user",
          port: 22,
          manual: {
            profileId: "stable-profile",
            name: "Before",
            authentication: { type: "password" as const },
          },
        };
        const edited = {
          ...first,
          hostname: "new-address.example",
          executionSource: { type: "wsl" as const, distro: "Ubuntu" },
          manual: {
            ...first.manual,
            name: "After",
            authentication: { type: "key" as const, identityFile: "/home/user/.ssh/key" },
          },
        };
        assert.equal(yield* remoteStateKey(first), yield* remoteStateKey(edited));
        assert.notEqual(targetConnectionKey(first), targetConnectionKey(edited));
        assert.notEqual(
          yield* remoteStateKey(first),
          yield* remoteStateKey({
            ...first,
            manual: { ...first.manual, profileId: "other-profile" },
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the last non-empty ssh output line", () =>
    Effect.sync(() => {
      assert.equal(
        getLastNonEmptyOutputLine(
          ["Welcome to the host", "", '{"credential":"pairing-token"}', ""].join("\n"),
        ),
        '{"credential":"pairing-token"}',
      );
    }),
  );

  it.effect("includes stdout in non-zero command failures when stderr is empty", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: "Pairing token creation failed\n" })),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { remoteCommandArgs: ["sh", "-s"] },
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, "Pairing token creation failed");
        assert.equal(result.failure.stdout, "Pairing token creation failed\n");
        assert.equal(result.failure.stderr, "");
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("redacts credentials from stdout in non-zero command failures", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeFailedProcess({ stdout: '{"credential":"pairing-secret"}\n' })),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { remoteCommandArgs: ["sh", "-s"] },
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, '{"credential":"[redacted]"}');
        assert.equal(result.failure.stdout, '{"credential":"[redacted]"}\n');
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("fails commands that never finish", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          runSshCommand(
            {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 2222,
            },
            { timeoutMs: 1 },
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "SSH command timed out after 1ms.");
      }
    }).pipe(Effect.provide(layerProcess));
  });
});
