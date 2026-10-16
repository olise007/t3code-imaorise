// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { verifyBundledResourceMonitor } from "./sshManagedRuntime.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const fixture = NodePath.join(import.meta.dirname, "testFixtures/sshManagedPeer.ts");
const key = "a1b2c3d4e5f60708";

it.each(["platform", "flat"])(
  "verifies the %s archive monitor and completes its shutdown handshake",
  async (layout) => {
    if (process.platform === "win32") return;
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native check-"));
    const directory =
      layout === "platform"
        ? NodePath.join(root, "resource-monitor", `linux-${process.arch}`)
        : NodePath.join(root, "resource-monitor");
    try {
      await NodeFSP.mkdir(directory, { recursive: true });
      const monitor = NodePath.join(directory, "t3-resource-monitor");
      await NodeFSP.writeFile(
        monitor,
        `#!/bin/sh\nprintf '%s\\n' '{"type":"hello"}'\nIFS= read -r command || exit 2\n[ "$command" = '{"version":1,"type":"shutdown"}' ] || exit 3\n`,
        { mode: 0o700 },
      );
      await verifyBundledResourceMonitor(root, "linux", process.arch);
      await NodeFSP.writeFile(monitor, "#!/bin/sh\nexit 0\n");
      await expect(verifyBundledResourceMonitor(root, "linux", process.arch)).rejects.toThrow(
        "could not start",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

it("reports an absent native monitor before runtime activation", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-missing-"));
  try {
    await expect(
      verifyBundledResourceMonitor(root, process.platform, process.arch),
    ).rejects.toThrow("missing");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("reuses an authenticated supervisor after its launching command exits and stops only its child", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-managed-ssh-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (...args: string[]) =>
    exec(process.execPath, [fixture, ...args], { env, timeout: 70_000 });
  try {
    const first = JSON.parse((await run("start", key, "2.0.1-test")).stdout);
    const second = JSON.parse((await run("start", key, "2.0.1-test")).stdout);
    expect(second.remotePort).toBe(first.remotePort);
    const alternate = JSON.parse((await run("start", "ffffffffffffffff", "2.0.1-test")).stdout);
    expect(alternate.remotePort).toBe(first.remotePort);
    const descriptor = await fetch(
      `http://127.0.0.1:${first.remotePort}/.well-known/t3/environment`,
    );
    expect(((await descriptor.json()) as { environmentId: string }).environmentId).toBe(
      "fixture-environment",
    );
    const file = NodePath.join(home, ".t3-imaorise", "ssh-managed", "server", "supervisor.json");
    const record = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    expect(
      (
        await fetch(`http://127.0.0.1:${record.controlPort}/stop`, {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(403);
    await expect(run("start", key, "2.0.1-other")).rejects.toThrow("different managed runtime");
    const provider = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(home, ".t3-imaorise/userdata/fixture-provider.json"),
        "utf8",
      ),
    ) as { pid: number };
    await run("stop", key);
    expect(() => process.kill(provider.pid, 0)).toThrow();
    await expect(NodeFSP.stat(file)).rejects.toThrow();
    await expect(run("start", key, "2.0.1-test")).rejects.toThrow("explicitly stopped");
    await expect(run("start", "ffffffffffffffff", "2.0.1-test")).rejects.toThrow(
      "explicitly stopped",
    );
    const resumed = JSON.parse((await run("resume", key, "2.0.1-test")).stdout);
    expect(resumed.remotePort).toBeGreaterThan(0);
    await run("stop", key);
  } catch (error) {
    const log = await NodeFSP.readFile(
      NodePath.join(home, ".t3-imaorise", "ssh-managed", "server", "server.log"),
      "utf8",
    ).catch(() => "No supervisor log was written.");
    const supervisorLog = await NodeFSP.readFile(
      NodePath.join(home, ".t3-imaorise", "ssh-managed", "server", "supervisor.log"),
      "utf8",
    ).catch(() => "No detached launcher log was written.");
    throw new Error(
      `${error instanceof Error ? error.message : "Supervisor fixture failed"}\n${log.slice(-5000)}\n${supervisorLog.slice(-5000)}`,
    );
  } finally {
    await run("stop", key).catch(() => {});
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}, 90_000);

it("refuses malformed ownership records instead of signalling a saved PID", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-managed-invalid-"));
  const file = NodePath.join(home, ".t3-imaorise", "ssh-managed", "server", "supervisor.json");
  try {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(
      file,
      JSON.stringify({ pid: process.pid, controlPort: 1, token: "bad" }),
    );
    await expect(
      exec(process.execPath, [fixture, "stop", key], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 5000,
      }),
    ).rejects.toThrow("Invalid supervisor record");
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
