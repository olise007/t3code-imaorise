// @effect-diagnostics nodeBuiltinImport:off - Disposable native archive fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeManagedProviderArchives } from "./ManagedProviderArchives.ts";
import * as ServerConfig from "../config.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  PROVIDER_RECIPE_CATALOG,
  providerArchiveRecipe,
} from "@t3tools/shared/providerInstallRecipes";

const harness = Effect.fn("test.managedArchives")(function* (
  options: { badHash?: boolean; body?: Stream.Stream<Uint8Array>; nodeVersion?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-recipe-" });
  yield* fs.makeDirectory(`${root}/package`);
  yield* fs.writeFileString(`${root}/package/claude`, "#!/bin/sh\nprintf 'provider 1.0.0\\n'\n", {
    mode: 0o700,
  });
  const created = NodeChildProcess.spawnSync("tar", [
    "-czf",
    `${root}/fixture.tar.gz`,
    "-C",
    root,
    "package",
  ]);
  expect(created.status).toBe(0);
  const bytes = yield* fs.readFile(`${root}/fixture.tar.gz`);
  if (options.nodeVersion)
    yield* fs.writeFileString(`${root}/node`, `#!/bin/sh\nprintf '${options.nodeVersion}\\n'\n`, {
      mode: 0o700,
    });
  let downloads = 0;
  const service = yield* makeManagedProviderArchives({
    resolveRecipe: () => ({
      driver: "claude",
      version: "1.0.0",
      url: "https://fixture.invalid/archive",
      integrity: `sha256:${options.badHash ? "0".repeat(64) : NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
      format: "tar.gz",
      executable: "package/claude",
    }),
  }).pipe(
    Effect.provide(ServerConfig.layerTest(root, root)),
    Effect.provideService(HostProcess.HomeDirectory, root),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(HostProcess.IsExecutable, true),
    Effect.provideService(HostProcess.Environment, { PATH: `${root}:/usr/bin:/bin` }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          downloads++;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null)),
            "stream",
            { value: options.body ?? Stream.succeed(bytes) },
          );
        }),
      ),
    ),
  );
  return { service, root, fs, downloads: () => downloads };
});
const finished = (
  service: Awaited<Effect.Success<ReturnType<typeof makeManagedProviderArchives>>>,
) =>
  service.changes("claude").pipe(
    Stream.filter((s) => ["succeeded", "failed", "cancelled"].includes(s.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it("offers every shipped driver and pins each automatic platform recipe", () => {
  expect(PROVIDER_RECIPE_CATALOG.map((p) => p.driver).sort()).toEqual(
    BUILT_IN_DRIVERS.map((d) => d.driverKind).sort(),
  );
  for (const platform of ["linux", "windows"] as const)
    for (const driver of ["claudeAgent", "grok", "opencode", "pi"]) {
      const recipe = providerArchiveRecipe(driver, platform)!;
      expect(recipe.url).toMatch(/^https:\/\//u);
      expect(recipe.integrity).toMatch(/^(sha256:[a-f0-9]{64}|sha512-[A-Za-z0-9+/]+=*)$/u);
      expect(recipe.executable).not.toContain("..");
    }
});
it.effect("verifies, activates, and reuses an isolated managed executable", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const h = yield* harness();
    yield* h.service.start("claude");
    const state = yield* finished(h.service);
    expect(state.phase).toBe("succeeded");
    expect(state.executablePath).toContain(h.root);
    expect(
      yield* h.fs.exists(`${h.root}/tools/provider-archives/claude/1.0.0/.recipe-integrity`),
    ).toBe(true);
    yield* h.service.start("claude");
    expect((yield* finished(h.service)).phase).toBe("succeeded");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("reuses compatible Node without downloading or replacing it", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const h = yield* harness({ nodeVersion: "v24.10.0" });
    expect(yield* h.service.ensureCompatibleNode).toBe(`${h.root}/node`);
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("does not accept old Node and verifies the private dependency before activation", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const h = yield* harness({ nodeVersion: "v16.20.0" });
    const outcome = yield* h.service.ensureCompatibleNode.pipe(Effect.result);
    expect(outcome._tag).toBe("Failure");
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.readFileString(`${h.root}/node`)).toContain("v16.20.0");
    expect(yield* h.fs.exists(`${h.root}/.t3-imaorise/tools/node/26.8.2`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("rejects integrity failures before activation and cleans staging", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const h = yield* harness({ badHash: true });
    yield* h.service.start("claude");
    expect((yield* finished(h.service)).message).toContain("integrity");
    expect(yield* h.fs.readDirectory(`${h.root}/tools/provider-archives/claude`)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("cancels the owned download without activating or replaying it", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const started = yield* Deferred.make<void>();
    const h = yield* harness({
      body: Stream.fromEffect(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    });
    const state = yield* h.service.start("claude");
    yield* Deferred.await(started);
    yield* h.service.cancel("claude", state.operationId!);
    expect((yield* finished(h.service)).phase).toBe("cancelled");
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.readDirectory(`${h.root}/tools/provider-archives/claude`)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
