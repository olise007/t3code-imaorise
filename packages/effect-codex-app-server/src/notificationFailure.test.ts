import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encoder = new TextEncoder();

it.effect.each(["decode", "handler", "unknown-handler"] as const)(
  "terminates the client on a notification %s failure and rejects pending RPCs",
  (failureKind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const client = yield* CodexClient.make(stdio);
        const failure = CodexError.CodexAppServerRequestError.methodNotFound("test/handler");
        const method = failureKind === "unknown-handler" ? "test/unknown" : "item/completed";
        if (failureKind === "handler") {
          yield* client.handleServerNotification("item/completed", () => Effect.fail(failure));
        } else if (failureKind === "unknown-handler") {
          yield* client.handleUnknownServerNotification(() => Effect.fail(failure));
        }
        const pending = yield* client.raw
          .request("test/pending")
          .pipe(Effect.exit, Effect.forkChild);
        // Wait for the RPC to be sent, rather than racing notification dispatch.
        yield* Queue.take(output);
        yield* Queue.offer(
          input,
          encoder.encode(
            `${JSON.stringify({
              method,
              params:
                failureKind === "decode"
                  ? { privateText: "credential-marker" }
                  : {
                      threadId: "native-thread",
                      turnId: "native-turn",
                      completedAtMs: 1,
                      item: {
                        type: "agentMessage",
                        id: "answer",
                        text: "done",
                        phase: "final_answer",
                        memoryCitation: null,
                      },
                    },
            })}\n`,
          ),
        );
        const error = yield* Effect.flip(client.termination);
        if (failureKind === "decode") {
          assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
          assert.notInclude(error.message, "credential-marker");
        } else {
          assert.strictEqual(error, failure);
        }
        assert.isTrue(Exit.isFailure(yield* Fiber.join(pending)));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(client.raw.request("test/afterFailure"))));
      }),
    ),
);
