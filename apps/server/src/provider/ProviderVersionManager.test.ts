// @effect-diagnostics multipleEffectProvide:off - Scoped service fixture with real temporary files and mocked installers.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as Registry from "./ProviderRegistry.ts";
import * as Codex from "./CodexInstallation.ts";
import * as Antigravity from "./AntigravityInstallation.ts";
import * as Archives from "./ManagedProviderArchives.ts";
import * as Maintenance from "./providerMaintenanceRunner.ts";
import { makeProviderVersionManager } from "./ProviderVersionManager.ts";
import { trackProviderInstallationWork } from "./ProviderInstallationActivity.ts";

const input = {
  provider: "claudeAgent",
  instanceId: ProviderInstanceId.make("shared-one"),
  targetVersion: "2.0.0",
  expectedIntegrity: `sha512-${"a".repeat(86)}==`,
  allowUnknownCompatibility: true,
};
const harness = Effect.fn("test.versionManager")(function* (changeSettings = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "provider-version-manager-" });
  const binary = path.join(root, "tools", "provider-archives", "claudeAgent", "1.0.0", "claude");
  yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
  yield* fs.writeFileString(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  yield* fs.writeFileString(
    path.join(path.dirname(binary), ".recipe-integrity"),
    `sha256:${"a".repeat(64)}`,
  );
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: Object.fromEntries(
      ["shared-one", "shared-two"].map((id) => [
        id,
        { driver: "claudeAgent", displayName: id, config: { binaryPath: binary } },
      ]),
    ),
  };
  const original = settings;
  let preparations = 0;
  let activations = 0;
  const ready = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const states: ServerProviderUpdateState[] = [];
  const manager = yield* makeProviderVersionManager().pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.sync(() => settings),
          activateProviderInstallation: (_expected, replacements) =>
            Effect.sync(() => {
              activations++;
              settings = {
                ...settings,
                providerInstances: { ...settings.providerInstances, ...replacements },
              };
            }),
        }),
        Layer.mock(Codex.CodexInstallation)({
          managedDirectory: path.join(root, "tools", "codex"),
        }),
        Layer.mock(Antigravity.AntigravityInstallation)({
          managedDirectory: path.join(root, "tools", "antigravity"),
        }),
        Layer.mock(Archives.ManagedProviderArchives)({
          prepare: () =>
            Effect.sync(() => {
              preparations++;
              if (changeSettings)
                settings = {
                  ...settings,
                  providerInstances: {
                    ...settings.providerInstances,
                    other: { driver: "codex", config: {} },
                  },
                };
              return path.join(root, "verified-2.0.0", "claude");
            }),
        }),
        Layer.mock(Maintenance.ProviderMaintenanceRunner)({
          updateProvider: () => Effect.die("Managed files must never use the external updater"),
        }),
        Layer.mock(Registry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          setProviderMaintenanceActionState: ({ state }) =>
            Effect.gen(function* () {
              states.push(state);
              if (state.message === "Ready—waiting for running work")
                yield* Deferred.succeed(ready, undefined);
              if (state.status === "succeeded") yield* Deferred.succeed(completed, undefined);
              return [];
            }),
        }),
        Layer.mock(ModelManifest.ModelManifest)({
          current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/2.0.0")
                    ? {
                        version: "2.0.0",
                        dist: {
                          tarball:
                            "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/fixture.tgz",
                          integrity: input.expectedIntegrity,
                        },
                      }
                    : {
                        "dist-tags": { latest: "2.0.0" },
                        versions: {
                          "2.0.0": {
                            dist: {
                              tarball:
                                "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/fixture.tgz",
                              integrity: input.expectedIntegrity,
                            },
                          },
                        },
                      },
                ),
              ),
            ),
          ),
        ),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Architecture, "x64"),
      ),
    ),
  );
  return {
    manager,
    original,
    current: () => settings,
    preparations: () => preparations,
    activations: () => activations,
    ready,
    completed,
    states,
  };
});
it.layer(NodeServices.layer)("provider version activation", (it) => {
  it.effect(
    "identifies shared instances and waits for work even after the requesting client disconnects",
    () =>
      Effect.gen(function* () {
        const fixture = yield* harness();
        const page = yield* fixture.manager.page({ ...input, page: 1, prereleases: false });
        expect(page.affectedInstances).toEqual(["shared-one", "shared-two"]);
        expect(page.selectedVersion).toBe("1.0.0");
        const working = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const agent = yield* trackProviderInstallationWork(
          input.instanceId,
          Deferred.succeed(working, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(working);
        const request = yield* fixture.manager.update(input).pipe(Effect.forkChild);
        yield* Deferred.await(fixture.ready);
        expect(fixture.activations()).toBe(0);
        yield* Fiber.interrupt(request);
        expect(fixture.current()).toEqual(fixture.original);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(agent);
        yield* Deferred.await(fixture.completed);
        expect(fixture.activations()).toBe(1);
        expect(fixture.current().providerInstances["shared-one"]?.config).toEqual(
          fixture.current().providerInstances["shared-two"]?.config,
        );
      }),
  );
  it.effect("rejects a changed artifact before staging", () =>
    Effect.gen(function* () {
      const fixture = yield* harness();
      yield* fixture.manager
        .update({ ...input, expectedIntegrity: "sha512-changed" })
        .pipe(Effect.flip);
      expect(fixture.preparations()).toBe(0);
      expect(fixture.activations()).toBe(0);
    }),
  );
  it.effect("retains the previous selection when settings change while staging", () =>
    Effect.gen(function* () {
      const fixture = yield* harness(true);
      yield* fixture.manager.update(input).pipe(Effect.flip);
      expect(fixture.preparations()).toBe(1);
      expect(fixture.activations()).toBe(0);
      expect(fixture.current().providerInstances["shared-one"]).toEqual(
        fixture.original.providerInstances["shared-one"],
      );
    }),
  );
});
