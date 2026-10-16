// @effect-diagnostics nodeBuiltinImport:off - These fixtures exercise owned native pipes without contacting SSH hosts.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";

const target = { alias: "fixture", hostname: "fixture.invalid", username: null, port: 22 };

// Replace only the destination executable. Keep the real platform spawner,
// stdin sink, stdout/stderr drains, exit handling, and command-scope cleanup.
const fixtureCommand = (script: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fixture = ChildProcessSpawner.make((command) =>
      native.spawn(
        ChildProcess.make(
          process.execPath,
          ["-e", script],
          command._tag === "StandardCommand" ? command.options : {},
        ),
      ),
    );
    return yield* Effect.result(
      runSshCommand(target, { stdinBytes: bytes, timeoutMs: 10_000 }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture),
      ),
    );
  });

it.live("transfers every byte before reporting successful completion", () =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(8 * 1024 * 1024).fill(65);
    const result = yield* fixtureCommand(
      "let count=0;process.stdin.on('data',b=>{count+=b.length;if(b.some(v=>v!==65))process.exit(9)});process.stdin.on('end',()=>process.stdout.write(String(count)))",
      bytes,
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.stdout).toBe(String(bytes.length));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps an early-closing receiver's storage error without crashing the host", () =>
  Effect.gen(function* () {
    const result = yield* fixtureCommand(
      "process.stderr.write('No space left on device\\n',()=>process.exit(74))",
      new Uint8Array(32 * 1024 * 1024),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SshCommandError);
      expect(result.failure.message).toContain("ran out of storage");
      if (result.failure instanceof SshCommandError) expect(result.failure.exitCode).toBe(74);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects truncated input even when the receiver exits successfully", () =>
  Effect.gen(function* () {
    const result = yield* fixtureCommand("process.exit(0)", new Uint8Array(32 * 1024 * 1024));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure.message).toContain("before the transfer completed");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("handles a late Windows EOF after the input writer is cancelled", () =>
  Effect.gen(function* () {
    const spawn = NodeChildProcess.spawn;
    // Node's ESM namespace is immutable. Instrument its mutable builtin object
    // and refresh named exports so the real spawner sees the same function.
    const builtin = NodeModule.createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof NodeChildProcess;
    let captured: NodeChildProcess.ChildProcess | undefined;
    const spy = vi
      .spyOn(builtin, "spawn")
      .mockImplementation((...args: Parameters<typeof spawn>) => {
        captured = spawn(...args);
        return captured;
      });
    NodeModule.syncBuiltinESMExports();
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [
              "-e",
              "process.stdout.write('ready');setInterval(()=>{},1000)",
            ]),
          );
          // Read a real readiness event; no timing assumptions or polling.
          yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
          const feeding = yield* Deferred.make<void>();
          const writer = yield* Stream.run(
            Stream.fromEffect(
              Deferred.succeed(feeding, undefined).pipe(Effect.andThen(Effect.never)),
            ),
            child.stdin,
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(feeding);
          yield* Fiber.interrupt(writer);
          yield* Effect.sync(() => {
            const pipe = captured!.stdin!;
            const error = Object.assign(new Error("write EOF"), { code: "EOF" });
            expect(() => pipe.emit("error", error)).not.toThrow();
          });
        }),
      );
    } finally {
      spy.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
