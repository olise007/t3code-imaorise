// Hosted fixture only: no real user's SSH configuration, keys, or T3 home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

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
  `Port ${port}\nListenAddress 127.0.0.1\nHostKey "${hostKey}"\nAuthorizedKeysFile "${authorized}"\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nPermitRootLogin yes\nLogLevel INFO\n`,
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
const run = async (operation: string) => {
  const command = [
    "env",
    `HOME=${remoteHome}`,
    `USERPROFILE=${remoteHome}`,
    process.execPath,
    peer,
    operation,
    "3333333333333333",
    "2.0.1-test",
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
  const first = JSON.parse((await run("start")).stdout);
  const second = JSON.parse((await run("start")).stdout);
  if (first.remotePort !== second.remotePort)
    throw new Error("SSH reconnect replaced the remote server.");
  const descriptor = await fetch(`http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`);
  if (!descriptor.ok) throw new Error("Remote server did not survive SSH session exit.");
  await run("stop");
  console.log("Passed Linux OpenSSH session survival, source configuration and reconnect.");
} finally {
  await run("stop").catch(() => {});
  if (daemon.exitCode === null) {
    const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    await exited;
  }
  await NodeFSP.rm(root, { recursive: true, force: true });
}
