import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { DesktopRuntimeReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as Receiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as Management from "./DesktopRuntimeManagement.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const settings = {
  closeToTray: true,
  minimizeToTray: false,
  distro: "Ubuntu",
  keepAgentsRunning: true,
  serverRunning: true,
};
it.effect("subscribes before sending, correlates reports, and returns host settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), "/tmp/t3-runtime-management-test")),
      );
      const reports = yield* PubSub.unbounded<DesktopRuntimeReport>();
      const management = yield* Management.DesktopRuntimeManagement.pipe(
        Effect.provide(
          Management.layer.pipe(
            Layer.provide(
              Receiver.layerTest({
                runtimeReports: Effect.map(PubSub.subscribe(reports), Stream.fromSubscription),
                requestRuntime: (request) =>
                  Effect.gen(function* () {
                    yield* PubSub.publish(reports, {
                      version: 1,
                      type: "desktopRuntimeReport",
                      requestId: "unrelated",
                      error: "ignore",
                    });
                    yield* PubSub.publish(reports, {
                      version: 1,
                      type: "desktopRuntimeReport",
                      requestId: request.requestId,
                      settings,
                    });
                  }),
              }),
            ),
            Layer.provide(ServerConfig.layer({ ...config, desktopTelemetryControlFd: 5 })),
          ),
        ),
      );
      expect(yield* management.run({ action: "get" })).toEqual(settings);
    }),
  ).pipe(Effect.provideService(HostProcess.Environment, {}), Effect.provide(NodeServices.layer)),
);

it.effect("reports unavailable on a standalone unmanaged environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* Management.DesktopRuntimeManagement.pipe(
        Effect.provide(
          Management.layer.pipe(
            Layer.provide(Receiver.layerTest()),
            Layer.provide(ServerConfig.layerTest(process.cwd(), "/tmp/t3-runtime-management-test")),
          ),
        ),
      );
      const result = yield* management.run({ action: "stop" }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  ).pipe(Effect.provideService(HostProcess.Environment, {}), Effect.provide(NodeServices.layer)),
);
