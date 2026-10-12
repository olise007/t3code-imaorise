import type { DesktopBackgroundSettings, DesktopBackgroundSettingsPatch } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";

export class DesktopBackgroundError extends Schema.TaggedError<DesktopBackgroundError>()(
  "DesktopBackgroundError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
const decodePolicy = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ keepAgentsRunning: Schema.Boolean })),
);

export class DesktopBackgroundRuntime extends Context.Service<
  DesktopBackgroundRuntime,
  {
    readonly getSettings: Effect.Effect<DesktopBackgroundSettings, DesktopBackgroundError>;
    readonly setSettings: (
      settings: DesktopBackgroundSettingsPatch,
    ) => Effect.Effect<
      DesktopBackgroundSettings,
      DesktopAppSettings.DesktopSettingsWriteError | DesktopBackgroundError
    >;
    readonly setRunning: (
      running: boolean,
    ) => Effect.Effect<DesktopBackgroundSettings, DesktopBackgroundError>;
  }
>()("@t3tools/desktop/wsl/DesktopBackgroundRuntime") {}

export const layer = Layer.effect(
  DesktopBackgroundRuntime,
  Effect.gen(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const wsl = yield* DesktopWslBackend.DesktopWslBackend;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const invoke = (config: DesktopBackendStartConfig, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(config.executablePath, args, {
              env: config.env,
              extendEnv: false,
              cwd: config.cwd,
            }),
          );
          const output = yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (tail, chunk) => (tail + chunk).slice(-4096),
            ),
          );
          if (Number(yield* handle.exitCode) !== 0)
            return yield* new DesktopBackgroundError({
              reason: "Could not manage the WSL background server. Check its status and retry.",
            });
          return output.trim();
        }),
      ).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(
          () =>
            new DesktopBackgroundError({
              reason:
                "The WSL background server did not respond. Retry after checking the selected distro.",
            }),
        ),
      );
    const selected = Effect.gen(function* () {
      const preferences = yield* settings.get;
      if (!preferences.wslBackendEnabled) return undefined;
      return preferences.wslBackendEnabled && preferences.wslOnly
        ? yield* pool.primary
        : (yield* pool.list).find(
            (instance) => instance.id === `wsl:${preferences.wslDistro ?? "default"}`,
          );
    });
    const getSettings = Effect.gen(function* () {
      const preferences = yield* settings.get;
      const instance = yield* selected;
      const distros = yield* wslEnvironment.listDistros;
      const distro =
        preferences.wslDistro ?? distros.find((distro) => distro.isDefault)?.name ?? "default";
      const config = instance
        ? yield* instance.currentConfig
        : Option.none<DesktopBackendStartConfig>();
      const resolvedDistro = Option.isSome(config)
        ? (config.value.runningDistro ?? distro)
        : distro;
      const inspection =
        Option.isSome(config) && config.value.managedInspectArgs
          ? yield* invoke(config.value, config.value.managedInspectArgs)
          : "";
      const policy = inspection
        ? yield* decodePolicy(inspection).pipe(
            Effect.mapError(
              () =>
                new DesktopBackgroundError({ reason: "The WSL runtime returned invalid status." }),
            ),
          )
        : null;
      return {
        closeToTray: preferences.closeToTray,
        minimizeToTray: preferences.minimizeToTray,
        distro: resolvedDistro,
        keepAgentsRunning:
          policy?.keepAgentsRunning ?? preferences.wslBackgroundAgents[resolvedDistro] ?? true,
        serverRunning: policy !== null || (instance ? (yield* instance.snapshot).ready : false),
      };
    });
    return DesktopBackgroundRuntime.of({
      getSettings,
      setSettings: (input) =>
        Effect.gen(function* () {
          const current = yield* getSettings;
          if (input.distro !== undefined && input.distro !== current.distro)
            return yield* new DesktopBackgroundError({
              reason: "The selected WSL environment changed. Refresh settings before retrying.",
            });
          const instance = yield* selected;
          const config = instance
            ? yield* instance.currentConfig
            : Option.none<DesktopBackendStartConfig>();
          if (
            input.keepAgentsRunning !== undefined &&
            Option.isSome(config) &&
            config.value.managedPolicyArgs
          ) {
            yield* invoke(config.value, [
              ...config.value.managedPolicyArgs,
              String(input.keepAgentsRunning),
            ]);
          }
          // The renderer cannot accidentally update a different selected distro.
          yield* settings
            .setBackgroundSettings({ ...current, ...input, distro: current.distro })
            .pipe(
              Effect.tapError(() =>
                input.keepAgentsRunning !== undefined &&
                Option.isSome(config) &&
                config.value.managedPolicyArgs
                  ? invoke(config.value, [
                      ...config.value.managedPolicyArgs,
                      String(current.keepAgentsRunning),
                    ]).pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
          return yield* getSettings;
        }),
      setRunning: (running) =>
        Effect.gen(function* () {
          if (running && !(yield* settings.get).wslBackendEnabled)
            return yield* new DesktopBackgroundError({
              reason: "Enable the WSL backend before starting its background server.",
            });
          if (running) yield* wsl.reconcile;
          const instance = yield* selected;
          if (instance) {
            if (running) {
              yield* instance.start;
              yield* instance.waitForReady(Duration.seconds(30));
            } else yield* instance.stop();
          }
          const result = yield* getSettings;
          if (!running && result.serverRunning)
            return yield* new DesktopBackgroundError({
              reason: "The WSL server is still shutting down. Retry after it stops.",
            });
          return result;
        }),
    });
  }),
);
