import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    // Descendants can inherit stdout and keep it open after the provider exits.
    // Watch the process independently; silence is never a termination signal.
    stdin: handle.stdout.pipe(
      Stream.interruptWhen(
        Effect.raceFirst(
          handle.exitCode,
          handle.isRunning.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("30 seconds"),
              until: (running) => !running,
            }),
            // An unavailable probe is not evidence that the process is gone.
            Effect.catch(() => Effect.never),
          ),
        ).pipe(
          // Let buffered final notifications drain before inherited pipes are
          // interrupted. The normal EOF path still reports immediately.
          Effect.andThen(Effect.sleep("1 second")),
        ),
      ),
    ),
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.match(handle.exitCode.pipe(Effect.timeoutOption("2 seconds")), {
    onFailure: (cause) =>
      new CodexError.CodexAppServerTransportError({
        operation: "read-process-exit-status",
        pid: handle.pid,
        cause,
      }),
    onSuccess: (code) =>
      new CodexError.CodexAppServerProcessExitedError({
        ...(Option.isSome(code) ? { code: code.value } : {}),
        pid: handle.pid,
      }),
  });
