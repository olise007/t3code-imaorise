import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  trackProviderInstallationWork,
  withProviderInstallationIdle,
} from "./ProviderInstallationActivity.ts";

it.effect("waits for shared running work and releases queued work after atomic activation", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("installation-fixture");
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const activated = yield* Deferred.make<void>();
    const releaseActivation = yield* Deferred.make<void>();
    const order: string[] = [];
    const worker = yield* Effect.forkChild(
      trackProviderInstallationWork(
        id,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.tap(() =>
            Effect.sync(() => {
              order.push("old work finished");
            }),
          ),
        ),
      ),
    );
    yield* Deferred.await(started);
    const update = yield* Effect.forkChild(
      withProviderInstallationIdle(
        [id],
        Effect.sync(() => {
          order.push("activated");
        }).pipe(
          Effect.andThen(Deferred.succeed(activated, undefined)),
          Effect.andThen(Deferred.await(releaseActivation)),
        ),
      ),
    );
    yield* Deferred.succeed(finish, undefined);
    yield* Deferred.await(activated);
    const queued = yield* Effect.forkChild(
      trackProviderInstallationWork(
        id,
        Effect.sync(() => {
          order.push("new work started");
        }),
      ),
    );
    yield* Deferred.succeed(releaseActivation, undefined);
    yield* Fiber.join(worker);
    yield* Fiber.join(update);
    yield* Fiber.join(queued);
    expect(order).toEqual(["old work finished", "activated", "new work started"]);
  }),
);

it.effect("cancels a waiting activation without pinning subsequent work", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("cancelled-installation-fixture");
    const ready = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const worker = yield* Effect.forkChild(
      trackProviderInstallationWork(
        id,
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ),
    );
    yield* Deferred.await(ready);
    const update = yield* Effect.forkChild(
      withProviderInstallationIdle([id], Effect.die("must not activate")),
    );
    yield* Fiber.interrupt(update);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(worker);
    expect(yield* trackProviderInstallationWork(id, Effect.succeed("recovered"))).toBe("recovered");
  }),
);
