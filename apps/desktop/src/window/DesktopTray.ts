import { Tray, Menu } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopBackgroundRuntime from "../wsl/DesktopBackgroundRuntime.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { requestStopServersOnExit } from "../wsl/backgroundRuntimePolicy.ts";
import { beginTrayQuit, setTrayAvailable } from "./trayWindowPolicy.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly configure: Effect.Effect<void, never, import("effect/Scope").Scope>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-tray");
export const layer = Layer.effect(
  DesktopTray,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const assets = yield* DesktopAssets.DesktopAssets;
    const window = yield* DesktopWindow.DesktopWindow;
    const runtime = yield* DesktopBackgroundRuntime.DesktopBackgroundRuntime;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const app = yield* ElectronApp.ElectronApp;
    const context = yield* Effect.context<never>();
    const run = <E>(effect: Effect.Effect<void, E>) => {
      void Effect.runPromiseWith(context)(
        effect.pipe(Effect.catchCause(() => logWarning("tray action failed"))),
      );
    };
    return DesktopTray.of({
      configure: Effect.gen(function* () {
        if (environment.platform !== "win32") return;
        const icons = yield* assets.iconPaths;
        const icon = Option.orElse(icons.ico, () => icons.png);
        if (Option.isNone(icon)) return;
        const tray = yield* Effect.try(() => new Tray(icon.value)).pipe(Effect.option);
        if (Option.isNone(tray)) {
          yield* logWarning("tray unavailable; keeping normal window behavior");
          return;
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            setTrayAvailable(false);
            tray.value.destroy();
          }),
        );
        yield* app.on("before-quit", beginTrayQuit);
        yield* app.onBeforeQuitForUpdate(beginTrayQuit);
        setTrayAvailable(true);
        tray.value.setToolTip(environment.displayName);
        tray.value.on("click", () => run(window.activate));
        tray.value.on("right-click", () =>
          run(
            Effect.gen(function* () {
              const state = yield* runtime.getSettings.pipe(Effect.orElseSucceed(() => null));
              const instances = yield* pool.list;
              const statuses = yield* Effect.forEach(instances, (instance) =>
                Effect.gen(function* () {
                  const snapshot = yield* instance.snapshot;
                  return {
                    label: `${instance.id}: ${snapshot.ready ? "Running" : snapshot.desiredRunning ? "Connecting" : "Stopped"}`,
                    enabled: false,
                  };
                }),
              );
              tray.value.popUpContextMenu(
                Menu.buildFromTemplate([
                  { label: "Show app", click: () => run(window.activate) },
                  {
                    label: "Settings",
                    click: () => run(window.dispatchMenuAction("open-settings", { reveal: true })),
                  },
                  { type: "separator" },
                  ...statuses,
                  {
                    label: state?.serverRunning
                      ? "Stop background server"
                      : "Start background server",
                    enabled: state !== null,
                    click: () => {
                      if (state) run(runtime.setRunning(!state.serverRunning).pipe(Effect.asVoid));
                    },
                  },
                  { type: "separator" },
                  { label: "Exit", click: () => run(app.quit) },
                  {
                    label: "Exit and stop servers",
                    click: () => {
                      requestStopServersOnExit();
                      run(app.quit);
                    },
                  },
                ]),
              );
            }),
          ),
        );
      }),
    });
  }),
);
