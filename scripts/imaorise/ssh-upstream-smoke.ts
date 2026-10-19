// @effect-diagnostics nodeBuiltinImport:off multipleEffectProvide:off globalFetch:off globalTimers:off - Hosted disposable SSH fixture; no real hosts or user configuration.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { OFFICIAL_SSH_SERVER_VERSION } from "../../packages/shared/src/cliRelease.ts";
import { EnvironmentId } from "../../packages/contracts/src/index.ts";
import * as SshAuth from "../../packages/ssh/src/auth.ts";
import { SshEnvironmentManager } from "../../packages/ssh/src/tunnel.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../packages/client-runtime/src/environment/descriptor.ts";
import {
  orchestrationProtocolCompatibilityError,
  appendOrchestrationProtocol,
} from "../../packages/client-runtime/src/connection/compatibility.ts";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "../../packages/client-runtime/src/authorization/remote.ts";
import { SshConnectionTarget } from "../../packages/client-runtime/src/connection/model.ts";
import * as RpcSession from "../../packages/client-runtime/src/rpc/session.ts";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.getuid?.() !== 0 ||
  process.env.T3_UPSTREAM_SSH_FIXTURE !== "container"
)
  throw new Error("Run only in the dedicated hosted Linux container.");
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-upstream-"));
const remoteHome = NodePath.join(root, "remote home");
await NodeFSP.chmod(root, 0o755);
await exec("useradd", ["-m", "-d", remoteHome, "-s", "/bin/sh", "-p", "x", "t3fixture"]);
await NodeFSP.mkdir("/run/sshd", { recursive: true });
const identity = NodePath.join(root, "identity"),
  hostKey = NodePath.join(root, "hostkey");
await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", identity, "-q"]);
await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", hostKey, "-q"]);
const authorized = NodePath.join(root, "authorized_keys");
await NodeFSP.copyFile(`${identity}.pub`, authorized);
const listener = NodeNet.createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address();
if (!address || typeof address === "string") throw new Error("No SSH fixture port.");
const port = address.port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const config = NodePath.join(root, "sshd_config");
await NodeFSP.writeFile(
  config,
  `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nAuthorizedKeysFile ${authorized}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nLogLevel INFO\n`,
);
const sourceSsh = NodePath.join(NodeOS.homedir(), ".ssh");
await NodeFSP.mkdir(sourceSsh, { recursive: true, mode: 0o700 });
// The whole container is disposable; never run this against an installed client's SSH config.
await NodeFSP.writeFile(
  NodePath.join(sourceSsh, "config"),
  `Host t3-upstream-fixture\n HostName 127.0.0.1\n Port ${port}\n User t3fixture\n IdentityFile ${identity}\n UserKnownHostsFile ${root}/known_hosts\n StrictHostKeyChecking yes\n BatchMode yes\n`,
);
await NodeFSP.writeFile(
  NodePath.join(root, "known_hosts"),
  `[127.0.0.1]:${port} ${(await NodeFSP.readFile(`${hostKey}.pub`, "utf8")).trim()}\n`,
);
const daemon = NodeChildProcess.spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
  stdio: ["ignore", "ignore", "pipe"],
});
try {
  await new Promise<void>((resolve, reject) => {
    let log = "";
    const deadline = setTimeout(() => reject(new Error("Fixture SSH readiness timeout")), 10_000);
    daemon.once("error", reject);
    daemon.stderr.on("data", (chunk) => {
      log += String(chunk);
      if (log.includes("Server listening on")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    daemon.once("exit", () => {
      clearTimeout(deadline);
      reject(new Error("Fixture SSH exited"));
    });
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const target = {
          alias: "t3-upstream-fixture",
          hostname: "127.0.0.1",
          username: "t3fixture",
          port,
        };
        let bootstrap = yield* manager.ensureEnvironment(target, { issuePairingToken: true });
        yield* Effect.addFinalizer(() => manager.disconnectEnvironment(target).pipe(Effect.ignore));
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: bootstrap.httpBaseUrl,
        });
        if (descriptor.serverVersion !== OFFICIAL_SSH_SERVER_VERSION)
          throw new Error("Unexpected official runtime version");
        const incompatible = orchestrationProtocolCompatibilityError(descriptor);
        if (incompatible) return yield* incompatible;
        const remotePort = Number(
          (yield* Effect.promise(() =>
            exec("ssh", [target.alias, 'cat "$HOME"/.t3/ssh-launch/*/port']),
          )).stdout.trim(),
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          const healthy = yield* manager.ensureEnvironment(target, { issuePairingToken: true });
          if (healthy.httpBaseUrl !== bootstrap.httpBaseUrl)
            throw new Error("Healthy tunnel was replaced");
          const access = yield* bootstrapRemoteBearerSession({
            httpBaseUrl: healthy.httpBaseUrl,
            credential: healthy.pairingToken!,
          });
          const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
            httpBaseUrl: healthy.httpBaseUrl,
            wsBaseUrl: healthy.wsBaseUrl,
            bearerToken: access.access_token,
            connectionMethod: "ssh",
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const factory = yield* RpcSession.make();
              const session = yield* factory.connect({
                target: new SshConnectionTarget({
                  environmentId: EnvironmentId.make(descriptor.environmentId),
                  label: "Official runtime fixture",
                  connectionId: "upstream-fixture",
                }),
                environmentId: descriptor.environmentId,
                label: descriptor.label,
                httpBaseUrl: healthy.httpBaseUrl,
                socketUrl: appendOrchestrationProtocol(socketUrl),
                httpAuthorization: { _tag: "Bearer", token: access.access_token },
              });
              yield* session.ready;
              yield* session.probe;
              const config = yield* session.initialConfig;
              if (config.environment.serverVersion !== OFFICIAL_SSH_SERVER_VERSION)
                throw new Error("Application config mismatch");
            }),
          );
        }
        yield* manager.disconnectEnvironment(target);
        const answered = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${remotePort}/.well-known/t3/environment`, {
            signal: AbortSignal.timeout(2000),
          }).then(
            () => true,
            () => false,
          ),
        );
        if (answered)
          throw new Error("Removing the owned upstream connection left its server running");
        bootstrap = yield* manager.ensureEnvironment(target, { issuePairingToken: false });
        const restarted = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: bootstrap.httpBaseUrl,
        });
        if (restarted.environmentId !== descriptor.environmentId)
          throw new Error("Reconnect changed environment identity");
        const personalData = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(remoteHome, ".t3-imaorise")).then(
            () => true,
            () => false,
          ),
        );
        if (personalData) throw new Error("Official setup modified Imaorise data");
        process.stdout.write(
          `Passed official ${OFFICIAL_SSH_SERVER_VERSION}: download/checksum, SSH launch, protocol, authorization, WebSocket synchronization, healthy tunnel reuse, removal and reconnect.\n`,
        );
      }),
    ).pipe(
      Effect.provide(
        SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({ archiveVersion: OFFICIAL_SSH_SERVER_VERSION }),
        }),
      ),
      Effect.provide(SshAuth.SshPasswordPrompt.disabledLayer),
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.provide(NetService.layer),
      Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
      Effect.timeout("6 minutes"),
    ),
  );
} finally {
  if (daemon.exitCode === null) {
    const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    await exited;
  }
  await NodeFSP.rm(root, { recursive: true, force: true });
}
