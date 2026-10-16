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
import * as Stream from "effect/Stream";
import { serverEnvironment } from "../state/server";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

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
      const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
      return yield* onboarding.registerSsh({
        ...input,
        afterRegistration: (environmentId, selectedProviders) =>
          Effect.gen(function* () {
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
            const result = yield* Effect.promise(() =>
              serverEnvironment.installSelectedProviders.run(atoms, {
                environmentId,
                input: {
                  recipeRevision: 1,
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
      });
    }),
});
