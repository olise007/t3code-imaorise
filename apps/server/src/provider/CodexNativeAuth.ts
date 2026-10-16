// @effect-diagnostics nodeBuiltinImport:off - Delivers only the callback advertised by this Codex process.
import * as NodeHttp from "node:http";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import {
  codexNativeAuthorizationRequest,
  codexCallbackUrl,
} from "@t3tools/shared/codexAuthHandoff";
import type { ProviderAuthFlowContext } from "@t3tools/provider-core/server/providerAuthFlow";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { withCodexAppServerClient } from "./CodexProvider.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";
import { CodexNativeSelection as Selection } from "./CodexAuthSelection.ts";
import { materializeCodexShadowHome, type CodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

const Metadata = Schema.Struct({ nativeAuthSelection: Schema.optionalKey(Selection) });
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));
const OpaqueRecord = Schema.Record(Schema.String, Schema.Unknown);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(OpaqueRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(OpaqueRecord));
const isSetupError = Schema.is(ProviderSetupError);
export const nativeCodexMethods = [
  {
    id: "codex-browser",
    name: "Codex browser login",
    description: "Use the native Codex sign-in without token sharing.",
    type: "agent" as const,
  },
  {
    id: "codex-device",
    name: "Codex device-code login",
    description: "Sign in on another device using a fresh code.",
    type: "agent" as const,
  },
  {
    id: "codex-existing",
    name: "Existing CLI credentials",
    description: "Verify and use the configured Codex home's credentials.",
    type: "agent" as const,
  },
];

export function forwardNativeCodexCallback(
  instanceId: ProviderInstanceId,
  request: ReturnType<typeof codexNativeAuthorizationRequest>,
  value: string,
) {
  const failure = () =>
    new ProviderSetupError({
      instanceId,
      operation: "complete",
      detail:
        "Could not deliver this sign-in response to Codex. Check the redirect URL or start again.",
    });
  return Effect.try({
    try: () => codexCallbackUrl(value, request.redirectUri, request.state, request.clientId),
    catch: failure,
  }).pipe(
    Effect.flatMap((callback) =>
      Effect.callback<void, ProviderSetupError>((resume) => {
        const response = NodeHttp.request(
          {
            hostname: "127.0.0.1",
            port: 1455,
            path: `${callback.pathname}${callback.search}`,
            method: "GET",
            agent: false,
            headers: { host: new URL(request.redirectUri).host },
          },
          (incoming) => {
            incoming.on("error", () => resume(Effect.fail(failure())));
            incoming.on("end", () =>
              resume(
                (incoming.statusCode ?? 0) >= 200 && (incoming.statusCode ?? 0) < 400
                  ? Effect.void
                  : Effect.fail(failure()),
              ),
            );
            incoming.resume();
          },
        );
        response.on("error", () => resume(Effect.fail(failure())));
        response.end();
        return Effect.sync(() => response.destroy());
      }),
    ),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(failure()) }),
  );
}

export const makeCodexNativeAuth = Effect.fn("makeCodexNativeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly homeLayout: CodexHomeLayout;
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: Effect.Effect<
    { executablePath: string },
    ProviderSetupError,
    import("effect/Scope").Scope
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const selection = yield* ProviderCredentialStore.make("codex-chatgpt", options.instanceId);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fail = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const read = selection.get.pipe(
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed(Option.none<typeof Selection.Type>())
        : decodeMetadata(new TextDecoder().decode(bytes.value)).pipe(
            Effect.map((saved) => Option.fromUndefinedOr(saved.nativeAuthSelection)),
          ),
    ),
    Effect.mapError(() => fail("auth", "Could not read the selected Codex sign-in method.")),
  );
  const saveSelection = (value: typeof Selection.Type) =>
    withChatGptSessionLock(
      secrets.directory,
      selection.binding.key,
      options.instanceId,
      Effect.gen(function* () {
        const previous = yield* selection.get;
        const record = Option.isSome(previous)
          ? yield* decodeRecord(new TextDecoder().decode(previous.value))
          : {};
        const sessions =
          "sessions" in record
            ? record
            : typeof record.clientId === "string"
              ? { activeClientId: record.clientId, sessions: [record] }
              : { activeClientId: null, sessions: [] };
        const json = yield* encodeRecord({ ...sessions, nativeAuthSelection: value });
        yield* selection.set(new TextEncoder().encode(json));
      }),
    ).pipe(
      Effect.mapError(() =>
        fail(
          "auth",
          "Could not save the selected Codex sign-in method. The previous selection is unchanged.",
        ),
      ),
    );
  const nativeEnvironment = (homePath: string) => {
    const environment: NodeJS.ProcessEnv = { ...options.environment, CODEX_HOME: homePath };
    delete environment.ACCESS_TOKEN;
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    delete environment.T3CODE_CODEX_LAUNCH_ARGS;
    return environment;
  };
  const nativeArgs = (mode: "native" | "existing") =>
    `-c 'model_provider="openai"'${mode === "native" ? " -c 'cli_auth_credentials_store=\"file\"'" : ""}`;
  const authenticate = Effect.fn("CodexNativeAuth.authenticate")(function* (
    method: string,
    context: ProviderAuthFlowContext,
  ) {
    const executable = yield* options.executable;
    const existing = method === "codex-existing";
    const homePath = existing
      ? options.homeLayout.sharedHomePath
      : path.join(
          options.stateDir,
          "providers",
          "codex",
          options.instanceId,
          "native",
          yield* crypto.randomUUIDv4,
        );
    let activated = false;
    if (!existing)
      yield* materializeCodexShadowHome({
        ...options.homeLayout,
        mode: "authOverlay",
        effectiveHomePath: homePath,
      });
    yield* Effect.gen(function* () {
      const { client } = yield* withCodexAppServerClient({
        binaryPath: executable.executablePath,
        homePath,
        cwd: homePath,
        launchArgs: nativeArgs(existing ? "existing" : "native"),
        environment: nativeEnvironment(homePath),
      });
      if (!existing) {
        const completed = yield* Deferred.make<{ loginId?: string | null; success: boolean }>();
        yield* client.handleServerNotification("account/login/completed", (event) =>
          Deferred.succeed(completed, event).pipe(Effect.asVoid),
        );
        const login = yield* client.request("account/login/start", {
          type: method === "codex-device" ? "chatgptDeviceCode" : "chatgpt",
        });
        if (login.type !== "chatgpt" && login.type !== "chatgptDeviceCode")
          return yield* fail("auth", "Codex did not offer the requested ChatGPT sign-in method.");
        yield* Effect.addFinalizer(() =>
          activated
            ? Effect.void
            : client
                .request("account/login/cancel", { loginId: login.loginId })
                .pipe(Effect.ignore),
        );
        if (login.type === "chatgpt") {
          const request = yield* Effect.try({
            try: () => codexNativeAuthorizationRequest(login.authUrl),
            catch: () =>
              fail(
                "auth",
                "Codex returned an unsupported sign-in URL. Update Codex and try again.",
              ),
          });
          yield* context.setInteraction(
            {
              type: "browser",
              id: context.flowId,
              url: request.authorizationUrl,
              requiresConsent: false,
              acceptsCallback: true,
            },
            undefined,
            (value) => forwardNativeCodexCallback(options.instanceId, request, value),
          );
        } else {
          const url = new URL(login.verificationUrl);
          if (
            url.protocol !== "https:" ||
            !["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
            url.username ||
            url.password
          )
            return yield* fail(
              "auth",
              "Codex returned an unsupported device verification address.",
            );
          yield* context.setInteraction({
            type: "deviceCode",
            id: context.flowId,
            url: login.verificationUrl,
            userCode: login.userCode,
          });
        }
        const result = yield* Deferred.await(completed);
        if (!result.success || result.loginId !== login.loginId)
          return yield* fail(
            "auth",
            "Codex sign-in did not complete. Your previous sign-in is unchanged.",
          );
      }
      yield* context.verifying;
      const account = yield* client.request("account/read", { refreshToken: true });
      if (!account.account || account.account.type !== "chatgpt")
        return yield* fail(
          "auth",
          existing
            ? "The configured Codex home has no verified ChatGPT account. Sign in with Codex first, or choose browser or device-code login."
            : "Codex could not verify the new ChatGPT account.",
        );
      yield* saveSelection({ mode: existing ? "existing" : "native", homePath });
      activated = true;
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.suspend(() =>
          !existing && !activated
            ? fs.remove(homePath, { recursive: true }).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
  });
  return {
    read,
    authenticate: (method: string, context: ProviderAuthFlowContext) =>
      authenticate(method, context).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          isSetupError(cause)
            ? cause
            : fail(
                "auth",
                "Native Codex sign-in failed or could not verify the account. Your previous sign-in is unchanged. Check the selected environment's Codex installation and try again.",
              ),
        ),
      ),
    logout: Effect.gen(function* () {
      if (Option.isNone(yield* read)) return false;
      yield* saveSelection({ mode: "disconnected", homePath: "" });
      return true;
    }).pipe(Effect.mapError(() => fail("logout", "Could not disconnect native Codex."))),
    nativeEnvironment,
    nativeArgs,
  };
});
