// @effect-diagnostics nodeBuiltinImport:off - Incremental artifact SHA-512 verification.
import {
  ProviderInstanceId,
  ServerProviderUpdateError,
  type ServerProviderUpdateInput,
  type ProviderVersionCatalogInput,
  type ProviderInstanceConfig,
  type ServerProviderUpdatedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { sanitizeSetupOutput } from "@t3tools/shared/setupDetails";
import { makeTargetedProviderUpdateAction } from "@t3tools/provider-core/server/maintenanceResolver";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { PROVIDER_RECIPE_CATALOG } from "@t3tools/shared/providerInstallRecipes";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerConfig from "../config.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
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
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const sessionManager = yield* Effect.serviceOption(
    ProviderSessionManager.ProviderSessionManagerV2,
  );
  const prepareIdle = (ids: readonly ProviderInstanceId[]) =>
    Option.isSome(sessionManager)
      ? (sessionManager.value.prepareInstallation?.(ids) ?? Effect.void)
      : Effect.void;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const codex = yield* CodexInstallation.CodexInstallation;
  const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
  const archives = yield* ManagedProviderArchives.ManagedProviderArchives;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const maintenance = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const scope = yield* Effect.scope;
  const operations = new Map<
    string,
    Fiber.Fiber<ServerProviderUpdatedPayload, ServerProviderUpdateError>
  >();
  const identify = Effect.fn("ProviderVersionManager.identify")(function* (
    instance: ProviderInstanceConfig,
  ) {
    const value = configObject(instance.config) ? instance.config : {};
    if (instance.driver === "codex" && value.setupMode === "managed")
      return { kind: "codex" as const, key: codex.managedDirectory, binary: null };
    if (
      instance.driver === "antigravity" &&
      !(typeof value.binaryPath === "string" && value.binaryPath.trim())
    )
      return { kind: "antigravity" as const, key: antigravity.managedDirectory, binary: null };
    const command =
      typeof value.binaryPath === "string" && value.binaryPath.trim()
        ? value.binaryPath
        : PROVIDER_RECIPE_CATALOG.find((recipe) => recipe.driver === instance.driver)?.command;
    const binary = command
      ? yield* resolveCommandPath(command, {
          env: yield* mergeProviderInstanceEnvironment(instance.environment),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.orElseSucceed(() => null),
        )
      : null;
    if (!binary) {
      if (
        !(typeof value.binaryPath === "string" && value.binaryPath.trim()) &&
        ["claudeAgent", "grok", "opencode", "pi"].includes(instance.driver)
      )
        return {
          kind: "archive" as const,
          key: path.join(config.baseDir, "tools", "provider-archives", instance.driver),
          binary: null,
        };
      return null;
    }
    const real = yield* fs.realPath(binary).pipe(Effect.option);
    if (Option.isNone(real)) return null;
    const antigRoot = yield* fs
      .realPath(antigravity.managedDirectory)
      .pipe(Effect.orElseSucceed(() => antigravity.managedDirectory));
    if (real.value.startsWith(`${antigRoot}${path.sep}`)) {
      const installed = yield* antigravity.resolve(real.value).pipe(Effect.option);
      return {
        kind:
          Option.isSome(installed) && installed.value.managedVersionDirectory
            ? ("antigravity" as const)
            : ("unverified" as const),
        key: antigravity.managedDirectory,
        binary: real.value,
      };
    }
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
        return { kind: "unverified" as const, key: codex.managedDirectory, binary: real.value };
      return { kind: "codex" as const, key: codex.managedDirectory, binary: real.value };
    }
    const root = path.join(config.baseDir, "tools", "provider-archives", instance.driver);
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (!real.value.startsWith(`${realRoot}${path.sep}`))
      return { kind: "external" as const, key: real.value, binary: real.value };
    const marker = yield* fs
      .readFileString(path.join(path.dirname(real.value), ".recipe-integrity"))
      .pipe(Effect.option);
    if (
      Option.isNone(marker) ||
      !/^(?:sha256:[a-f0-9]{64}|sha512-[A-Za-z0-9+/]+=*)$/.test(marker.value.trim())
    )
      return { kind: "unverified" as const, key: real.value, binary: real.value };
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
    const capabilities =
      installation?.kind === "external"
        ? yield* providers.getProviderMaintenanceCapabilitiesForInstance(
            input.instanceId,
            input.provider,
            { fresh: true },
          )
        : null;
    const officialPackages: Readonly<Record<string, readonly string[]>> = {
      codex: ["@openai/codex"],
      claudeAgent: ["@anthropic-ai/claude-code"],
      grok: ["@xai-official/grok"],
      opencode: ["@opencode/cli", "opencode-ai"],
      pi: ["@earendil-works/pi-coding-agent"],
    };
    const externalPackage =
      capabilities?.packageName &&
      officialPackages[input.provider]?.includes(capabilities.packageName)
        ? capabilities.packageName
        : undefined;
    return { current, entries, entry, installation, affected, capabilities, externalPackage };
  });
  const selectionPath = (key: string) =>
    path.join(
      config.baseDir,
      "tools",
      "provider-selections",
      `${NodeCrypto.createHash("sha256").update(key).digest("hex")}.json`,
    );
  const readSelection = (key: string) =>
    fs.readFileString(selectionPath(key)).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
        ),
      ),
      Effect.map((value) => value.version),
      Effect.orElseSucceed(() => null),
    );
  const page = (input: ProviderVersionCatalogInput) =>
    Effect.gen(function* () {
      const group = yield* describe(input);
      const result = yield* catalog.page(input, group.externalPackage);
      const externalUnsupported =
        group.installation?.kind === "external" &&
        (!group.externalPackage ||
          !group.capabilities ||
          !makeTargetedProviderUpdateAction(group.capabilities, "1.0.0") ||
          group.capabilities.update?.lockKey === "volta");
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
          : group.installation?.kind === "antigravity"
            ? yield* antigravity.resolve().pipe(
                Effect.map((value) => (value.managedVersionDirectory ? value.version : null)),
                Effect.orElseSucceed(() => null),
              )
            : group.installation?.kind === "archive" && group.installation.binary
              ? path.basename(path.dirname(group.installation.binary))
              : group.installation?.kind === "external"
                ? yield* readSelection(group.installation.key)
                : null;
      return {
        ...result,
        runtime: {
          platform,
          architecture,
          executablePath:
            group.installation?.binary ??
            (group.installation?.kind === "codex"
              ? yield* codex.resolve().pipe(
                  Effect.map((value) => value.executablePath),
                  Effect.orElseSucceed(() => null),
                )
              : null),
          ownership:
            group.installation === null
              ? ("not-installed" as const)
              : group.installation.kind === "external"
                ? ("external" as const)
                : group.installation.kind === "unverified"
                  ? ("unverified" as const)
                  : ("managed" as const),
          updateMethod:
            group.installation?.kind === "external"
              ? (group.capabilities?.update?.command ?? null)
              : group.installation?.kind === "unverified"
                ? null
                : "T3 verified version installer",
        },
        ...(externalUnsupported
          ? {
              message:
                "This external installation cannot safely activate a reviewed archive through its current updater. Use its package manager to install an exact version, or configure a T3-managed installation. Existing update commands remain available.",
              releases: result.releases.map((release) => ({
                ...release,
                available: false,
                reason: "Use the owning installer for this external executable.",
              })),
            }
          : {}),
        ...(group.installation?.kind === "unverified"
          ? {
              releases: result.releases.map((release) => ({
                ...release,
                available: false,
                reason:
                  "This executable is inside T3's tools directory, but its installation record could not be verified. Inspect the installation before changing it.",
              })),
            }
          : {}),
        selectedVersion: selected,
        affectedInstances: group.affected.map((id) => group.entries[id]?.displayName || id),
      };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ServerProviderUpdateError)(cause)
          ? cause
          : new ServerProviderUpdateError({
              provider: input.provider,
              reason:
                cause instanceof Error
                  ? cause.message
                  : "Could not inspect the selected installation.",
            }),
      ),
    );
  const runUpdate = (input: ServerProviderUpdateInput) =>
    Effect.gen(function* () {
      const instanceId = input.instanceId ?? ProviderInstanceId.make(input.provider);
      const initial = yield* describe({ ...input, instanceId });
      if (
        (!initial.installation || initial.installation.kind === "external") &&
        !input.expectedIntegrity
      )
        return yield* maintenance.updateProvider(input);
      if (!input.targetVersion || !input.expectedIntegrity)
        return yield* new ServerProviderUpdateError({
          provider: input.provider,
          reason:
            "Choose a version and review its exact artifact before updating a managed installation.",
        });
      const selected = yield* catalog.resolve(
        input.provider,
        input.targetVersion,
        initial.externalPackage,
      );
      if (
        selected.release.version !== input.targetVersion ||
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
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          const details: string[] = [];
          const state = (message: string, status: "running" | "failed" | "succeeded" = "running") =>
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              const safe = sanitizeSetupOutput(message).slice(0, 8192);
              details.push(`${now} ${safe}`);
              while (details.length > 2000 || details.join("\n").length > 65536) details.shift();
              yield* providers.setProviderMaintenanceActionState({
                instanceId,
                action: "update",
                state: {
                  status,
                  startedAt,
                  finishedAt: status === "running" ? null : now,
                  message: safe,
                  output: details.join("\n"),
                },
              });
            });
          const verifySettings = Effect.gen(function* () {
            const checked = yield* catalog.resolve(
              input.provider,
              input.targetVersion!,
              initial.externalPackage,
            );
            if (
              !checked.release.available ||
              checked.release.integrity !== input.expectedIntegrity ||
              (checked.release.compatibility === "unknown" && !input.allowUnknownCompatibility)
            )
              return yield* new ServerProviderUpdateError({
                provider: input.provider,
                reason:
                  "The official artifact or compatibility information changed during download. Nothing was activated; review this version again.",
              });
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
            if (selected.artifact!.kind === "package" && installation.kind === "external") {
              if (
                !initial.capabilities ||
                !makeTargetedProviderUpdateAction(initial.capabilities, input.targetVersion!) ||
                initial.capabilities.update?.lockKey === "volta"
              )
                return yield* new ServerProviderUpdateError({
                  provider: input.provider,
                  reason: "Use the owning installer to select this external version.",
                });
              const artifact = selected.artifact!;
              const staged = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-package-" });
              const archivePath = path.join(staged, "provider.tgz");
              const hash = NodeCrypto.createHash("sha512");
              let bytes = 0;
              const response = yield* http
                .execute(HttpClientRequest.get(artifact.url))
                .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
              yield* response.stream.pipe(
                Stream.tap((chunk) =>
                  Effect.gen(function* () {
                    bytes += chunk.byteLength;
                    if (bytes > 256 * 1024 * 1024)
                      return yield* new ServerProviderUpdateError({
                        provider: input.provider,
                        reason: "The selected package exceeds its download limit.",
                      });
                    hash.update(chunk);
                  }),
                ),
                Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
                Effect.timeout("5 minutes"),
              );
              if (`sha512-${hash.digest("base64")}` !== artifact.integrity)
                return yield* new ServerProviderUpdateError({
                  provider: input.provider,
                  reason:
                    "The selected package failed its integrity check. The previous installation is unchanged.",
                });
              yield* state("Ready—waiting for running work");
              yield* withProviderInstallationIdle(
                initial.affected,
                Effect.gen(function* () {
                  yield* verifySettings;
                  const capabilities =
                    yield* providers.getProviderMaintenanceCapabilitiesForInstance(
                      instanceId,
                      input.provider,
                      { fresh: true },
                    );
                  if (
                    !Equal.equals(capabilities.update, initial.capabilities!.update) ||
                    capabilities.packageName !== initial.externalPackage
                  )
                    return yield* new ServerProviderUpdateError({
                      provider: input.provider,
                      reason: "The owning package manager changed. Review the version again.",
                    });
                  const outcome = yield* maintenance.updateProvider({
                    ...input,
                    verifiedPackageArchive: archivePath,
                  });
                  const installed = outcome.providers.find(
                    (provider) => provider.instanceId === instanceId,
                  );
                  if (
                    installed?.updateState?.status !== "succeeded" ||
                    installed.version?.replace(/^v/, "") !== input.targetVersion
                  )
                    return yield* new ServerProviderUpdateError({
                      provider: input.provider,
                      reason:
                        installed?.updateState?.message ??
                        "The selected external version could not be verified. Its previous selection is retained.",
                    });
                  const record = selectionPath(installation.key);
                  yield* fs.makeDirectory(path.dirname(record), { recursive: true });
                  const temporary = `${record}.${yield* crypto.randomUUIDv4}.tmp`;
                  yield* fs.writeFileString(
                    temporary,
                    yield* Schema.encodeEffect(
                      Schema.fromJsonString(
                        Schema.Struct({
                          version: Schema.String,
                          integrity: Schema.String,
                          source: Schema.String,
                        }),
                      ),
                    )({
                      version: input.targetVersion!,
                      integrity: artifact.integrity,
                      source: artifact.url,
                    }),
                    { mode: 0o600, flag: "wx" },
                  );
                  yield* fs
                    .rename(temporary, record)
                    .pipe(
                      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
                    );
                }),
                prepareIdle(initial.affected),
              );
            } else if (selected.artifact!.kind === "codex" && installation.kind === "codex") {
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
                  yield* reserveProviderInstallationIdle(
                    initial.affected,
                    prepareIdle(initial.affected),
                  );
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
                Effect.gen(function* () {
                  const replacements: Record<string, ProviderInstanceConfig> = {};
                  for (const id of initial.affected) {
                    const previous = initial.entries[id]!;
                    const value = configObject(previous.config) ? previous.config : {};
                    if (value.setupMode !== "managed" && typeof value.binaryPath === "string")
                      replacements[id] = {
                        ...previous,
                        config: {
                          ...value,
                          binaryPath: path.join(
                            codex.managedDirectory,
                            input.targetVersion!,
                            "bin",
                            path.basename(value.binaryPath),
                          ),
                        },
                      };
                  }
                  if (Object.keys(replacements).length > 0) {
                    if (!settings.activateProviderInstallation)
                      return yield* new CodexInstallation.CodexInstallationError({
                        operation: "activate",
                        detail: "Update T3 Code before changing this shared installation.",
                      });
                    yield* settings.activateProviderInstallation(
                      initial.current.providerInstances,
                      replacements,
                    );
                  }
                }).pipe(
                  Effect.mapError(
                    () =>
                      new CodexInstallation.CodexInstallationError({
                        operation: "activate",
                        detail: "Provider settings changed; the previous selection was restored.",
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
            } else if (
              selected.artifact!.kind === "antigravity" &&
              installation.kind === "antigravity"
            ) {
              if (!antigravity.startVersion)
                return yield* new ServerProviderUpdateError({
                  provider: input.provider,
                  reason: "Update T3 Code before choosing an Antigravity version.",
                });
              yield* archives.ensureCompatibleNode;
              const asset = selected.artifact!.asset;
              const activationError = (cause: unknown) =>
                new AntigravityInstallation.AntigravityInstallationError({
                  operation: "activate",
                  detail:
                    cause instanceof Error
                      ? cause.message
                      : "Provider settings changed; the previous selection was restored.",
                });
              const started = yield* antigravity.startVersion(
                asset,
                Effect.gen(function* () {
                  yield* state("Ready—waiting for running work");
                  yield* reserveProviderInstallationIdle(
                    initial.affected,
                    prepareIdle(initial.affected),
                  );
                  yield* verifySettings;
                }).pipe(Effect.mapError(activationError)),
                Effect.gen(function* () {
                  const replacements: Record<string, ProviderInstanceConfig> = {};
                  for (const id of initial.affected) {
                    const previous = initial.entries[id]!;
                    const value = configObject(previous.config) ? previous.config : {};
                    if (typeof value.binaryPath === "string" && value.binaryPath.trim())
                      replacements[id] = {
                        ...previous,
                        config: {
                          ...value,
                          binaryPath: path.join(
                            antigravity.managedDirectory,
                            "versions",
                            asset.sha256,
                            asset.executable.name,
                          ),
                        },
                      };
                  }
                  if (Object.keys(replacements).length > 0) {
                    if (!settings.activateProviderInstallation)
                      return yield* activationError("Unsupported activation");
                    yield* settings.activateProviderInstallation(
                      initial.current.providerInstances,
                      replacements,
                    );
                  }
                }).pipe(Effect.mapError(activationError)),
              );
              const finished = yield* antigravity.changes.pipe(
                Stream.filter(
                  (value) =>
                    value.operationId === started.operationId &&
                    ["succeeded", "failed", "cancelled"].includes(value.phase),
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
                      "The selected Antigravity version could not be activated.")
                    : "Antigravity installation did not finish.",
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
                prepareIdle(initial.affected),
              );
            } else
              return yield* new ServerProviderUpdateError({
                provider: input.provider,
                reason:
                  "This installation cannot activate the selected artifact. Use its existing installer or provider instructions; T3 will not substitute a different runtime.",
              });
            yield* state(
              `Activated ${input.targetVersion}. Account credentials are unchanged.`,
              "succeeded",
            );
            yield* providers.refresh(input.provider);
          }).pipe(
            Effect.tapError((cause) =>
              state(
                `The update failed. ${sanitizeSetupOutput(cause instanceof Error ? cause.message : "Review installation details before retrying.").slice(0, 500)}`,
                "failed",
              ),
            ),
          );
          return { providers: yield* providers.getProviders };
        }),
      );
    }).pipe(
      Effect.scoped,
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
  const update = (input: ServerProviderUpdateInput) =>
    Effect.gen(function* () {
      const instanceId = input.instanceId ?? ProviderInstanceId.make(input.provider);
      const current = yield* describe({ ...input, instanceId });
      const key = current.installation?.key ?? `external:${instanceId}`;
      const fiber = yield* locks.withLock(
        `operation:${key}`,
        Effect.gen(function* () {
          if (operations.has(key))
            return yield* new ServerProviderUpdateError({
              provider: input.provider,
              reason:
                "An update is already running for this installation. View provider progress before starting another.",
            });
          const ready = yield* Deferred.make<void>();
          const worker = yield* Deferred.await(ready).pipe(
            Effect.andThen(runUpdate(input)),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                const snapshot = (yield* providers.getProviders).find(
                  (provider) => provider.instanceId === instanceId,
                );
                if (snapshot?.updateState?.status === "succeeded") return;
                yield* providers.setProviderMaintenanceActionState({
                  instanceId,
                  action: "update",
                  state: {
                    status: "failed",
                    startedAt: null,
                    finishedAt: null,
                    message:
                      "The update stopped before its completion status could be verified. Check the installed version before retrying.",
                    output: snapshot?.updateState?.output ?? null,
                  },
                });
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                operations.delete(key);
              }),
            ),
            Effect.forkIn(scope),
          );
          operations.set(key, worker);
          yield* Deferred.succeed(ready, undefined);
          return worker;
        }),
      );
      // Closing a dialog or disconnecting this client leaves the approved operation running.
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderUpdateError({
            provider: input.provider,
            reason:
              cause instanceof Error ? cause.message : "Could not start this provider update.",
          }),
      ),
    );
  return { page, update };
});
