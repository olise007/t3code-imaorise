import {
  ProviderInstanceId,
  ServerProviderUpdateError,
  type ServerProviderUpdateInput,
  type ProviderVersionCatalogInput,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ManagedProviderArchives from "./ManagedProviderArchives.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { makeProviderVersionCatalog } from "./ProviderVersionCatalog.ts";
import {
  reserveProviderInstallationIdle,
  withProviderInstallationIdle,
} from "./ProviderInstallationActivity.ts";

const configObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const CodexRecord = Schema.Struct({
  version: Schema.String,
  target: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeCodexRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexRecord));

/** Coordinates approval, immutable staging, ownership checks, and activation in the destination environment. */
export const makeProviderVersionManager = Effect.fn("ProviderVersionManager.make")(function* () {
  const catalog = yield* makeProviderVersionCatalog();
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const codex = yield* CodexInstallation.CodexInstallation;
  const archives = yield* ManagedProviderArchives.ManagedProviderArchives;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const maintenance = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const identify = Effect.fn("ProviderVersionManager.identify")(function* (
    instance: ProviderInstanceConfig,
  ) {
    const value = configObject(instance.config) ? instance.config : {};
    if (instance.driver === "codex" && value.setupMode === "managed")
      return { kind: "codex" as const, key: codex.managedDirectory, binary: null };
    const binary =
      typeof value.binaryPath === "string" && path.isAbsolute(value.binaryPath)
        ? value.binaryPath
        : null;
    if (!binary) return null;
    const real = yield* fs.realPath(binary).pipe(Effect.option);
    if (Option.isNone(real)) return null;
    const codexRoot = yield* fs
      .realPath(codex.managedDirectory)
      .pipe(Effect.orElseSucceed(() => codex.managedDirectory));
    if (real.value.startsWith(`${codexRoot}${path.sep}`)) {
      const directory = path.dirname(path.dirname(real.value));
      const record = yield* fs
        .readFileString(path.join(directory, ".install-complete.json"))
        .pipe(Effect.flatMap(decodeCodexRecord), Effect.option);
      if (
        Option.isNone(record) ||
        path.basename(directory) !== record.value.version ||
        path.basename(real.value).replace(/\.exe$/i, "") !== "codex"
      )
        return null;
      return { kind: "codex" as const, key: codex.managedDirectory, binary: real.value };
    }
    const root = path.join(config.baseDir, "tools", "provider-archives", instance.driver);
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (!real.value.startsWith(`${realRoot}${path.sep}`)) return null;
    const marker = yield* fs
      .readFileString(path.join(path.dirname(real.value), ".recipe-integrity"))
      .pipe(Effect.option);
    if (
      Option.isNone(marker) ||
      !/^(?:sha256:[a-f0-9]{64}|sha512-[A-Za-z0-9+/]+=*)$/.test(marker.value.trim())
    )
      return null;
    return { kind: "archive" as const, key: real.value, binary: real.value };
  });
  const describe = Effect.fn("ProviderVersionManager.describe")(function* (input: {
    instanceId: ProviderInstanceId;
    provider: ServerProviderUpdateInput["provider"];
  }) {
    const current = yield* settings.getSettings;
    const entries = deriveProviderInstanceConfigMap(current);
    const entry = entries[input.instanceId];
    if (!entry || entry.driver !== input.provider)
      return yield* new ServerProviderUpdateError({
        provider: input.provider,
        reason: "The selected provider instance changed. Refresh provider settings.",
      });
    const installation = yield* identify(entry);
    const affected = installation
      ? yield* Effect.forEach(Object.entries(entries), ([id, instance]) =>
          identify(instance).pipe(
            Effect.map((other) =>
              other?.key === installation.key ? ProviderInstanceId.make(id) : null,
            ),
          ),
        ).pipe(Effect.map((ids) => ids.filter((id) => id !== null)))
      : [input.instanceId];
    return { current, entries, entry, installation, affected };
  });
  const page = (input: ProviderVersionCatalogInput) =>
    Effect.gen(function* () {
      const result = yield* catalog.page(input);
      const group = yield* describe(input);
      const selected =
        group.installation?.kind === "codex"
          ? yield* fs.readFileString(path.join(codex.managedDirectory, "active.json")).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
                ),
              ),
              Effect.map((record) => record.version),
              Effect.orElseSucceed(() => null),
            )
          : group.installation?.binary
            ? path.basename(path.dirname(group.installation.binary))
            : null;
      return {
        ...result,
        selectedVersion: selected,
        affectedInstances: group.affected.map((id) => group.entries[id]?.displayName || id),
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderUpdateError({
            provider: input.provider,
            reason:
              cause instanceof Error
                ? cause.message
                : "Could not inspect the selected installation.",
          }),
      ),
    );
  const update = (input: ServerProviderUpdateInput) =>
    Effect.gen(function* () {
      const instanceId = input.instanceId ?? ProviderInstanceId.make(input.provider);
      const initial = yield* describe({ ...input, instanceId });
      if (!initial.installation && !input.expectedIntegrity)
        return yield* maintenance.updateProvider(input);
      if (!input.targetVersion || !input.expectedIntegrity)
        return yield* new ServerProviderUpdateError({
          provider: input.provider,
          reason:
            "Choose a version and review its exact artifact before updating a managed installation.",
        });
      const selected = yield* catalog.resolve(input.provider, input.targetVersion);
      if (
        !selected.release.available ||
        !selected.artifact ||
        selected.release.integrity !== input.expectedIntegrity ||
        (selected.release.compatibility === "unknown" && !input.allowUnknownCompatibility)
      )
        return yield* new ServerProviderUpdateError({
          provider: input.provider,
          reason:
            selected.release.reason ??
            "The artifact changed or unknown compatibility needs confirmation. Check for updates and review the version again.",
        });
      if (!initial.installation) return yield* maintenance.updateProvider(input);
      const installation = initial.installation;
      return yield* locks.withLock(
        installation.key,
        Effect.gen(function* () {
          const state = (message: string, status: "running" | "failed" | "succeeded" = "running") =>
            providers
              .setProviderMaintenanceActionState({
                instanceId,
                action: "update",
                state: { status, startedAt: null, finishedAt: null, message, output: null },
              })
              .pipe(Effect.asVoid);
          const verifySettings = Effect.gen(function* () {
            const current = yield* settings.getSettings;
            if (!Equal.equals(current.providerInstances, initial.current.providerInstances))
              return yield* new ServerProviderUpdateError({
                provider: input.provider,
                reason:
                  "Provider settings changed during download. The previous selection is unchanged; review the version again.",
              });
            const latest = yield* identify(initial.entry);
            if (latest?.key !== installation.key)
              return yield* new ServerProviderUpdateError({
                provider: input.provider,
                reason: "Installation ownership changed during download. Nothing was activated.",
              });
          });
          yield* state(`Downloading and verifying ${input.provider} ${input.targetVersion}`);
          yield* Effect.gen(function* () {
            if (selected.artifact!.kind === "codex" && installation.kind === "codex") {
              if (!codex.startVersion)
                return yield* new ServerProviderUpdateError({
                  provider: input.provider,
                  reason:
                    "This server cannot activate a selected Codex version. Update T3 Code first.",
                });
              const started = yield* codex.startVersion(
                selected.artifact!.asset,
                input.allowUnknownCompatibility === true,
                Effect.gen(function* () {
                  yield* state("Ready—waiting for running work");
                  yield* reserveProviderInstallationIdle(initial.affected);
                  yield* verifySettings;
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CodexInstallation.CodexInstallationError({
                        operation: "activate",
                        detail:
                          cause instanceof Error ? cause.message : "Installation settings changed.",
                      }),
                  ),
                ),
              );
              const finished = yield* codex.changes.pipe(
                Stream.filter(
                  (state) =>
                    state.operationId === started.operationId &&
                    ["succeeded", "failed", "cancelled"].includes(state.phase),
                ),
                Stream.runHead,
              );
              if (
                Option.isNone(finished) ||
                finished.value.phase !== "succeeded" ||
                finished.value.installedVersion !== input.targetVersion
              )
                return yield* new ServerProviderUpdateError({
                  provider: input.provider,
                  reason: Option.isSome(finished)
                    ? (finished.value.message ??
                      "The selected Codex version could not be activated.")
                    : "Codex installation did not finish.",
                });
            } else if (selected.artifact!.kind === "archive" && installation.kind === "archive") {
              if (!archives.prepare || !settings.activateProviderInstallation)
                return yield* new ServerProviderUpdateError({
                  provider: input.provider,
                  reason: "Update T3 Code to activate this provider version.",
                });
              const binary = yield* archives.prepare(selected.artifact!.recipe);
              yield* state("Ready—waiting for running work");
              yield* withProviderInstallationIdle(
                initial.affected,
                Effect.gen(function* () {
                  yield* verifySettings;
                  const replacements: Record<string, ProviderInstanceConfig> = {};
                  for (const id of initial.affected) {
                    const previous = initial.entries[id]!;
                    replacements[id] = {
                      ...previous,
                      config: {
                        ...(configObject(previous.config) ? previous.config : {}),
                        binaryPath: binary,
                      },
                    };
                  }
                  yield* settings.activateProviderInstallation!(
                    initial.current.providerInstances,
                    replacements,
                  );
                }),
              );
            } else
              return yield* new ServerProviderUpdateError({
                provider: input.provider,
                reason:
                  "This installation cannot activate the selected artifact. Use its existing installer or provider instructions; T3 will not substitute a different runtime.",
              });
            yield* providers.refresh(input.provider);
            yield* state(
              `Activated ${input.targetVersion}. Account credentials are unchanged.`,
              "succeeded",
            );
          }).pipe(
            Effect.tapError(() =>
              state(
                "The update failed. The previous selection is retained; review installation details before retrying.",
                "failed",
              ),
            ),
          );
          return { providers: yield* providers.getProviders };
        }),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderUpdateError({
            provider: input.provider,
            reason:
              cause instanceof Error
                ? cause.message
                : "Provider update failed; the previous selection was retained.",
          }),
      ),
    );
  return { page, update };
});
