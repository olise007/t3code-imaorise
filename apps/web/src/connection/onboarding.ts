import {
  ConnectionOnboarding,
  EnvironmentRegistry,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import { serverEnvironment } from "../state/server";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();
const setupCancellations = new Map<string, () => Promise<unknown>>();
const setupKey = (target: DesktopSshEnvironmentTarget) => JSON.stringify(target);
export const cancelSshEnvironmentSetup = async (target: DesktopSshEnvironmentTarget) => {
  await setupCancellations.get(setupKey(target))?.();
};

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput, atoms) =>
    Effect.gen(function* () {
      const key = setupKey(input.target);
      let cancelled = false;
      let cancelCurrent = () =>
        window.desktopBridge?.cancelSshSetup?.(input.target) ?? Promise.resolve();
      const cancel = async () => {
        cancelled = true;
        await cancelCurrent();
      };
      setupCancellations.set(key, cancel);
      const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
      const crypto = yield* Crypto.Crypto;
      return yield* onboarding
        .registerSsh({
          ...input,
          afterRegistration: (environmentId, selectedProviders) =>
            Effect.gen(function* () {
              const operationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
              cancelCurrent = async () => {
                const result = await serverEnvironment.cancelSelectedProviderInstall.run(atoms, {
                  environmentId,
                  input: { operationId },
                });
                if (result._tag === "Failure")
                  throw new Error(
                    "Could not confirm cancellation. Check provider installation status in this environment's settings.",
                  );
              };
              yield* environments.stateChanges(environmentId).pipe(
                Stream.filter((state) => state.phase === "connected"),
                Stream.runHead,
                Effect.timeout("90 seconds"),
                Effect.mapError(
                  () =>
                    new ConnectionTransientError({
                      reason: "remote-unavailable",
                      detail:
                        "Environment saved, but it did not connect for provider setup. Reconnect and install providers explicitly in Settings.",
                    }),
                ),
              );
              if (cancelled)
                return yield* new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail:
                    "Environment saved; provider setup cancelled. Completed installations remain.",
                });
              const result = yield* Effect.promise(() =>
                serverEnvironment.installSelectedProviders.run(atoms, {
                  environmentId,
                  input: {
                    recipeRevision: 1,
                    operationId,
                    drivers: selectedProviders.map((driver) => ProviderDriverKind.make(driver)),
                  },
                }),
              );
              if (result._tag === "Failure")
                return yield* new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail:
                    "Environment saved, but selected provider setup did not complete. Open this environment's provider settings to review and retry. Sign-in is separate.",
                });
            }),
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (setupCancellations.get(key) === cancel) setupCancellations.delete(key);
            }),
          ),
        );
    }),
});
