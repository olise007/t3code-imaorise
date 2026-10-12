import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as DesktopBackgroundRuntime from "./DesktopBackgroundRuntime.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

export const listen = Effect.gen(function* () {
  const runtime = yield* DesktopBackgroundRuntime.DesktopBackgroundRuntime;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  yield* publisher.runtimeRequests.pipe(
    Stream.runForEach((request) =>
      Effect.gen(function* () {
        const { action, settings } = request.input;
        const result = yield* (
          action === "get"
            ? runtime.getSettings
            : action === "set" && settings
              ? runtime.setSettings(settings)
              : action === "start"
                ? runtime.setRunning(true)
                : action === "stop"
                  ? runtime.setRunning(false)
                  : Effect.die("Background settings are required.")
        ).pipe(Effect.exit);
        yield* publisher.publishRuntimeReport({
          version: 1,
          type: "desktopRuntimeReport",
          requestId: request.requestId,
          ...(result._tag === "Success"
            ? { settings: result.value }
            : { error: "Could not manage the desktop background server. Check the host logs." }),
        });
      }),
    ),
    Effect.forkScoped,
  );
});
