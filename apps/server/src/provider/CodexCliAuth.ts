import {
  ProviderSetupError,
  type CodexSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { makeCodexNativeAuth, nativeCodexMethods } from "./CodexNativeAuth.ts";
import type { CodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import type { CodexEffectiveRuntime } from "./CodexManagedRuntime.ts";

/** Native authentication does not change which installer owns an existing CLI. */
export const makeCodexCliAuth = Effect.fn("makeCodexCliAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeLayout: CodexHomeLayout;
}) {
  const native = yield* makeCodexNativeAuth({
    ...options,
    existingHomePath: options.homeLayout.effectiveHomePath ?? options.homeLayout.sharedHomePath,
    disconnectExistingOnLogout: true,
    executable: Effect.succeed({ executablePath: options.config.binaryPath || "codex" }),
  });
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: {
      owner: "provider",
      key: `codex:${options.homeLayout.effectiveHomePath ?? options.homeLayout.sharedHomePath}`,
    },
    methods: Effect.succeed(nativeCodexMethods),
    defaultMethodId: "codex-browser",
    authenticate: native.authenticate,
    logout: native.logout.pipe(Effect.asVoid),
  });
  const resolve = Effect.gen(function* () {
    const selected = yield* native.read;
    if (Option.isNone(selected))
      return {
        config: options.config,
        environment: options.environment,
        revision: "existing-cli",
      } satisfies CodexEffectiveRuntime;
    const value = selected.value;
    if (value.mode === "disconnected")
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "auth",
        detail: "Sign in with Codex to use this provider.",
      });
    return {
      config: {
        ...options.config,
        homePath: value.homePath,
        launchArgs: `${options.config.launchArgs} ${native.nativeArgs(value.mode)}`.trim(),
      },
      environment: native.nativeEnvironment(value.homePath),
      revision: `${value.mode}:${value.homePath}`,
    } satisfies CodexEffectiveRuntime;
  });
  return { controller, resolve };
});
