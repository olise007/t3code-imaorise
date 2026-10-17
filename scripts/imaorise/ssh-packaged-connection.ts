// @effect-diagnostics nodeBuiltinImport:off multipleEffectProvide:off globalFetch:off - Disposable hosted SSH acceptance only.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import {
  EnvironmentId,
  type DesktopSshEnvironmentTarget,
} from "../../packages/contracts/src/index.ts";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "../../packages/client-runtime/src/authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../packages/client-runtime/src/environment/descriptor.ts";
import * as Driver from "../../packages/client-runtime/src/connection/driver.ts";
import * as Resolver from "../../packages/client-runtime/src/connection/resolver.ts";
import {
  SshConnectionTarget,
  ConnectionTransientError,
} from "../../packages/client-runtime/src/connection/model.ts";
import * as RpcSession from "../../packages/client-runtime/src/rpc/session.ts";
import { SshEnvironmentManager } from "../../packages/ssh/src/tunnel.ts";

/** Uses the real SSH manager and forwarded endpoint after setup has returned. */
export const verifyPackagedSshConnection = (input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly archive: string;
  readonly version: string;
  readonly authSecret?: string;
}) =>
  Effect.gen(function* () {
    if (process.env.GITHUB_ACTIONS !== "true") return yield* Effect.die("Hosted fixture only.");
    const bytes = yield* Effect.promise(() => NodeFSP.readFile(input.archive));
    const artifact = {
      path: input.archive,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
    const stages: string[] = [];
    return yield* Effect.gen(function* () {
      const ssh = yield* SshEnvironmentManager;
      const first = yield* ssh.ensureEnvironment(input.target, {
        purpose: "setup",
        issuePairingToken: true,
        ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      });
      yield* Effect.addFinalizer(() => ssh.stopEnvironment(input.target).pipe(Effect.ignore));
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: first.httpBaseUrl,
      });
      const context =
        yield* Effect.context<Effect.Services<ReturnType<typeof ssh.ensureEnvironment>>>();
      const target = new SshConnectionTarget({
        environmentId: EnvironmentId.make(descriptor.environmentId),
        label: "Packaged SSH fixture",
        connectionId: "packaged-fixture",
      });
      let preparation = 0;
      const resolver = Resolver.ConnectionResolver.of({
        prepareForUpdate: () => Effect.die("unused"),
        prepare: () =>
          Effect.gen(function* () {
            preparation++;
            const bootstrap = yield* ssh.ensureEnvironment(input.target, {
              purpose: "reconnect",
              issuePairingToken: true,
            });
            if (preparation === 1 && bootstrap.httpBaseUrl !== first.httpBaseUrl)
              return yield* Effect.die("Healthy tunnel was replaced after setup returned.");
            const access = yield* bootstrapRemoteBearerSession({
              httpBaseUrl: bootstrap.httpBaseUrl,
              credential: bootstrap.pairingToken!,
            });
            const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
              httpBaseUrl: bootstrap.httpBaseUrl,
              wsBaseUrl: bootstrap.wsBaseUrl,
              bearerToken: access.access_token,
              connectionMethod: "ssh",
            });
            return {
              target,
              environmentId: target.environmentId,
              label: target.label,
              httpBaseUrl: bootstrap.httpBaseUrl,
              socketUrl,
              httpAuthorization: { _tag: "Bearer" as const, token: access.access_token },
            };
          }).pipe(
            Effect.provideContext(context),
            Effect.mapError(
              (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: cause instanceof Error ? cause.message : "SSH fixture preparation failed",
                }),
            ),
          ),
      });
      const driver = yield* Driver.make.pipe(
        Effect.provideService(Resolver.ConnectionResolver, resolver),
        Effect.provide(RpcSession.layer({})),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* driver.connect(
              { target, profile: Option.none(), enabled: true },
              () => Effect.void,
            );
            yield* lease.session.probe;
            yield* lease.session.initialConfig;
          }),
        );
        // First close only the socket; next close the owned tunnel, leaving the remote server alive.
        if (attempt === 1) yield* ssh.disconnectEnvironment(input.target);
      }
      if (stages.filter((stage) => stage.includes("Inspecting remote prerequisites")).length > 1)
        return yield* Effect.die("Reconnect repeated prerequisite inspection.");
      yield* ssh.stopEnvironment(input.target);
      const stopped = yield* ssh
        .ensureEnvironment(input.target, { purpose: "reconnect", issuePairingToken: true })
        .pipe(Effect.result);
      if (stopped._tag !== "Failure")
        return yield* Effect.die("Pairing restarted an explicitly stopped server.");
      yield* Effect.logInfo(
        "Passed packaged SSH setup return, application synchronization, socket/tunnel reconnect and explicit stop.",
      );
    }).pipe(
      Effect.provide(
        SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({
            bundles: { version: input.version, linux: artifact, windows: artifact },
          }),
          onProgress: (_target, stage) =>
            Effect.sync(() => {
              stages.push(stage);
            }),
        }),
      ),
      Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
    );
  }).pipe(Effect.scoped, Effect.timeout("180 seconds"));
