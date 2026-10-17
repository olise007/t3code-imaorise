// @effect-diagnostics nodeBuiltinImport:off multipleEffectProvide:off globalTimers:off globalFetch:off - Native hosted process readiness and HTTP probes use wall time, without real SSH configuration or live state.
import { verifyPackagedSshConnection } from "./ssh-packaged-connection.ts";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "../../packages/ssh/src/auth.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { uploadRuntimeArchive } from "../../packages/ssh/src/bundledRuntime.ts";
import { runSshCommand } from "../../packages/ssh/src/command.ts";

if (process.env.GITHUB_ACTIONS !== "true" || process.getuid?.() !== 0)
  throw new Error("This SSH fixture runs only inside the hosted Linux test container.");
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
// The disposable container's root account is locked by its base image. Give it
// an unusable, unlocked hash for public-key-only loopback SSH (password auth is off).
await exec("usermod", ["-p", "x", "root"]);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh's fixture-"));
const remoteHome = NodePath.join(root, "remote home");
await NodeFSP.mkdir(remoteHome);
await NodeFSP.mkdir("/run/sshd", { recursive: true });
const key = NodePath.join(root, "identity");
const hostKey = NodePath.join(root, "hostkey");
const config = NodePath.join(root, "sshd_config");
const clientConfig = NodePath.join(root, "config");
const peer = NodePath.resolve("apps/server/src/cli/testFixtures/sshManagedPeer.ts");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const listener = NodeNet.createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address();
if (!address || typeof address === "string") throw new Error("Could not reserve SSH port.");
const port = address.port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key, "-q"]);
await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", hostKey, "-q"]);
const authorized = NodePath.join(root, "authorized_keys");
await NodeFSP.copyFile(`${key}.pub`, authorized);
await NodeFSP.writeFile(
  config,
  `Port ${port}\nListenAddress 127.0.0.1\nHostKey "${hostKey}"\nAuthorizedKeysFile "${authorized}"\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nPermitRootLogin yes\nSubsystem sftp internal-sftp\nLogLevel INFO\n`,
);
await NodeFSP.writeFile(
  NodePath.join(root, "known_hosts"),
  `[127.0.0.1]:${port} ${(await NodeFSP.readFile(`${hostKey}.pub`, "utf8")).trim()}\n`,
);
await NodeFSP.writeFile(
  clientConfig,
  `Host t3-fixture\n HostName 127.0.0.1\n Port ${port}\n User root\n IdentityFile "${key}"\n UserKnownHostsFile "${NodePath.join(root, "known_hosts")}"\n StrictHostKeyChecking yes\n BatchMode yes\n`,
);
const daemon = NodeChildProcess.spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
  stdio: ["ignore", "ignore", "pipe"],
});
const run = async (operation: string, version = "2.0.1-test") => {
  const command = [
    "env",
    `HOME=${remoteHome}`,
    `USERPROFILE=${remoteHome}`,
    process.execPath,
    peer,
    operation,
    "3333333333333333",
    version,
  ]
    .map(quote)
    .join(" ");
  return await exec("ssh", ["-F", clientConfig, "t3-fixture", command], { timeout: 20_000 });
};
try {
  await new Promise<void>((resolve, reject) => {
    let log = "";
    const deadline = setTimeout(() => reject(new Error("SSH fixture did not start.")), 10_000);
    daemon.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    daemon.stderr.on("data", (chunk) => {
      log += String(chunk);
      if (log.includes("Server listening on")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    daemon.once("exit", () => {
      clearTimeout(deadline);
      reject(new Error("SSH fixture exited before readiness."));
    });
  });
  const home = NodePath.join(root, "source-home");
  await NodeFSP.mkdir(NodePath.join(home, ".t3-imaorise", "ssh"), { recursive: true });
  await NodeFSP.copyFile(
    NodePath.join(root, "known_hosts"),
    NodePath.join(home, ".t3-imaorise", "ssh", "known_hosts"),
  );
  const payload = Buffer.alloc(4 * 1024 * 1024, 37);
  const archive = NodePath.join(root, "source's [runtime] archive.tar.gz");
  await NodeFSP.writeFile(archive, payload);
  const hash = NodeCrypto.createHash("sha256").update(payload).digest("hex");
  const target = {
    alias: "literal-fixture",
    hostname: "127.0.0.1",
    username: "root",
    port,
    manual: {
      profileId: "linux-sftp",
      name: "Linux SFTP",
      authentication: { type: "key" as const, identityFile: key },
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* uploadRuntimeArchive(target, {}, "linux", archive, hash, "-fixture");
      const verified = yield* runSshCommand(target, {
        remoteCommandArgs: ["sh", "-s"],
        stdin: `set -eu\nf="$HOME/.t3-imaorise/runtime/upload-${hash}-fixture.tar.gz"\nsha256sum "$f"\nrm -f "$f"\n`,
      });
      if (!verified.stdout.includes(hash))
        throw new Error("Linux SFTP archive checksum did not match.");
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, home),
    ),
  );
  process.stdout.write(
    "Passed native SFTP archive transfer with a literal special-character path.\n",
  );
  if (process.env.T3_SSH_FIXTURE_ARCHIVE && process.env.T3_SSH_FIXTURE_VERSION) {
    await Effect.runPromise(
      verifyPackagedSshConnection({
        target,
        archive: process.env.T3_SSH_FIXTURE_ARCHIVE,
        version: process.env.T3_SSH_FIXTURE_VERSION,
        trustFile: NodePath.join(home, ".t3-imaorise", "ssh", "known_hosts"),
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeHttpClient.layerUndici),
        Effect.provide(NetService.layer),
        Effect.provideService(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              request.challenge === "host-key"
                ? Effect.succeed("yes")
                : Effect.die("Unexpected Linux fixture authentication challenge."),
          }),
        ),
        Effect.provideService(HostProcess.HomeDirectory, home),
      ),
    );
  }
  const first = JSON.parse((await run("start")).stdout);
  const second = JSON.parse((await run("start", "2.0.2-newer")).stdout);
  if (first.remotePort !== second.remotePort)
    throw new Error("SSH reconnect replaced the remote server.");
  const pairing = JSON.parse((await run("pair", "2.0.2-newer")).stdout);
  if (pairing.credential !== "disposable-fixture-credential")
    throw new Error("Compatible runtime pairing failed.");
  const descriptor = await fetch(`http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`);
  if (!descriptor.ok) throw new Error("Remote server did not survive SSH session exit.");
  await run("stop");
  process.stdout.write(
    "Passed Linux OpenSSH session survival, source configuration and reconnect.\n",
  );
} finally {
  await run("stop").catch(() => {});
  if (daemon.exitCode === null) {
    const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    await exited;
  }
  await NodeFSP.rm(root, { recursive: true, force: true });
}
