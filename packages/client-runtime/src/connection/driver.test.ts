import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Resolver from "./resolver.ts";
import * as Driver from "./driver.ts";
import { SshConnectionTarget } from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

it.effect.each(["preparation", "synchronization"] as const)(
  "bounds SSH %s without conflating its deadline",
  (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const target = new SshConnectionTarget({
        environmentId: EnvironmentId.make("fixture"),
        label: "Fixture",
        connectionId: "ssh-fixture",
      });
      const prepared = {
        environmentId: target.environmentId,
        label: target.label,
        target,
        httpBaseUrl: "http://127.0.0.1:4773",
        socketUrl: "ws://127.0.0.1:4773/ws",
        httpAuthorization: null,
      };
      const stalled = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const resolver = Resolver.ConnectionResolver.of({
        prepare: () => (stage === "preparation" ? stalled : Effect.succeed(prepared)),
        prepareForUpdate: () => Effect.die("unused"),
      });
      const sessions = RpcSession.RpcSessionFactory.of({
        connect: () =>
          Effect.succeed({
            client: {} as WsRpcProtocolClient,
            ready: stalled,
            closed: Effect.never,
            initialConfig: Effect.die("unused"),
            subscribeServerConfig: () => Stream.empty,
            probe: Effect.void,
          }),
      });
      const driver = yield* Driver.make.pipe(
        Effect.provideService(Resolver.ConnectionResolver, resolver),
        Effect.provideService(RpcSession.RpcSessionFactory, sessions),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
          ),
        ),
      );
      let completed = false;
      const attempt = yield* driver
        .connect({ target, profile: Option.none(), enabled: true }, () => Effect.void)
        .pipe(
          Effect.result,
          Effect.ensuring(
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(stage === "preparation" ? "59 seconds" : "14 seconds");
      expect(completed).toBe(false);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(attempt);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("timeout");
        expect(result.failure.message).toContain(
          stage === "preparation" ? "SSH preparation" : "synchronization",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);
