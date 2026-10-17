// @effect-diagnostics nodeBuiltinImport:off - Disposable packaged-runtime fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  WS_METHODS,
  type ServerConfig,
  type TerminalAttachStreamEvent,
} from "../../packages/contracts/src/index.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../../packages/client-runtime/src/rpc/session.ts";

/** Real PTYs must not own the session, another terminal, or the managed server. */
export const verifyTerminalIsolation = (session: RpcSession, config: ServerConfig) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = `terminal-fixture-${NodeCrypto.randomUUID()}`;
      const client = session.client;
      const open = (terminalId: string) =>
        client[WS_METHODS.terminalOpen]({
          threadId,
          terminalId,
          cwd: config.cwd,
          cols: 80,
          rows: 24,
        });
      const observe = <E>(
        terminalId: string,
        action: Effect.Effect<unknown, E>,
        matches: (event: TerminalAttachStreamEvent, output: string) => boolean,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void, Error>();
            const matched = yield* Deferred.make<void, Error>();
            let output = "";
            yield* client[WS_METHODS.terminalObserve]({ threadId, terminalId }).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "snapshot") yield* Deferred.succeed(ready, undefined);
                  if (event.type === "output")
                    output = NodeUtil.stripVTControlCharacters((output + event.data).slice(-32768));
                  if (matches(event, output)) yield* Deferred.succeed(matched, undefined);
                }),
              ),
              Effect.catch((cause) => {
                const error = new Error("Terminal observation failed", { cause });
                return Effect.all([Deferred.fail(ready, error), Deferred.fail(matched, error)]);
              }),
              Effect.forkScoped,
            );
            yield* Deferred.await(ready);
            yield* action;
            yield* Deferred.await(matched);
          }),
        ).pipe(Effect.timeout("15 seconds"));
      const echo = (terminalId: string) => {
        const marker = `T3_TERMINAL_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        return observe(
          terminalId,
          client[WS_METHODS.terminalWrite]({ threadId, terminalId, data: `echo ${marker}\r` }),
          (_event, text) => text.split(/\r?\n/).some((line) => line.trim() === marker),
        );
      };
      const sidecar = yield* open("sidecar");
      if (!sidecar.pid) return yield* Effect.die("Second terminal did not receive an owned PID.");
      yield* Effect.addFinalizer(() =>
        client[WS_METHODS.terminalClose]({ threadId }).pipe(Effect.ignore),
      );
      yield* echo("sidecar");
      for (let index = 0; index < 3; index++) {
        const terminalId = `closed-${index}`;
        yield* open(terminalId);
        yield* echo(terminalId);
        yield* client[WS_METHODS.terminalResize]({ threadId, terminalId, cols: 100, rows: 30 });
        yield* observe(
          terminalId,
          client[WS_METHODS.terminalClose]({ threadId, terminalId }),
          (event) => event.type === "closed",
        );
        yield* client[WS_METHODS.terminalClose]({ threadId, terminalId });
        yield* session.probe;
        yield* echo("sidecar");
        const current = yield* open("sidecar");
        if (current.pid !== sidecar.pid)
          return yield* Effect.die("Closing a terminal replaced the unrelated terminal.");
      }
      yield* open("shell-exit");
      yield* observe(
        "shell-exit",
        client[WS_METHODS.terminalWrite]({ threadId, terminalId: "shell-exit", data: "exit\r" }),
        (event) => event.type === "exited",
      );
      yield* session.probe;
      yield* echo("sidecar");
      // Close immediately after open as well as after receiving shell output.
      yield* open("immediate-close");
      yield* client[WS_METHODS.terminalClose]({ threadId, terminalId: "immediate-close" });
      yield* echo("sidecar");
      yield* session.probe;
      yield* Effect.logInfo(
        "Passed real terminal close, shell exit, repeated closure and unrelated terminal/session survival.",
      );
    }),
  );
