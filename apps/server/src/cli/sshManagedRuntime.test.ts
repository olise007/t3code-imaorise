// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

const exec = promisify(execFile);
const fixture = path.join(import.meta.dirname, "testFixtures/sshManagedPeer.ts");
const key = "a1b2c3d4e5f60708";

it("reuses an authenticated supervisor after its launching command exits and stops only its child", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-managed-ssh-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (...args: string[]) =>
    exec(process.execPath, [fixture, ...args], { env, timeout: 20_000 });
  try {
    const first = JSON.parse((await run("start", key, "2.0.1-test")).stdout);
    const second = JSON.parse((await run("start", key, "2.0.1-test")).stdout);
    expect(second.remotePort).toBe(first.remotePort);
    const descriptor = await fetch(
      `http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`,
    );
    expect((await descriptor.json()).environmentId).toBe("fixture-environment");
    const file = path.join(home, ".t3-imaorise", "ssh-managed", key, "supervisor.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    expect(
      (
        await fetch(`http://127.0.0.1:${record.controlPort}/stop`, {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(403);
    await expect(run("start", key, "2.0.1-other")).rejects.toThrow("different managed runtime");
    await run("stop", key);
    await expect(fs.stat(file)).rejects.toThrow();
  } finally {
    await run("stop", key).catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("refuses malformed ownership records instead of signalling a saved PID", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-managed-invalid-"));
  const file = path.join(home, ".t3-imaorise", "ssh-managed", key, "supervisor.json");
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, controlPort: 1, token: "bad" }));
    await expect(
      exec(process.execPath, [fixture, "stop", key], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 5000,
      }),
    ).rejects.toThrow("Invalid supervisor record");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
