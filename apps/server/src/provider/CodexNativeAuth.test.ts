import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderInstanceId, type ProviderAuthInteraction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeCodexNativeAuth } from "./CodexNativeAuth.ts";

let verified = true;
let calls: string[] = [];
let complete: (event: { loginId: string; success: boolean }) => Effect.Effect<void>;
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
              yield* complete({ loginId: "fixture-login", success: verified });
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-codex-auth-" });
      const home = path.join(root, "shared");
      yield* fs.makeDirectory(home);
      const values = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        directory: root,
        get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
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
        expiresAt: Date.now() + 60000,
        verifying: Effect.void,
        setInteraction: (value: ProviderAuthInteraction) =>
          Effect.sync(() => {
            interactions.push(value);
          }),
      };
      yield* native.authenticate(method, context);
      const selected = yield* native.read;
      assert.isTrue(Option.isSome(selected));
      assert.include(calls, "account/read:");
      if (method === "codex-existing")
        assert.isFalse(calls.some((call) => call.startsWith("account/login/start")));
      else
        assert.equal(interactions[0]?.type, method === "codex-device" ? "deviceCode" : "browser");
      assert.isUndefined(native.nativeEnvironment(home).ACCESS_TOKEN);
      assert.isUndefined(native.nativeEnvironment(home).OPENAI_API_KEY);
      assert.notInclude(native.nativeArgs("native"), "token_sharing");
      verified = false;
      yield* native.authenticate(method, context).pipe(Effect.flip);
      assert.deepEqual(yield* native.read, selected);
      yield* native.logout;
      const disconnected = yield* native.read;
      assert.isTrue(Option.isSome(disconnected) && disconnected.value.mode === "disconnected");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
