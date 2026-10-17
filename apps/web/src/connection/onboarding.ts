import {
  ConnectionOnboarding,
  EnvironmentRegistry,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import { sanitizeSetupOutput } from "@t3tools/shared/setupDetails";

import { connectionAtomRuntime } from "./runtime";
import { sshSetupProgress, sshSetupTargetKey } from "./sshSetupProgress";

const onboardingScheduler = createAtomCommandScheduler();
const setupCancellations = new Map<string, () => Promise<unknown>>();
const setupKey = sshSetupTargetKey;
const isConnectionTransientError = Schema.is(ConnectionTransientError);
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
      const cancellation = yield* Deferred.make<void>();
      let cancelRegistration = Effect.void;
      const completed = yield* Deferred.make<void>();
      const cancelCurrent = () =>
        window.desktopBridge?.cancelSshSetup?.(input.target, progressId) ?? Promise.resolve();
      const cancel = async () => {
        cancelled = true;
        sshSetupProgress.append(
          progressId,
          "Cancellation requested; completed installations are retained.",
        );
        await Effect.runPromise(Deferred.succeed(cancellation, undefined));
        await cancelCurrent().finally(() => Effect.runPromise(Deferred.await(completed)));
      };
      setupCancellations.set(key, cancel);
      const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
      return yield* Effect.gen(function* () {
        if ((input.credentials || input.testOnly) && window.desktopBridge) {
          if (!window.desktopBridge.sshConnectionCapabilities?.().authenticationPreflight)
            return yield* new ConnectionTransientError({
              reason: "remote-unavailable",
              detail:
                "Update the desktop client before testing SSH authentication or using a manual SSH profile.",
            });
          const bootstrap = yield* Effect.tryPromise({
            try: () =>
              window.desktopBridge!.ensureSshEnvironment(input.target, {
                testOnly: true,
                operationId: progressId,
                ...(input.credentials?.secret ? { authSecret: input.credentials.secret } : {}),
                rememberSecret: input.testOnly ? false : input.credentials?.remember === true,
              }),
            catch: (cause) =>
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail: `SSH authentication failed or was cancelled. ${sanitizeSetupOutput(cause instanceof Error ? cause.message : "Check the host fingerprint, username, and selected authentication method.").slice(0, 1200)}`,
              }),
          });
          for (const warning of bootstrap.setupWarnings ?? [])
            sshSetupProgress.append(progressId, warning);
        }
        if (cancelled) return yield* Effect.interrupt;
        if (input.testOnly) return;
        const environmentId = yield* onboarding.registerSsh({
          target: input.target,
          onRegistration: (cancel) =>
            Effect.sync(() => {
              cancelRegistration = cancel;
            }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.expectedEnvironmentId
            ? { expectedEnvironmentId: input.expectedEnvironmentId }
            : {}),
        });
        yield* environments.stateChanges(environmentId).pipe(
          Stream.filter(
            (state) =>
              state.phase === "connected" || state.phase === "blocked" || state.phase === "backoff",
          ),
          Stream.runHead,
          Effect.flatMap((state) =>
            state._tag === "Some" && state.value.phase === "connected"
              ? Effect.void
              : Effect.fail(
                  new ConnectionTransientError({
                    reason: "remote-unavailable",
                    detail:
                      state._tag === "Some"
                        ? (state.value.lastFailure?.message ??
                          "The saved environment could not connect.")
                        : "The saved environment connection ended.",
                  }),
                ),
          ),
          Effect.timeout("80 seconds"),
          Effect.mapError((cause) =>
            isConnectionTransientError(cause)
              ? cause
              : new ConnectionTransientError({
                  reason: "timeout",
                  detail:
                    "Environment saved, but connection readiness timed out. Review its connection status and retry.",
                }),
          ),
        );
        return environmentId;
      }).pipe(
        Effect.raceFirst(Deferred.await(cancellation).pipe(Effect.andThen(Effect.interrupt))),
        Effect.onExit(() => (cancelled ? cancelRegistration : Effect.void)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success" && !cancelled)
              sshSetupProgress.append(
                progressId,
                input.testOnly
                  ? "Authentication test passed. No remote runtime was installed or started."
                  : "Connected. Agent installation and sign-in are available separately in provider settings.",
              );
            else
              sshSetupProgress.append(
                progressId,
                cancelled
                  ? "Setup cancelled"
                  : sanitizeSetupOutput(
                      (() => {
                        const error =
                          exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined;
                        return error instanceof Error
                          ? error.message
                          : "Setup failed; completed work is retained.";
                      })(),
                    ),
              );
            sshSetupProgress.finish(
              progressId,
              cancelled ? "cancelled" : exit._tag === "Success" ? "succeeded" : "failed",
            );
            unsubscribe?.();
          }),
        ),
        Effect.ensuring(Deferred.succeed(completed, undefined)),
        Effect.ensuring(
          Effect.sync(() => {
            if (setupCancellations.get(key) === cancel) setupCancellations.delete(key);
          }),
        ),
      );
    }),
});
