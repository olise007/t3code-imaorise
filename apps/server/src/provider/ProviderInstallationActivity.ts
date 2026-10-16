import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

// Process-local leases cover actual runtime scopes, including custom paths into
// managed installations. No process-name guessing or provider interruption.
const counts = new Map<string, number>();
const blocked = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of [...listeners]) listener();
};
const wait = (ready: () => boolean) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (ready()) {
        listeners.delete(check);
        resume(Effect.void);
      }
    };
    listeners.add(check);
    check();
    return Effect.sync(() => {
      listeners.delete(check);
    });
  });
const enter = (id: string, acquired: () => void) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (blocked.has(id)) return;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      acquired();
      listeners.delete(check);
      resume(Effect.void);
    };
    listeners.add(check);
    check();
    return Effect.sync(() => {
      listeners.delete(check);
    });
  });
const leave = (id: string) =>
  Effect.sync(() => {
    const remaining = (counts.get(id) ?? 1) - 1;
    if (remaining > 0) counts.set(id, remaining);
    else counts.delete(id);
    changed();
  });
export const withProviderInstallationIdle = <A, E, R>(
  ids: readonly ProviderInstanceId[],
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      for (const id of ids) blocked.add(id);
    }),
    () => wait(() => ids.every((id) => !counts.has(id))).pipe(Effect.andThen(effect)),
    () =>
      Effect.sync(() => {
        for (const id of ids) blocked.delete(id);
        changed();
      }),
  );
export const reserveProviderInstallationIdle = (ids: readonly ProviderInstanceId[]) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      for (const id of ids) blocked.add(id);
    }),
    () =>
      Effect.sync(() => {
        for (const id of ids) blocked.delete(id);
        changed();
      }),
  ).pipe(Effect.andThen(wait(() => ids.every((id) => !counts.has(id)))));

export const trackProviderInstallationWork = <A, E, R>(
  id: ProviderInstanceId,
  task: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    let acquired = false;
    return Effect.acquireUseRelease(
      Effect.interruptible(
        enter(id, () => {
          acquired = true;
        }),
      ).pipe(Effect.onInterrupt(() => (acquired ? leave(id) : Effect.void))),
      () => task,
      () => leave(id),
    );
  });

export const protectProviderInstallation = Effect.fn("protectProviderInstallation")(function* (
  instance: ProviderInstance,
) {
  const id = instance.instanceId;
  const track = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trackProviderInstallationWork(id, effect);
  const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let acquired = false;
      return Effect.acquireRelease(
        Effect.interruptible(
          enter(id, () => {
            acquired = true;
          }),
        ).pipe(Effect.onInterrupt(() => (acquired ? leave(id) : Effect.void))),
        () => leave(id),
      ).pipe(Effect.andThen(effect));
    });
  if (instance.auth) {
    let active = false;
    const auth = instance.auth;
    yield* Effect.addFinalizer(() => (active ? leave(id) : Effect.void));
    yield* auth.subscribe("installation-activity").pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          const changing = yield* (
            auth.isChangingCredentials ??
              Effect.succeed(["starting", "waiting", "verifying"].includes(state.phase))
          );
          if (changing === active) return;
          active = changing;
          if (changing)
            yield* Effect.sync(() => {
              counts.set(id, (counts.get(id) ?? 0) + 1);
            });
          else yield* leave(id);
        }),
      ),
      Effect.forkScoped,
    );
  }
  const generation = instance.textGeneration;
  return {
    ...instance,
    orchestrationAdapter: {
      ...instance.orchestrationAdapter,
      openSession: (input) => scoped(instance.orchestrationAdapter.openSession(input)),
    },
    textGeneration: {
      generateCommitMessage: (input) => track(generation.generateCommitMessage(input)),
      generatePrContent: (input) => track(generation.generatePrContent(input)),
      generateBranchName: (input) => track(generation.generateBranchName(input)),
      generateThreadTitle: (input) => track(generation.generateThreadTitle(input)),
      generateReviewGuide: (input) => track(generation.generateReviewGuide(input)),
    },
    ...(instance.auth
      ? {
          auth: {
            ...instance.auth,
            start: (...args: Parameters<NonNullable<ProviderInstance["auth"]>["start"]>) =>
              track(instance.auth!.start(...args)),
          },
        }
      : {}),
  } satisfies ProviderInstance;
});
