// @effect-diagnostics nodeBuiltinImport:off - Hosted vendor archive smoke, isolated from accounts and installed apps.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeAssert from "node:assert/strict";
import { makeManagedProviderArchives } from "../ManagedProviderArchives.ts";
import * as ServerConfig from "../../config.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as ModelManifest from "../ModelManifest.ts";

if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Vendor smoke runs only in hosted fixtures.");
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-verified-provider-recipes-" });
    const service = yield* makeManagedProviderArchives().pipe(
      Effect.provide(ServerConfig.layerTest(root, root)),
      Effect.provideService(HostProcess.HomeDirectory, root),
      Effect.provideService(HostProcess.Environment, {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: root,
        TMPDIR: root,
        HOME: root,
        USERPROFILE: root,
      }),
    );
    for (const driver of ["claudeAgent", "grok", "opencode", "pi"]) {
      yield* service.start(driver);
      const done = Option.getOrThrow(
        yield* service.changes(driver).pipe(
          Stream.filter((s) => ["succeeded", "failed", "cancelled"].includes(s.phase)),
          Stream.runHead,
        ),
      );
      NodeAssert.equal(done.phase, "succeeded", `${driver}: ${done.message}`);
      process.stdout.write(
        `${driver}: pinned archive integrity, extraction and native --version verified.\n`,
      );
    }
    const node = yield* service.ensureNode;
    NodeAssert.ok(node.startsWith(root));
    NodeAssert.equal(
      yield* fs.exists(`${root}/.t3-imaorise/tools/node/26.8.2/node_modules/npm`),
      false,
    );
    process.stdout.write(
      "Antigravity dependency: pinned private Node verified; npm not installed. Authentication was not attempted.\n",
    );
    const platform = yield* HostProcess.Platform;
    const environment = {
      PATH:
        platform === "win32"
          ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
          : "/usr/bin:/bin",
      SystemRoot: process.env.SystemRoot,
      TEMP: root,
      TMPDIR: root,
      HOME: root,
      USERPROFILE: root,
    };
    const codex = yield* CodexInstallation.makeCodexInstallation({ baseDir: root }).pipe(
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(ModelManifest.ModelManifest, {
        current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
        refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
        forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
        refreshInBackground: Effect.void,
      }),
    );
    const antigravity = yield* AntigravityInstallation.makeAntigravityInstallation({
      baseDir: root,
      onFailure: (cause) =>
        Effect.sync(() =>
          process.stderr.write(
            Cause.pretty(cause)
              .slice(0, 1800)
              .replace(/https?:\/\/\S+/gu, "<vendor-url>") + "\n",
          ),
        ),
    }).pipe(Effect.provideService(HostProcess.Environment, environment));
    for (const { driver, installation } of [
      { driver: "codex", installation: codex },
      { driver: "antigravity", installation: antigravity },
    ]) {
      yield* installation.start;
      const done = Option.getOrThrow(
        yield* installation.changes.pipe(
          Stream.filter((s) => ["succeeded", "failed", "cancelled"].includes(s.phase)),
          Stream.runHead,
        ),
      );
      NodeAssert.equal(done.phase, "succeeded", `${driver}: ${done.message}`);
      NodeAssert.equal(done.source, "managed");
      process.stdout.write(
        `${driver}: existing managed installer verified its pinned vendor runtime. No sign-in requested.\n`,
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
  ),
);
