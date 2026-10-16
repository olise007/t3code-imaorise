// @effect-diagnostics nodeBuiltinImport:off - Native archive verification and Brotli decoding are installer boundaries.
import {
  ProviderDriverKind,
  type ProviderInstallState,
  ProviderSetupError,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  NODE_PROVIDER_RUNTIME,
  providerArchiveRecipe,
  type ProviderArchiveRecipe,
} from "@t3tools/shared/providerInstallRecipes";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import * as ServerConfig from "../config.ts";

const failure = (driver: string, operation: string, detail: string, cause?: unknown) =>
  new ProviderSetupError({
    instanceId: ProviderInstanceId.make(driver),
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
const idle = (driver: string): ProviderInstallState => ({
  driver: ProviderDriverKind.make(driver),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
});

export class ManagedProviderArchives extends Context.Service<
  ManagedProviderArchives,
  {
    readonly start: (driver: string) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly cancel: (driver: string, operationId: string) => Effect.Effect<ProviderInstallState>;
    readonly changes: (driver: string) => Stream.Stream<ProviderInstallState>;
    readonly ensureNode: Effect.Effect<string, ProviderSetupError>;
  }
>()("t3/provider/ManagedProviderArchives") {}

export const makeManagedProviderArchives = Effect.fn("ManagedProviderArchives.make")(function* (
  options: { readonly resolveRecipe?: typeof providerArchiveRecipe } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const states = yield* SubscriptionRef.make(new Map<string, ProviderInstallState>());
  const running = new Map<string, { id: string; fiber: Fiber.Fiber<void> }>();
  const gate = yield* Semaphore.make(1);
  const host = platform === "win32" ? "windows" : "linux";
  const update = (driver: string, patch: Partial<ProviderInstallState>) =>
    SubscriptionRef.update(states, (current) =>
      new Map(current).set(driver, { ...(current.get(driver) ?? idle(driver)), ...patch }),
    );
  const run = Effect.fn("ManagedProviderArchives.run")(function* (
    command: string,
    args: readonly string[],
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd: home, env: environment, extendEnv: false }),
    );
    const [stdout, , code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0)
      return yield* failure(
        "provider",
        "verify",
        "The downloaded provider could not be unpacked or started. Check its platform requirements.",
      );
    return stdout;
  }, Effect.scoped);
  const install = Effect.fn("ManagedProviderArchives.install")(
    function* (recipe: ProviderArchiveRecipe, node = false) {
      if (arch !== "x64" || (platform !== "linux" && platform !== "win32"))
        return yield* failure(
          recipe.driver,
          "install",
          "This verified recipe supports Linux x64 and Windows x64 only.",
        );
      const parent = node
        ? path.join(home, ".t3-imaorise/tools/node")
        : path.join(config.baseDir, "tools/provider-archives", recipe.driver);
      const destination = path.join(parent, recipe.version);
      const executableName = node
        ? platform === "win32"
          ? "node.exe"
          : "bin/node"
        : "provider" + (platform === "win32" ? ".exe" : "");
      const binary = path.join(destination, executableName);
      const marker = path.join(destination, ".recipe-integrity");
      if ((yield* fs.exists(marker)) && (yield* fs.readFileString(marker)) === recipe.integrity) {
        const version = yield* run(binary, ["--version"]);
        if (!version.includes(recipe.version))
          return yield* failure(
            recipe.driver,
            "verify",
            "The existing managed executable reports an incompatible version.",
          );
        return binary;
      }
      if (yield* fs.exists(destination))
        return yield* failure(
          recipe.driver,
          "verify",
          "An incomplete or incompatible managed installation exists. Inspect it before retrying; T3 will not overwrite it.",
        );
      yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
      yield* fs
        .makeDirectory(`${destination}.lock`)
        .pipe(
          Effect.mapError(() =>
            failure(
              recipe.driver,
              "install",
              "Another installation is in progress or an interrupted lock needs inspection. Retry after it finishes.",
            ),
          ),
        );
      yield* Effect.addFinalizer(() =>
        fs.remove(`${destination}.lock`, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const stage = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: ".install-" });
      const archive = path.join(
        stage,
        recipe.format === "zip" ? "download.zip" : "download.tar.gz",
      );
      const unpacked = path.join(stage, "unpacked");
      yield* fs.makeDirectory(unpacked);
      const hash = NodeCrypto.createHash(
        recipe.integrity.startsWith("sha512-") ? "sha512" : "sha256",
      );
      let bytes = 0;
      const response = yield* http
        .execute(HttpClientRequest.get(recipe.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            bytes += chunk.byteLength;
            if (bytes > 800_000_000)
              return yield* failure(
                recipe.driver,
                "download",
                "The provider archive exceeded its download limit.",
              );
            hash.update(chunk);
          }),
        ),
        Stream.run(fs.sink(archive, { flag: "wx", mode: 0o600 })),
      );
      const actual = recipe.integrity.startsWith("sha512-")
        ? `sha512-${hash.digest("base64")}`
        : `sha256:${hash.digest("hex")}`;
      if (actual !== recipe.integrity)
        return yield* failure(
          recipe.driver,
          "verify",
          "Provider archive integrity verification failed. Nothing was activated.",
        );
      yield* update(recipe.driver, { phase: "extracting", downloadedBytes: bytes });
      const tar =
        platform === "win32"
          ? path.join(
              (yield* HostProcess.Environment).SystemRoot ?? "C:\\Windows",
              "System32/tar.exe",
            )
          : "tar";
      const names = yield* run(tar, ["-tf", archive]);
      if (
        names.split(/\r?\n/u).length > 10000 ||
        names
          .split(/\r?\n/u)
          .some(
            (name) =>
              name.startsWith("/") ||
              name.includes("\\") ||
              name.includes(":") ||
              name.split("/").includes(".."),
          )
      )
        return yield* failure(recipe.driver, "verify", "Provider archive contains an unsafe path.");
      const nodeFiles = [recipe.executable, `${recipe.executable.split("/")[0]!}/LICENSE`];
      const entries = yield* run(tar, ["-tvf", archive, ...(node ? nodeFiles : [])]);
      if (
        entries
          .trim()
          .split(/\r?\n/u)
          .some((entry) => !["-", "d"].includes(entry[0] ?? ""))
      )
        return yield* failure(
          recipe.driver,
          "verify",
          "Provider archive contains a link or unsupported entry.",
        );
      yield* run(tar, ["-xf", archive, "-C", unpacked, ...(node ? nodeFiles : [])]);
      const source = path.join(unpacked, recipe.executable);
      const root = path.join(stage, "runtime");
      if (node) {
        yield* fs.makeDirectory(path.dirname(path.join(root, executableName)), { recursive: true });
        yield* fs.copyFile(source, path.join(root, executableName));
        yield* fs.copyFile(
          path.join(unpacked, recipe.executable.split("/")[0]!, "LICENSE"),
          path.join(root, "LICENSE"),
        );
      } else {
        // Keep companions (Pi's themes/assets and native CLI resources) next to the binary.
        const sourceParent =
          recipe.driver === "pi" ? path.dirname(source) : path.join(unpacked, "package");
        yield* fs.rename(sourceParent, root);
        const relative = path.relative(sourceParent, source);
        const entry = path.join(root, relative);
        const target = path.join(root, executableName);
        if (recipe.brotli)
          yield* fs.writeFile(
            target,
            NodeZlib.brotliDecompressSync(yield* fs.readFile(entry), {
              maxOutputLength: 400_000_000,
            }),
          );
        else if (entry !== target) yield* fs.copyFile(entry, target);
      }
      const stagedBinary = path.join(root, executableName);
      if (platform !== "win32") yield* fs.chmod(stagedBinary, 0o700);
      yield* update(recipe.driver, { phase: "verifying" });
      const version = yield* run(stagedBinary, ["--version"]);
      if (!version.includes(recipe.version))
        return yield* failure(
          recipe.driver,
          "verify",
          "The downloaded executable does not report its pinned version.",
        );
      yield* fs.writeFileString(path.join(root, ".recipe-integrity"), recipe.integrity, {
        mode: 0o600,
      });
      yield* fs.rename(root, destination);
      return binary;
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      Schema.is(ProviderSetupError)(cause)
        ? cause
        : failure(
            "provider",
            "install",
            "Provider installation failed. Completed installations are retained; retry explicitly after checking the remote requirements.",
            cause,
          ),
    ),
  );
  const ensureNode = gate.withPermit(install(NODE_PROVIDER_RUNTIME[host], true));
  return ManagedProviderArchives.of({
    ensureNode,
    changes: (driver) =>
      SubscriptionRef.changes(states).pipe(
        Stream.map((all) => all.get(driver) ?? idle(driver)),
        Stream.changes,
      ),
    cancel: (driver, operationId) =>
      Effect.gen(function* () {
        const active = running.get(driver);
        if (active?.id === operationId) yield* Fiber.interrupt(active.fiber);
        return (yield* SubscriptionRef.get(states)).get(driver) ?? idle(driver);
      }),
    start: (driver) =>
      Effect.gen(function* () {
        const recipe = (options.resolveRecipe ?? providerArchiveRecipe)(driver, host);
        if (!recipe)
          return yield* failure(
            driver,
            "install",
            "No verified installation recipe is available for this provider and platform.",
          );
        const active = running.get(driver);
        if (active) return (yield* SubscriptionRef.get(states)).get(driver) ?? idle(driver);
        const id = NodeCrypto.randomUUID();
        yield* update(driver, {
          ...idle(driver),
          version: recipe.version,
          operationId: id,
          phase: "downloading",
        });
        const fiber = yield* gate.withPermit(install(recipe)).pipe(
          Effect.tap((binary) =>
            update(driver, {
              phase: "succeeded",
              installedVersion: recipe.version,
              executablePath: binary,
              source: "managed",
            }),
          ),
          Effect.catch((error) => update(driver, { phase: "failed", message: error.detail })),
          Effect.onInterrupt(() =>
            update(driver, {
              phase: "cancelled",
              message: "Installation cancelled. Completed installations are retained.",
            }),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(driver))),
          Effect.asVoid,
          Effect.forkIn(scope),
        );
        running.set(driver, { id, fiber });
        return (yield* SubscriptionRef.get(states)).get(driver)!;
      }),
  });
});
export const layer = Layer.effect(ManagedProviderArchives, makeManagedProviderArchives());
