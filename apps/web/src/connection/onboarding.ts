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
import { sshSetupProgress, sshSetupTargetKey } from "./sshSetupProgress";

const onboardingScheduler = createAtomCommandScheduler();
const setupCancellations = new Map<string, () => Promise<unknown>>();
const setupKey = sshSetupTargetKey;
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
  execute: (
    input: ConnectionOnboarding.SshConnectionInput & {
      readonly credentials?: { readonly secret: string; readonly remember: boolean };
      readonly testOnly?: boolean;
    },
    atoms,
  ) =>
    Effect.gen(function* () {
      const key = setupKey(input.target);
      const progressId = sshSetupProgress.begin(input.target);
      sshSetupProgress.append(progressId, "Starting SSH environment setup");
      let lastSequence = 0;
      const unsubscribe = window.desktopBridge?.onSshConnectionProgress?.(
        ({ target, stage, operationId, sequence }) => {
          if (operationId !== undefined) {
            if (operationId !== progressId || sequence === undefined || sequence <= lastSequence)
              return;
            lastSequence = sequence;
            sshSetupProgress.append(
              progressId,
              stage === "Connected" ? "Environment connected" : stage,
            );
            return;
          }
          if (
            target.alias === input.target.alias &&
            JSON.stringify(target.executionSource ?? { type: "local" }) ===
              JSON.stringify(input.target.executionSource ?? { type: "local" }) &&
            target.manual?.profileId === input.target.manual?.profileId &&
            (!target.manual || sshSetupTargetKey(target) === sshSetupTargetKey(input.target))
          )
            sshSetupProgress.append(
              progressId,
              stage === "Connected" ? "Environment connected" : stage,
            );
        },
      );
      let cancelled = false;
      let cancelCurrent = () =>
        window.desktopBridge?.cancelSshSetup?.(input.target) ?? Promise.resolve();
      const cancel = async () => {
        cancelled = true;
        sshSetupProgress.append(
          progressId,
          "Cancellation requested; completed installations are retained.",
        );
        await cancelCurrent();
      };
      setupCancellations.set(key, cancel);
      const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
      const crypto = yield* Crypto.Crypto;
      return yield* Effect.gen(function* () {
        if ((input.credentials || input.testOnly) && window.desktopBridge) {
          const bootstrap = yield* Effect.tryPromise({
            try: () =>
              window.desktopBridge!.ensureSshEnvironment(input.target, {
                testOnly: true,
                operationId: progressId,
                ...(input.credentials?.secret ? { authSecret: input.credentials.secret } : {}),
                rememberSecret: input.testOnly ? false : input.credentials?.remember === true,
              }),
            catch: () =>
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail:
                  "SSH authentication failed or was cancelled. Check the host fingerprint, username, and selected authentication method.",
              }),
          });
          for (const warning of bootstrap.setupWarnings ?? [])
            sshSetupProgress.append(progressId, warning);
        }
        if (input.testOnly) return;
        return yield* onboarding.registerSsh({
          target: input.target,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.expectedEnvironmentId
            ? { expectedEnvironmentId: input.expectedEnvironmentId }
            : {}),
          afterRegistration: (environmentId, selectedProviders) =>
            Effect.gen(function* () {
              sshSetupProgress.append(
                progressId,
                `Installing selected providers: ${selectedProviders.join(", ")}. Account sign-in is separate.`,
              );
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
              sshSetupProgress.append(
                progressId,
                "Selected provider installation complete. Sign in under this environment's provider settings.",
              );
            }),
        });
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success")
              sshSetupProgress.append(
                progressId,
                "Setup complete. Provider sign-in may still be required.",
              );
            else
              sshSetupProgress.append(
                progressId,
                cancelled
                  ? "Setup cancelled"
                  : "Setup failed. Review the connection error; completed work is retained.",
              );
            sshSetupProgress.finish(
              progressId,
              cancelled ? "cancelled" : exit._tag === "Success" ? "succeeded" : "failed",
            );
            unsubscribe?.();
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (setupCancellations.get(key) === cancel) setupCancellations.delete(key);
          }),
        ),
      );
    }),
});
