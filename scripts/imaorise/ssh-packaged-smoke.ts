// Disposable hosted-runner acceptance of the actual bundled executable.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Hosted fixture only.");
const executable = NodePath.resolve(process.argv[2]!);
const version = process.argv[3]!;
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packaged-ssh-"));
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const key = "0123456789abcdef";
const run = (...args: string[]) =>
  exec(executable, args, {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      T3CODE_HOME: NodePath.join(home, ".t3-imaorise"),
      T3CODE_NO_BROWSER: "1",
    },
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
const start = async (resume: string) => {
  const result = await run("__ssh-helper", "managed-start", key, version, resume);
  const line = result.stdout.trim().split(/\r?\n/).at(-1)!;
  return JSON.parse(line) as { remotePort: number };
};
try {
  const first = await start("yes");
  const descriptor = await fetch(
    `http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`,
    { signal: AbortSignal.timeout(5000) },
  );
  const identity = (await descriptor.json()) as { serverVersion: string };
  if (identity.serverVersion !== version) throw new Error("Packaged SSH runtime version mismatch.");
  const reused = await start("no");
  if (reused.remotePort !== first.remotePort)
    throw new Error("Packaged SSH runtime was replaced on reconnect.");
  await run("__ssh-helper", "managed-stop", key);
  let blocked = false;
  try {
    await start("no");
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("Explicitly stopped packaged server restarted automatically.");
  console.log(`Verified packaged SSH supervisor lifecycle for ${version}.`);
} catch (error) {
  const folder = NodePath.join(home, ".t3-imaorise/ssh-managed/server");
  for (const name of ["server.log", "supervisor.log"])
    console.error(
      await NodeFSP.readFile(NodePath.join(folder, name), "utf8").then(
        (text) => text.slice(-5000),
        () => "No launcher log.",
      ),
    );
  throw error;
} finally {
  await run("__ssh-helper", "managed-stop", key).catch(() => {});
  await NodeFSP.rm(home, { recursive: true, force: true });
}
