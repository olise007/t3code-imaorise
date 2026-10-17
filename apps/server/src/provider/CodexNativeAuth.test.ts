import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CodexSettings,
  ProviderInstanceId,
  type ProviderAuthInteraction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeCodexCliAuth } from "./CodexCliAuth.ts";
import { makeCodexNativeAuth } from "./CodexNativeAuth.ts";

let verified = true;
let holdCompletion = false;
let calls: string[] = [];
let complete: (event: { loginId: string; success: boolean }) => Effect.Effect<void>;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
vi.mock("./CodexProvider.ts", () => ({
  withCodexAppServerClient: () =>
    Effect.succeed({
      client: {
        handleServerNotification: (_method: string, handler: typeof complete) =>
          Effect.sync(() => {
            complete = handler;
          }),
        request: (method: string, params: { type?: string }) =>
          Effect.gen(function* () {
            calls.push(`${method}:${params.type ?? ""}`);
            if (method === "account/read")
              return {
                account: verified ? { type: "chatgpt", email: "fixture@example.test" } : null,
              };
            if (method === "account/login/start") {
              if (!holdCompletion) yield* complete({ loginId: "fixture-login", success: verified });
              return params.type === "chatgptDeviceCode"
                ? {
                    type: "chatgptDeviceCode",
                    loginId: "fixture-login",
                    verificationUrl: "https://auth.openai.com/codex/device",
                    userCode: "FIXTURE-CODE",
                  }
                : {
                    type: "chatgpt",
                    loginId: "fixture-login",
                    authUrl: `https://auth.openai.com/oauth/authorize?${new URLSearchParams({ client_id: "app_fixture", response_type: "code", redirect_uri: "http://localhost:1455/auth/callback", state: "s".repeat(43), code_challenge: "c".repeat(43), code_challenge_method: "S256" })}`,
                  };
            }
            return {};
          }),
      },
    }),
}));

it.effect.each(["codex-browser", "codex-device", "codex-existing"])(
  "verifies %s before retaining its selection, preserving it after a later failure",
  (method) =>
    Effect.gen(function* () {
      calls = [];
      verified = true;
      holdCompletion = false;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-codex-auth-" });
      const home = path.join(root, "shared");
      yield* fs.makeDirectory(home);
      const values = new Map<string, Uint8Array>();
      let rejectWrites = false;
      const secrets = ServerSecretStore.ServerSecretStore.of({
        directory: root,
        get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
        set: (key, value) =>
          Effect.suspend(() =>
            rejectWrites
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: "fixture",
                    cause: new Error("Fixture storage unavailable"),
                  }),
                )
              : Effect.sync(() => {
                  values.set(key, value);
                }),
          ),
        remove: (key) =>
          Effect.sync(() => {
            values.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      const profiles = yield* ProviderCredentialStore.make("codex-chatgpt", "codex-fixture").pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      );
      yield* profiles.set(
        new TextEncoder().encode(
          yield* encodeJson({
            activeClientId: "previous-profile",
            sessions: [
              {
                clientId: "previous-profile",
                accessToken: "fixture-token",
                refreshToken: null,
                expiresAt: 9999999999999,
                earliestRefreshAt: null,
                scopes: ["chatgpt.tokens.use.direct"],
                subject: "fixture",
                email: null,
              },
            ],
          }),
        ),
      );
      const native = yield* makeCodexNativeAuth({
        instanceId: ProviderInstanceId.make("codex-fixture"),
        stateDir: root,
        homeLayout: {
          mode: "direct",
          sharedHomePath: home,
          effectiveHomePath: undefined,
          continuationKey: "fixture",
        },
        environment: {
          ACCESS_TOKEN: "must-not-leak",
          OPENAI_API_KEY: "must-not-leak",
          OPENAI_BASE_URL: "https://example.invalid",
        },
        executable: Effect.succeed({ executablePath: "/fixture/codex" }),
      }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets));
      const interactions: ProviderAuthInteraction[] = [];
      const context = {
        flowId: "fixture-flow",
        expiresAt: (yield* Clock.currentTimeMillis) + 60000,
        verifying: Effect.void,
        setInteraction: (value: ProviderAuthInteraction) =>
          Effect.sync(() => {
            interactions.push(value);
          }),
      };
      yield* native.authenticate(method, context);
      const selected = yield* native.read;
      assert.include(
        new TextDecoder().decode(Option.getOrThrow(yield* profiles.get)),
        "previous-profile",
      );
      assert.isTrue(Option.isSome(selected));
      assert.include(calls, "account/read:");
      if (method === "codex-existing")
        assert.isFalse(calls.some((call) => call.startsWith("account/login/start")));
      else
        assert.equal(interactions[0]?.type, method === "codex-device" ? "deviceCode" : "browser");
      assert.isUndefined(native.nativeEnvironment(home).ACCESS_TOKEN);
      assert.isUndefined(native.nativeEnvironment(home).OPENAI_API_KEY);
      assert.notInclude(native.nativeArgs("native"), "token_sharing");
      if (method !== "codex-existing") {
        for (const ending of ["cancel", "expire"]) {
          holdCompletion = true;
          const waiting = yield* Deferred.make<void>();
          const attempt = yield* native
            .authenticate(method, {
              ...context,
              setInteraction: (value) =>
                context
                  .setInteraction(value)
                  .pipe(Effect.andThen(Deferred.succeed(waiting, undefined)), Effect.asVoid),
            })
            .pipe(Effect.timeout("1 minute"), Effect.forkChild);
          yield* Deferred.await(waiting);
          if (ending === "cancel") yield* Fiber.interrupt(attempt);
          else {
            yield* TestClock.adjust("2 minutes");
            yield* Fiber.await(attempt);
          }
          holdCompletion = false;
          assert.include(calls, "account/login/cancel:");
          assert.deepEqual(yield* native.read, selected);
          const kept = Option.getOrThrow(selected).homePath;
          assert.deepEqual(yield* fs.readDirectory(path.dirname(kept)), [path.basename(kept)]);
        }
      }
      verified = false;
      yield* native.authenticate(method, context).pipe(Effect.flip);
      assert.deepEqual(yield* native.read, selected);
      verified = true;
      rejectWrites = true;
      yield* native.authenticate(method, context).pipe(Effect.flip);
      assert.deepEqual(yield* native.read, selected);
      rejectWrites = false;
      yield* native.logout;
      const disconnected = yield* native.read;
      assert.isTrue(Option.isSome(disconnected) && disconnected.value.mode === "disconnected");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["win32", "linux"] as const)(
  "keeps external installation ownership while signing in on %s",
  (platform) =>
    Effect.scoped(
      Effect.gen(function* () {
        verified = true;
        holdCompletion = false;
        calls = [];
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-auth-parity-" });
        const home = path.join(root, "original-home");
        yield* fs.makeDirectory(home);
        const originalCredentials = "fixture-owned-cli-credentials";
        yield* fs.writeFileString(path.join(home, "auth.json"), originalCredentials);
        const values = new Map<string, Uint8Array>();
        const secrets = ServerSecretStore.ServerSecretStore.of({
          directory: root,
          get: (key) => Effect.sync(() => Option.fromUndefinedOr(values.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              values.set(key, value);
            }),
          remove: (key) =>
            Effect.sync(() => {
              values.delete(key);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        });
        const config = Schema.decodeSync(CodexSettings)({
          setupMode: "existing",
          binaryPath: platform === "win32" ? "C:\\custom\\codex.exe" : "/custom/codex",
          homePath: home,
        });
        const runtime = yield* makeCodexCliAuth({
          instanceId: ProviderInstanceId.make(`external-${platform}`),
          stateDir: root,
          config,
          environment: { CUSTOM_VALUE: "retained" },
          homeLayout: {
            mode: "direct",
            sharedHomePath: home,
            effectiveHomePath: home,
            continuationKey: "fixture",
          },
        }).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(HostProcess.Platform, platform),
        );
        assert.deepEqual((yield* runtime.resolve).config, config);
        // Disconnect implicit CLI credentials as well as an explicitly selected home.
        yield* runtime.controller.logout(Effect.void);
        assert.include((yield* runtime.resolve.pipe(Effect.flip)).detail, "Sign in with Codex");
        yield* runtime.controller.start("owner", Effect.void, "codex-existing");
        yield* runtime.controller.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
        );
        assert.equal((yield* runtime.resolve).config.homePath, home);
        yield* runtime.controller.logout(Effect.void);
        assert.include((yield* runtime.resolve.pipe(Effect.flip)).detail, "Sign in with Codex");
        assert.equal(yield* fs.readFileString(path.join(home, "auth.json")), originalCredentials);
        const initial = yield* runtime.controller.start("owner", Effect.void, "codex-browser");
        assert.deepEqual(
          initial.methods?.map((method) => method.id),
          ["codex-browser", "codex-device", "codex-existing"],
        );
        yield* runtime.controller.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
        );
        const selected = yield* runtime.resolve;
        assert.equal(selected.config.binaryPath, config.binaryPath);
        assert.equal(selected.config.setupMode, "existing");
        assert.notEqual(selected.config.homePath, home);
        assert.equal(selected.environment.CUSTOM_VALUE, "retained");
        verified = false;
        yield* runtime.controller.start("owner", Effect.void, "codex-device");
        yield* runtime.controller.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "failed"),
          Stream.runHead,
        );
        assert.deepEqual(yield* runtime.resolve, selected);
        yield* runtime.controller.logout(Effect.void);
        const failure = yield* runtime.resolve.pipe(Effect.flip);
        assert.include(failure.detail, "Sign in with Codex");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
