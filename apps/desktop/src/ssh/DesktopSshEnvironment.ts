import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshExecutionSource,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget, targetConnectionKey } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as CryptoRuntime from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { SshSetupApproval } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly cancelSetup: (
      target: DesktopSshEnvironmentTarget,
      operationId?: string,
    ) => Effect.Effect<void>;
    readonly forgetCredentials?: (target: DesktopSshEnvironmentTarget) => Effect.Effect<void>;
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
      executionSource?: DesktopSshExecutionSource,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: {
        purpose?: "setup" | "reconnect";
        operationId?: string;
        authSecret?: string;
        rememberSecret?: boolean;
        testOnly?: boolean;
        readonly issuePairingToken?: boolean;
        resumeStoppedServer?: boolean;
        supportsSetupReview?: boolean;
      },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
    readonly stopEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
  readonly onProgress?: SshTunnel.SshEnvironmentManagerOptions["onProgress"];
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return Effect.flatMap(HostProcess.HomeDirectory, (homeDir) =>
    discoverSshHosts({ homeDir: input?.homeDir ?? homeDir }),
  );
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

export function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "T3 Code window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  reviewSetup: (review) =>
    prompts
      .request({
        destination: review.destination,
        username: null,
        attempt: 1,
        purpose: "setup-review",
        setupReview: review,
        prompt: "Review remote setup before installing requirements.",
      })
      .pipe(
        Effect.mapError(toSshPasswordPromptError),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(SshSetupApproval))(value),
        ),
        Effect.mapError(
          (cause) =>
            new SshPasswordPromptError({
              message: "Remote setup review was cancelled or invalid.",
              cause,
            }),
        ),
      ),
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const crypto = yield* CryptoRuntime.Crypto;
  const storage = yield* Effect.serviceOption(ElectronSafeStorage.ElectronSafeStorage);
  const safeStorage = Option.getOrUndefined(storage);
  const canSave = safeStorage
    ? yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.flatMap((available) =>
          safeStorage.selectedStorageBackend.pipe(
            Effect.map(
              (backend) =>
                available &&
                (platform !== "linux" || Option.isSome(backend)) &&
                Option.getOrUndefined(backend) !== "basic_text",
            ),
          ),
        ),
        Effect.orElseSucceed(() => false),
      )
    : false;
  const secretPath = (target: DesktopSshEnvironmentTarget) =>
    crypto.digest("SHA-256", new TextEncoder().encode(targetConnectionKey(target))).pipe(
      Effect.map((hash) =>
        path.join(home, ".t3-imaorise", "ssh", "secrets", `${Hex.encode(hash)}.encrypted`),
      ),
      Effect.orDie,
    );
  const setups = new Map<
    string,
    {
      operationId: string | undefined;
      fiber?: Fiber.Fiber<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
      cancelled: boolean;
      done: Deferred.Deferred<void>;
    }
  >();

  return DesktopSshEnvironment.of({
    forgetCredentials: (target) =>
      Effect.gen(function* () {
        if (!target.manual) return;
        const fiber = setups.get(targetConnectionKey(target));
        if (fiber?.fiber) yield* Fiber.interrupt(fiber.fiber);
        yield* manager.forgetAuthentication?.(target) ?? Effect.void;
        yield* fs.remove(yield* secretPath(target), { force: true }).pipe(Effect.orDie);
      }),
    cancelSetup: (target, operationId) =>
      Effect.gen(function* () {
        const operation = setups.get(targetConnectionKey(target));
        if (!operation || (operationId !== undefined && operation.operationId !== operationId))
          return;
        operation.cancelled = true;
        if (operation.fiber) yield* Fiber.interrupt(operation.fiber);
        yield* Deferred.await(operation.done);
      }),
    discoverHosts: (input) =>
      discoverDesktopSshHostsEffect(input).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.discoverHosts"),
      ),
    resolveHost: (alias, executionSource) =>
      resolveSshTarget(alias.trim(), executionSource).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.resolveHost"),
      ),
    ensureEnvironment: (target, ensureOptions) =>
      Effect.gen(function* () {
        const key = targetConnectionKey(target);
        const done = yield* Deferred.make<void>();
        if (setups.has(key))
          return yield* new SshLaunchError({
            message:
              "An SSH operation is already active for this profile. Wait for it to finish or cancel it before retrying.",
            stdout: "",
          });
        const operation: {
          operationId: string | undefined;
          fiber?: Fiber.Fiber<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
          cancelled: boolean;
          done: Deferred.Deferred<void>;
        } = { operationId: ensureOptions?.operationId, cancelled: false, done };
        setups.set(key, operation);
        return yield* Effect.gen(function* () {
          const file = yield* secretPath(target);
          const savedSecret =
            canSave && safeStorage && target.manual
              ? yield* fs
                  .readFile(file)
                  .pipe(Effect.flatMap(safeStorage.decryptString), Effect.option)
              : Option.none<string>();
          const authSecret = ensureOptions?.authSecret ?? Option.getOrUndefined(savedSecret);
          if (operation.cancelled)
            return yield* new SshPasswordPromptError({ message: "SSH operation cancelled." });
          const fiber = yield* manager
            .ensureEnvironment(target, {
              ...ensureOptions,
              ...(authSecret === undefined ? {} : { authSecret }),
            })
            .pipe(
              Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
              Effect.provide(runtimeContext),
              Effect.withSpan("desktop.ssh.ensureEnvironment"),
              Effect.forkChild,
            );
          operation.fiber = fiber;
          if (operation.cancelled) yield* Fiber.interrupt(fiber);
          const result = yield* Fiber.join(fiber);
          const verifiedSecret = manager.authenticatedSecret?.(result.target);
          if (target.manual && ensureOptions?.rememberSecret && verifiedSecret !== undefined) {
            const saved =
              canSave && safeStorage
                ? yield* Effect.gen(function* () {
                    const encrypted = yield* safeStorage.encryptString(verifiedSecret);
                    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
                    const temporary = `${file}.${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}.partial`;
                    yield* fs
                      .writeFile(temporary, encrypted, { mode: 0o600 })
                      .pipe(
                        Effect.andThen(fs.rename(temporary, file)),
                        Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
                      );
                    return true;
                  }).pipe(Effect.orElseSucceed(() => false))
                : false;
            if (!saved)
              return {
                ...result,
                setupWarnings: [
                  ...(result.setupWarnings ?? []),
                  "Secure credential storage is unavailable. The credential was not saved; you will be asked again.",
                ],
              };
          }
          return result;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (setups.get(key) === operation) setups.delete(key);
              yield* Deferred.succeed(done, undefined);
            }),
          ),
        );
      }),
    stopEnvironment: (target) =>
      manager
        .stopEnvironment(target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
        ),
    disconnectEnvironment: (target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.disconnectEnvironment"),
        ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      }),
    ),
  );
