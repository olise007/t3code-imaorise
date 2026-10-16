import {
  AntigravitySettings,
  CodexSettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstanceId,
  ProviderSetupError,
  type ProviderSetupInput,
  type ProviderInstallSelectedInput,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as ManagedProviderArchives from "./ManagedProviderArchives.ts";
import { PROVIDER_RECIPE_CATALOG } from "@t3tools/shared/providerInstallRecipes";

import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const isConfigObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);

/** Route instance setup to the environment-owned installer without owning the download. */
export const makeProviderInstallation = Effect.fn("makeProviderInstallation")(function* () {
  const antigravityInstallation = yield* AntigravityInstallation.AntigravityInstallation;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const archives = yield* ManagedProviderArchives.ManagedProviderArchives;

  const readEntries = Effect.fn("ProviderInstallation.readEntries")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "Could not read provider installation settings.",
          }),
      ),
    );
    return deriveProviderInstanceConfigMap(current);
  });

  const requireInstance = Effect.fn("ProviderInstallation.requireInstance")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    managedOnly = false,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    const isCodex = instance?.driverKind === ProviderDriverKind.make("codex");
    if (instance?.driverKind !== ANTIGRAVITY && !isCodex) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Managed installation is not available for this provider instance.",
      });
    }
    const installation = isCodex ? codexInstallation : antigravityInstallation;
    const entries = yield* readEntries(instanceId, operation);
    const invalidConfig = () =>
      new ProviderSetupError({
        instanceId,
        operation,
        detail: "The provider instance configuration is invalid.",
      });
    const config = isCodex
      ? yield* decodeCodexSettings(entries[instanceId]?.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        )
      : yield* decodeAntigravitySettings(entries[instanceId]?.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        );
    if (isCodex && (!("setupMode" in config) || config.setupMode !== "managed")) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Choose managed setup to install Codex in T3 Code.",
      });
    }
    if (managedOnly && config.binaryPath && (!isCodex || config.binaryPath !== "codex")) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          "This instance uses a custom executable. Clear its binary path to manage installation in T3 Code.",
      });
    }
    return { installation, driver: instance.driverKind };
  });

  const failure =
    (instanceId: ProviderInstanceId) =>
    (
      error:
        | AntigravityInstallation.AntigravityInstallationError
        | CodexInstallation.CodexInstallationError,
    ) =>
      new ProviderSetupError({ instanceId, operation: error.operation, detail: error.detail });

  const start = Effect.fn("ProviderInstallation.start")(function* (input: ProviderSetupInput) {
    const { installation } = yield* requireInstance(input.instanceId, "install", true);
    return yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)));
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    const { installation } = yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)));
  });

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      requireInstance(input.instanceId, "observe-install").pipe(
        Effect.map(({ installation }) => installation.changes),
      ),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    const { installation, driver } = yield* requireInstance(
      input.instanceId,
      "remove-install",
      true,
    );
    const entries = yield* readEntries(input.instanceId, "remove-install");
    const protectedPaths = yield* Effect.forEach(
      Object.values(entries),
      Effect.fnUntraced(function* (entry) {
        if (!hasBinaryPath(entry.config) || !entry.config.binaryPath.trim()) {
          return [];
        }
        const binaryPath = entry.config.binaryPath.trim();
        return yield* resolveCommandPath(binaryPath, {
          env: yield* mergeProviderInstanceEnvironment(entry.environment),
        }).pipe(
          Effect.map((resolved) => [binaryPath, resolved]),
          Effect.orElseSucceed(() => [binaryPath]),
        );
      }),
    );
    yield* installation
      .remove(protectedPaths.flat())
      .pipe(Effect.mapError(failure(input.instanceId)));
    const allInstances = yield* instances.listInstances;
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === driver),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    );
    return yield* installation.state;
  });

  const selected = Effect.fn("ProviderInstallation.selected")(function* (
    input: typeof ProviderInstallSelectedInput.Type,
  ) {
    const results: { driver: ProviderDriverKind; message: string }[] = [];
    for (const driver of [...new Set(input.drivers)]) {
      const recipe = PROVIDER_RECIPE_CATALOG.find((entry) => entry.driver === driver);
      const instanceId = defaultInstanceIdForDriver(driver);
      if (!recipe || !recipe.command)
        return yield* new ProviderSetupError({
          instanceId,
          operation: "install",
          detail: "Select a supported provider recipe or configure the registry agent separately.",
        });
      const entries = yield* readEntries(instanceId, "install");
      const entry = entries[instanceId];
      const config = isConfigObject(entry?.config) ? entry.config : {};
      const binaryPath = hasBinaryPath(config) ? config.binaryPath.trim() : "";
      const custom = binaryPath && binaryPath !== recipe.command;
      const existing = yield* resolveCommandPath(binaryPath || recipe.command, {
        env: yield* mergeProviderInstanceEnvironment(entry?.environment),
      }).pipe(Effect.option);
      if (custom || Option.isSome(existing)) {
        results.push({
          driver,
          message: custom
            ? "Custom executable preserved. Check its availability and sign in in provider settings."
            : "Existing executable preserved. Sign in in provider settings.",
        });
        yield* providers.refreshInstance(instanceId);
        continue;
      }
      let installed;
      if (driver === "codex" || driver === "antigravity") {
        if (driver === "antigravity") {
          const existingNode = yield* Effect.result(resolveNodeExecutable("Antigravity"));
          if (existingNode._tag === "Failure") yield* archives.ensureNode;
        }
        const installation = driver === "codex" ? codexInstallation : antigravityInstallation;
        const started = yield* installation.start.pipe(Effect.mapError(failure(instanceId)));
        installed = ["succeeded", "failed", "cancelled"].includes(started.phase)
          ? started
          : Option.getOrUndefined(
              yield* installation.changes
                .pipe(
                  Stream.filter((state) =>
                    ["succeeded", "failed", "cancelled"].includes(state.phase),
                  ),
                  Stream.runHead,
                )
                .pipe(
                  Effect.onInterrupt(() =>
                    started.operationId === null
                      ? Effect.void
                      : installation.cancel(started.operationId).pipe(Effect.ignore),
                  ),
                ),
            );
      } else {
        const started = yield* archives.start(driver);
        installed = ["succeeded", "failed", "cancelled"].includes(started.phase)
          ? started
          : Option.getOrUndefined(
              yield* archives
                .changes(driver)
                .pipe(
                  Stream.filter((state) =>
                    ["succeeded", "failed", "cancelled"].includes(state.phase),
                  ),
                  Stream.runHead,
                )
                .pipe(
                  Effect.onInterrupt(() =>
                    started.operationId === null
                      ? Effect.void
                      : archives.cancel(driver, started.operationId).pipe(Effect.asVoid),
                  ),
                ),
            );
      }
      if (installed?.phase !== "succeeded" || !installed.executablePath)
        return yield* new ProviderSetupError({
          instanceId,
          operation: "install",
          detail:
            installed?.message ??
            "Provider installation did not complete. Retry explicitly from provider settings.",
        });
      // Re-read before saving so an executable selected during the download is preserved.
      const latest = (yield* readEntries(instanceId, "install"))[instanceId];
      const latestConfig = isConfigObject(latest?.config) ? latest.config : {};
      if (
        hasBinaryPath(latestConfig) &&
        latestConfig.binaryPath.trim() &&
        latestConfig.binaryPath !== recipe.command
      ) {
        results.push({
          driver,
          message: "Managed download completed; a newer custom executable setting was preserved.",
        });
        continue;
      }
      yield* settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...(latest ?? { driver }),
            driver,
            config: {
              ...latestConfig,
              ...(driver === "codex" ? { setupMode: "managed" } : {}),
              binaryPath: driver === "codex" ? "codex" : installed.executablePath,
            },
          },
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "configure",
                detail:
                  "The provider was installed but its settings could not be saved. Configure its executable in provider settings.",
              }),
          ),
        );
      yield* providers.refreshInstance(instanceId);
      results.push({
        driver,
        message: "Installed and discovered. Sign in separately in provider settings.",
      });
    }
    return results;
  });
  return { start, cancel, subscribe, remove, selected };
});
