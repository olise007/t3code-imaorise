import {
  DesktopRuntimeError,
  type DesktopRuntimeRequestInput,
  type DesktopBackgroundSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { runManagedRuntimeAction } from "../desktopRuntime.ts";

export class DesktopRuntimeManagement extends Context.Service<
  DesktopRuntimeManagement,
  {
    readonly run: (
      input: DesktopRuntimeRequestInput,
    ) => Effect.Effect<DesktopBackgroundSettings, DesktopRuntimeError>;
  }
>()("t3/desktopUpdate/DesktopRuntimeManagement") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  return DesktopRuntimeManagement.of({
    run: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (
            environment.T3CODE_MANAGED_RUNTIME_DIRECTORY &&
            environment.T3CODE_MANAGED_RUNTIME_ID
          ) {
            return yield* Effect.tryPromise({
              try: () =>
                runManagedRuntimeAction(input, {
                  directory: environment.T3CODE_MANAGED_RUNTIME_DIRECTORY!,
                  nonce: environment.T3CODE_MANAGED_RUNTIME_ID!,
                  distro: environment.WSL_DISTRO_NAME ?? "WSL",
                }),
              catch: () =>
                new DesktopRuntimeError({
                  reason:
                    "Could not verify or manage this WSL background server. Check its runtime status and retry.",
                }),
            });
          }
          if (config.desktopTelemetryControlFd === undefined)
            return yield* new DesktopRuntimeError({
              reason:
                "Connect to the desktop host environment to manage its WSL server. Desktop must be running.",
            });
          const requestId = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              () =>
                new DesktopRuntimeError({
                  reason: "Could not create a runtime management request.",
                }),
            ),
          );
          const result = yield* Deferred.make<DesktopBackgroundSettings, DesktopRuntimeError>();
          const reports = yield* receiver.runtimeReports;
          yield* reports.pipe(
            Stream.runForEach((report) =>
              report.requestId !== requestId
                ? Effect.void
                : report.settings
                  ? Deferred.succeed(result, report.settings).pipe(Effect.asVoid)
                  : Deferred.fail(
                      result,
                      new DesktopRuntimeError({
                        reason: report.error ?? "Background server management failed.",
                      }),
                    ).pipe(Effect.asVoid),
            ),
            Effect.forkScoped,
          );
          yield* receiver
            .requestRuntime({ version: 1, type: "desktopRuntimeRequest", requestId, input })
            .pipe(
              Effect.mapError(
                () => new DesktopRuntimeError({ reason: "Desktop is disconnected." }),
              ),
            );
          return yield* Deferred.await(result).pipe(
            Effect.timeoutOrElse({
              duration: "45 seconds",
              orElse: () =>
                Effect.fail(
                  new DesktopRuntimeError({
                    reason: "Desktop did not respond. Check its connection before retrying.",
                  }),
                ),
            }),
          );
        }),
      ),
  });
});
export const layer = Layer.effect(DesktopRuntimeManagement, make);
