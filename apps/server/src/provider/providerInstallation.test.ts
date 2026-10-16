import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";

import * as ServerSettings from "../serverSettings.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ManagedProviderArchives from "./ManagedProviderArchives.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeProviderInstallation } from "./providerInstallation.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const driver = ProviderDriverKind.make("antigravity");
const state: ProviderInstallState = {
  driver,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
};

function instance(kind = driver, id = instanceId): ProviderInstance {
  return {
    instanceId: id,
    driverKind: kind,
    enabled: false,
    displayName: undefined,
    continuationIdentity: { driverKind: kind, continuationKey: instanceId },
    get orchestrationAdapter(): never {
      throw new Error("Installation must not start a provider session.");
    },
    get snapshot(): never {
      throw new Error("Installation routing must not probe the provider.");
    },
    get textGeneration(): never {
      throw new Error("Installation must not generate text.");
    },
  };
}

const makeHarness = Effect.fn("providerInstallation.test.makeHarness")(function* (
  input: {
    instance?: ProviderInstance;
    settings?: Parameters<typeof ServerSettings.layerTest>[0];
    archives?: Partial<ManagedProviderArchives.ManagedProviderArchives["Service"]>;
    antigravity?: Partial<AntigravityInstallation.AntigravityInstallation["Service"]>;
  } = {},
) {
  const calls: string[] = [];
  let protectedPaths: ReadonlyArray<string> = [];
  const configured = input.instance ?? instance();
  const router = yield* makeProviderInstallation().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ManagedProviderArchives.ManagedProviderArchives)(input.archives ?? {}),
        ServerSettings.layerTest(input.settings),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(id === configured.instanceId ? configured : undefined),
          listInstances: Effect.succeed([configured]),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          refreshInstance: () =>
            Effect.sync(() => {
              calls.push("refresh");
              return [];
            }),
        }),
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "/unused-managed-codex",
          start: Effect.sync(() => {
            calls.push("codex-start");
            return { ...state, driver: ProviderDriverKind.make("codex") };
          }),
          cancel: () =>
            Effect.sync(() => {
              calls.push("codex-cancel");
              return { ...state, driver: ProviderDriverKind.make("codex") };
            }),
          state: Effect.succeed({ ...state, driver: ProviderDriverKind.make("codex") }),
          changes: Stream.succeed({ ...state, driver: ProviderDriverKind.make("codex") }),
          remove: (paths) =>
            Effect.sync(() => {
              protectedPaths = paths ?? [];
              calls.push("codex-remove");
            }),
        }),
        Layer.mock(AntigravityInstallation.AntigravityInstallation)({
          managedDirectory: "/unused-managed-runtime",
          start: Effect.sync(() => {
            calls.push("start");
            return state;
          }),
          cancel: () =>
            Effect.sync(() => {
              calls.push("cancel");
              return state;
            }),
          state: Effect.succeed(state),
          changes: Stream.succeed(state),
          remove: (paths) =>
            Effect.sync(() => {
              protectedPaths = paths ?? [];
              calls.push("remove");
            }),
          ...input.antigravity,
        }),
      ),
    ),
  );
  return { router, calls, protectedPaths: () => protectedPaths };
});

describe("provider installation routing", () => {
  it.effect(
    "resolves a successful Antigravity install when progress omits its executable path",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          antigravity: {
            start: Effect.succeed({ ...state, phase: "succeeded", installedVersion: "1.3.0" }),
            resolve: () =>
              Effect.succeed({
                executablePath: "/managed/agy",
                harnessPath: "/managed/harness",
                source: "managed",
                version: "1.3.0",
                managedVersionDirectory: "/managed",
              }),
          },
        });
        const result = yield* h.router.selected({
          recipeRevision: 1,
          operationId: "antigravity-selection",
          drivers: [driver],
        });
        assert.include(result[0]!.message, "Installed and discovered");
        assert.deepEqual(h.calls, ["refresh"]);
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect("preserves custom provider executables and keeps authentication separate", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        settings: {
          providerInstances: {
            [instanceId]: { driver, config: { binaryPath: "/custom/antigravity" } },
          },
        },
      });
      const result = yield* h.router.selected({
        recipeRevision: 1,
        operationId: "custom-selection",
        drivers: [driver],
      });
      assert.include(result[0]!.message, "Custom executable preserved");
      assert.deepEqual(h.calls, ["refresh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels only the selected setup's owned provider installation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancellations: string[] = [];
      const h = yield* makeHarness({
        archives: {
          start: (selectedDriver) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.as({
                ...state,
                driver: ProviderDriverKind.make(selectedDriver),
                phase: "downloading",
                operationId: "owned-download",
              }),
            ),
          changes: () => Stream.never,
          cancel: (selectedDriver, operationId) =>
            Effect.sync(() => {
              cancellations.push(`${selectedDriver}:${operationId}`);
              return { ...state, phase: "cancelled" as const };
            }),
        },
      });
      const fiber = yield* h.router
        .selected({
          recipeRevision: 1,
          operationId: "selected-setup",
          drivers: [ProviderDriverKind.make("claudeAgent")],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* h.router.cancelSelected("different-setup");
      assert.deepEqual(cancellations, []);
      yield* h.router.cancelSelected("selected-setup");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.deepEqual(cancellations, ["claudeAgent:owned-download"]);
      assert.deepEqual(h.calls, []);
    }).pipe(
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("allows explicit installation while the provider is disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.router.start({ instanceId });
      assert.deepEqual(harness.calls, ["start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects another driver and unknown instances before installation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ instance: instance(ProviderDriverKind.make("codex")) });
      const wrongDriver = yield* Effect.flip(harness.router.start({ instanceId }));
      const missing = yield* Effect.flip(
        harness.router.start({ instanceId: ProviderInstanceId.make("missing") }),
      );
      assert.equal(wrongDriver._tag, "ProviderSetupError");
      assert.equal(missing._tag, "ProviderSetupError");
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps external installs manual without hiding shared install status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("antigravity")]: {
              driver: ProviderDriverKind.make("antigravity"),
              config: { binaryPath: "/external/agy" },
            },
          },
        },
      });
      const start = yield* Effect.flip(harness.router.start({ instanceId }));
      const remove = yield* Effect.flip(harness.router.remove({ instanceId }));
      assert.include(start.detail, "custom executable");
      assert.include(remove.detail, "custom executable");
      const observed = yield* Stream.runCollect(harness.router.subscribe({ instanceId }));
      assert.deepEqual(Array.from(observed), [state]);
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("routes a managed Codex instance through its own installer and refreshes removal", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex");
      const harness = yield* makeHarness({
        instance: instance(ProviderDriverKind.make("codex"), codexId),
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { setupMode: "managed" },
            },
          },
        },
      });
      assert.equal((yield* harness.router.start({ instanceId: codexId })).driver, "codex");
      yield* harness.router.cancel({ instanceId: codexId, operationId: "operation" });
      const observed = yield* Stream.runCollect(harness.router.subscribe({ instanceId: codexId }));
      assert.equal(Array.from(observed)[0]?.driver, "codex");
      yield* harness.router.remove({ instanceId: codexId });
      assert.deepEqual(harness.calls, ["codex-start", "codex-cancel", "codex-remove", "refresh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps native Codex installation outside managed setup", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex");
      const harness = yield* makeHarness({
        instance: instance(ProviderDriverKind.make("codex"), codexId),
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { setupMode: "existing" },
            },
          },
        },
      });
      assert.include(
        (yield* Effect.flip(harness.router.start({ instanceId: codexId }))).detail,
        "Choose managed setup",
      );
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("protects another instance's binary found through its own PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-install-route-" });
      const binary = platform === "win32" ? "agy-test.exe" : "agy-test";
      const executable = path.join(directory, binary);
      yield* fs.writeFileString(executable, "test");
      yield* fs.chmod(executable, 0o755);
      const other = ProviderInstanceId.make("antigravity-work");
      const harness = yield* makeHarness({
        settings: {
          providerInstances: {
            [other]: {
              driver,
              config: { binaryPath: binary },
              environment: [{ name: "PATH", value: directory, sensitive: false }],
            },
          },
        },
      });
      yield* harness.router.remove({ instanceId });
      assert.include(harness.protectedPaths(), executable);
      assert.deepEqual(harness.calls, ["remove", "refresh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
