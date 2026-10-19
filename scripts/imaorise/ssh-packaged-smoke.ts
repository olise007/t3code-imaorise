// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalTimers:off - Hosted process fixture uses Node subprocess APIs, readiness deadlines, and sanitized evidence.
// Disposable hosted-runner acceptance of the actual bundled executable.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { verifyTerminalIsolation } from "./ssh-terminal-lifecycle.ts";
import { verifyPackagedPtyHelper } from "./packaged-pty-helper.ts";
import { sanitizeSetupOutput } from "../../packages/shared/src/setupDetails.ts";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Socket from "effect/socket/Socket";
import { EnvironmentId } from "../../packages/contracts/src/index.ts";
import {
  BearerConnectionTarget,
  SshConnectionTarget,
} from "../../packages/client-runtime/src/connection/model.ts";
import { appendOrchestrationProtocol } from "../../packages/client-runtime/src/connection/compatibility.ts";
import * as RpcSession from "../../packages/client-runtime/src/rpc/session.ts";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "../../packages/client-runtime/src/authorization/remote.ts";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Hosted fixture only.");
const executable = NodePath.resolve(process.argv[2]!);
const version = process.argv[3]!;
const standalone = process.argv.includes("--standalone");
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packaged-ssh-"));
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const key = "0123456789abcdef";
const fixtureEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  T3CODE_HOME: NodePath.join(home, ".t3-imaorise"),
  T3CODE_NO_BROWSER: "1",
};
const run = (...args: string[]) =>
  exec(executable, args, { env: fixtureEnv, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
let server: NodeChildProcess.ChildProcess | undefined;
let serverOutput = "";
const startStandalone = async () => {
  const listener = NodeNet.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No standalone fixture port.");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const userdata = NodePath.join(fixtureEnv.T3CODE_HOME, "userdata");
  await NodeFSP.mkdir(userdata, { recursive: true });
  return await new Promise<{ remotePort: number }>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      watcher.close();
      if (error) reject(error);
      else resolve({ remotePort: port });
    };
    const inspect = () => {
      void NodeFSP.readFile(NodePath.join(userdata, "server-runtime.json"), "utf8")
        .then((text) => {
          const runtime = JSON.parse(text) as { pid?: number; port?: number };
          if (runtime.pid === server?.pid && runtime.port === port) finish();
        })
        .catch(() => {
          /* A subsequent persisted-state event completes an atomic write. */
        });
    };
    const watcher = NodeFS.watch(userdata, inspect);
    watcher.on("error", finish);
    const deadline = setTimeout(
      () => finish(new Error("Standalone server did not persist readiness.")),
      60_000,
    );
    server = NodeChildProcess.spawn(
      executable,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
        "--base-dir",
        fixtureEnv.T3CODE_HOME,
      ],
      { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const stream of [server.stdout, server.stderr])
      stream?.on("data", (chunk) => {
        serverOutput = (serverOutput + String(chunk)).slice(-16_000);
      });
    server.once("error", finish);
    server.once("exit", (code, signal) =>
      finish(new Error(`Standalone server exited before readiness: ${code ?? signal}.`)),
    );
    inspect();
  });
};
const stopStandalone = async () => {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => server!.once("exit", () => resolve()));
  if (HostProcess.Platform.defaultValue() === "win32")
    await exec("taskkill.exe", ["/pid", String(server.pid), "/t", "/f"], {
      timeout: 10_000,
      maxBuffer: 4096,
    });
  else server.kill("SIGTERM");
  await exited;
};
const start = async (resume: string) => {
  const result = await run("__ssh-helper", "managed-start", key, version, resume);
  const line = result.stdout.trim().split(/\r?\n/).at(-1)!;
  return JSON.parse(line) as { remotePort: number };
};
let primaryFailure: Error | undefined;
try {
  await verifyPackagedPtyHelper(executable);
  const first = standalone ? await startStandalone() : await start("yes");
  const descriptor = await fetch(
    `http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`,
    { signal: AbortSignal.timeout(5000) },
  );
  const identity = (await descriptor.json()) as { serverVersion: string; environmentId: string };
  if (identity.serverVersion !== version)
    throw new Error("Packaged server runtime version mismatch.");
  const reused = standalone ? first : await start("no");
  if (reused.remotePort !== first.remotePort)
    throw new Error("Packaged server runtime was replaced on reconnect.");
  const issued = JSON.parse(
    (standalone
      ? await run("auth", "pairing", "create", "--base-dir", fixtureEnv.T3CODE_HOME, "--json")
      : await run("__ssh-helper", "managed-pair", key, version)
    ).stdout,
  ) as {
    credential: string;
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const httpBaseUrl = `http://127.0.0.1:${first.remotePort}/`;
      const access = yield* bootstrapRemoteBearerSession({
        httpBaseUrl,
        credential: issued.credential,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
              httpBaseUrl,
              wsBaseUrl: httpBaseUrl.replace("http:", "ws:"),
              bearerToken: access.access_token,
              connectionMethod: standalone ? "direct" : "ssh",
            });
            const factory = yield* RpcSession.make();
            const session = yield* factory.connect({
              target: new (standalone ? BearerConnectionTarget : SshConnectionTarget)({
                environmentId: EnvironmentId.make(identity.environmentId),
                label: "Packaged server fixture",
                connectionId: "packaged-ssh",
              }),
              environmentId: EnvironmentId.make(identity.environmentId),
              label: "Packaged server fixture",
              httpBaseUrl,
              socketUrl: appendOrchestrationProtocol(socketUrl),
              httpAuthorization: { _tag: "Bearer", token: access.access_token },
            });
            yield* session.ready;
            yield* session.probe;
            const config = yield* session.initialConfig;
            if (attempt === 0) yield* verifyTerminalIsolation(session, config);
          }),
        );
      }
    }).pipe(
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
      Effect.timeout("60 seconds"),
    ),
  );
  console.log(
    `Verified packaged bearer authorization, WebSocket synchronization, RPC probe and reconnect for ${version}.`,
  );
  if (standalone) {
    await stopStandalone();
    const answered = await fetch(
      `http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`,
      { signal: AbortSignal.timeout(2000) },
    ).then(
      () => true,
      () => false,
    );
    if (answered) throw new Error("Stopped standalone fixture still answers.");
    console.log(
      `Verified standalone Windows server, terminal isolation and owned shutdown for ${version}.`,
    );
  } else {
    await run("__ssh-helper", "managed-stop", key);
    let blocked = false;
    try {
      await start("no");
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error("Explicitly stopped packaged server restarted automatically.");
    console.log(`Verified packaged SSH supervisor lifecycle for ${version}.`);
  }
} catch (error) {
  primaryFailure = new Error(
    sanitizeSetupOutput(
      error instanceof Error
        ? `${error.message}\n${"stderr" in error ? String(error.stderr) : ""}\n${"stdout" in error ? String(error.stdout) : ""}`
        : String(error),
    ).slice(-6000),
  );
  console.error(`Packaged server fixture failed: ${primaryFailure.message}`);
  if (standalone) console.error(sanitizeSetupOutput(serverOutput).slice(-6000));
  const folder = NodePath.join(home, ".t3-imaorise/ssh-managed/server");
  for (const name of ["server.log", "supervisor.log"])
    console.error(
      await NodeFSP.readFile(NodePath.join(folder, name), "utf8").then(
        (text) => sanitizeSetupOutput(text).slice(-5000),
        () => "No launcher log.",
      ),
    );
  throw primaryFailure;
} finally {
  await (standalone ? stopStandalone() : run("__ssh-helper", "managed-stop", key)).catch(
    (error) => {
      console.error(
        sanitizeSetupOutput(`Owned fixture stop failed: ${String(error)}`).slice(-2000),
      );
    },
  );
  try {
    await NodeFSP.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    if (!primaryFailure) throw error;
    console.error(
      sanitizeSetupOutput(`Owned fixture cleanup failed: ${String(error)}`).slice(-2000),
    );
  }
}
