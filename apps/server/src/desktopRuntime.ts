// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off globalTimers:off globalConsole:off
// This process boundary runs before the server's Effect runtime. Its child owns
// the database/providers; this client only forwards traffic and verifies ownership.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { isAssignedPortConflict } from "@t3tools/shared/listenPortConflict";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type DesktopRuntimeRequestInput,
  type DesktopBackgroundSettings,
} from "@t3tools/contracts";

export const MANAGED_RUNTIME_PROTOCOL = 2;

export interface RuntimeRecord {
  protocol: number;
  pid: number;
  birth: string;
  nonce: string;
  port: number;
  secretHash: string;
  executable: string;
  entry: string;
  stateDirectory: string;
  environmentId?: string;
  serverVersion?: string;
  serverProtocol: number;
}

async function birth(pid: number) {
  const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}

export async function ownsRuntime(record: RuntimeRecord) {
  try {
    if ((await birth(record.pid)) !== record.birth) return false;
    if ((await NodeFSP.readlink(`/proc/${record.pid}/exe`)) !== record.executable) return false;
    const env = await NodeFSP.readFile(`/proc/${record.pid}/environ`, "utf8");
    return env.split("\0").includes(`T3CODE_MANAGED_RUNTIME_ID=${record.nonce}`);
  } catch {
    return false;
  }
}

export async function verifyHealth(record: RuntimeRecord) {
  if (!(await ownsRuntime(record)))
    throw new Error("Background server identity is no longer valid.");
  const response = await fetch(`http://127.0.0.1:${record.port}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok)
    throw new Error(
      "Background server is running but unavailable. Stop it explicitly before restarting.",
    );
  const descriptor: unknown = await response.json();
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    !("environmentId" in descriptor) ||
    typeof descriptor.environmentId !== "string" ||
    !("orchestrationProtocolVersion" in descriptor) ||
    typeof descriptor.orchestrationProtocolVersion !== "number"
  )
    throw new Error("Invalid background server descriptor.");
  const expected = (
    await NodeFSP.readFile(NodePath.join(record.stateDirectory, "environment-id"), "utf8")
  ).trim();
  if (
    !expected ||
    descriptor.environmentId !== expected ||
    (record.environmentId && record.environmentId !== expected)
  )
    throw new Error("Background server environment identity does not match its profile.");
  if (descriptor.orchestrationProtocolVersion !== record.serverProtocol)
    throw new Error(
      "Background server protocol is incompatible. Stop it explicitly before restarting.",
    );
  record.environmentId = expected;
  if ("serverVersion" in descriptor && typeof descriptor.serverVersion === "string")
    record.serverVersion = descriptor.serverVersion;
  if (!(await ownsRuntime(record)))
    throw new Error("Background server exited during its health check.");
}

export async function readRuntime(directory: string): Promise<RuntimeRecord | null> {
  try {
    const record: RuntimeRecord = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "runtime.json"), "utf8"),
    );
    if (
      !Number.isInteger(record.pid) ||
      record.pid < 1 ||
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535
    )
      throw new Error("Invalid runtime identity.");
    if (
      !Number.isInteger(record.protocol) ||
      typeof record.birth !== "string" ||
      !/^\d+$/.test(record.birth) ||
      typeof record.nonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.nonce) ||
      typeof record.executable !== "string" ||
      !NodePath.isAbsolute(record.executable) ||
      typeof record.secretHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.secretHash)
    )
      throw new Error("Invalid runtime identity.");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRuntimePreferences(directory: string) {
  try {
    const value: { keepAgentsRunning?: unknown } = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "preferences.json"), "utf8"),
    );
    if (typeof value.keepAgentsRunning !== "boolean")
      throw new Error("Invalid background runtime preference.");
    return { keepAgentsRunning: value.keepAgentsRunning };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { keepAgentsRunning: true };
    throw error;
  }
}

export async function writeRuntimePreferences(
  directory: string,
  keepAgentsRunning: boolean,
  overwrite = true,
) {
  if (
    !overwrite &&
    (await NodeFSP.access(NodePath.join(directory, "preferences.json")).then(
      () => true,
      () => false,
    ))
  )
    return readRuntimePreferences(directory);
  const temporary = NodePath.join(directory, `preferences-${NodeCrypto.randomUUID()}.json`);
  await NodeFSP.writeFile(temporary, JSON.stringify({ keepAgentsRunning }), { mode: 0o600 });
  if (overwrite) await NodeFSP.rename(temporary, NodePath.join(directory, "preferences.json"));
  else {
    try {
      await NodeFSP.link(temporary, NodePath.join(directory, "preferences.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await NodeFSP.unlink(temporary);
    }
  }
  return readRuntimePreferences(directory);
}

export async function runManagedRuntimeAction(
  input: DesktopRuntimeRequestInput,
  identity: { directory: string; nonce: string; distro: string },
): Promise<DesktopBackgroundSettings> {
  const record = await readRuntime(identity.directory);
  if (
    !record ||
    record.pid !== process.pid ||
    record.nonce !== identity.nonce ||
    !(await ownsRuntime(record))
  )
    throw new Error("This server's managed runtime identity could not be verified.");
  let preferences = await readRuntimePreferences(identity.directory);
  if (input.action === "set") {
    if (
      !input.settings ||
      (input.settings.distro !== undefined && input.settings.distro !== identity.distro)
    )
      throw new Error("Background preferences target a different environment.");
    if (input.settings.keepAgentsRunning !== undefined)
      preferences = await writeRuntimePreferences(
        identity.directory,
        input.settings.keepAgentsRunning,
      );
  }
  if (input.action === "stop") {
    // Acknowledge the explicit request before graceful server shutdown closes
    // the transport. This PID is the attested process executing this method.
    const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 250);
    timer.unref();
  }
  return {
    closeToTray: true,
    minimizeToTray: false,
    distro: identity.distro,
    ...preferences,
    serverRunning: input.action !== "stop",
  };
}

async function ensureRuntimeDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Runtime directory is not owned by this user.");
  await NodeFSP.chmod(directory, 0o700);
}

async function acquireRuntimeLock(directory: string) {
  await ensureRuntimeDirectory(directory);
  const lockPath = NodePath.join(directory, "startup.lock");
  const file = await NodeFSP.open(lockPath, "a", 0o600);
  await file.chmod(0o600);
  await file.close();
  // Kernel locking releases on launcher death and avoids racing stale-lock
  // deletion against a new owner. stdin EOF releases the captured keeper.
  const keeper = NodeChildProcess.spawn(
    "flock",
    ["-x", "-w", "15", lockPath, "sh", "-c", "printf 'locked\\n'; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  keeper.stdin.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    keeper.once("error", reject);
    keeper.once("exit", () =>
      reject(
        new Error("Another background server startup is still running, or flock is unavailable."),
      ),
    );
    keeper.stdout.once("data", () => resolve());
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve) => {
      if (keeper.exitCode !== null || keeper.signalCode !== null) return resolve();
      keeper.once("exit", () => resolve());
      keeper.stdin.end();
    });
  };
}

/** A live startup can remain quiet; only verified process loss ends readiness polling. */
export async function waitForManagedReadiness(
  record: RuntimeRecord,
  checks = {
    verify: verifyHealth,
    live: ownsRuntime,
    wait: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
  },
) {
  for (;;) {
    try {
      await checks.verify(record);
      return;
    } catch (error) {
      if (!(await checks.live(record))) throw error;
      await checks.wait();
    }
  }
}

export async function stopRuntime(directory: string) {
  await ensureRuntimeDirectory(directory);
  // Startup holds the lock until readiness. Signal its attested child first so
  // an explicit Stop can release that lock even while startup remains quiet.
  const captured: { record: RuntimeRecord | null } = { record: null };
  const interruptOwned = async () => {
    const record = await readRuntime(directory);
    if (
      !record ||
      (captured.record && captured.record.nonce !== record.nonce) ||
      !(await ownsRuntime(record))
    )
      return;
    captured.record ??= record;
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  await interruptOwned();
  const releaseLock = await acquireRuntimeLock(directory).catch(async () => {
    // A stop launched before metadata existed can now attest the starting child.
    await interruptOwned();
    return acquireRuntimeLock(directory);
  });
  try {
    const record = await readRuntime(directory);
    if (!record || (captured.record && captured.record.nonce !== record.nonce)) return;
    if (!(await ownsRuntime(record))) {
      if (captured.record?.nonce === record.nonce)
        await NodeFSP.unlink(NodePath.join(directory, "runtime.json")).catch(() => {});
      return;
    }
    await interruptOwned();
    for (let attempt = 0; attempt < 150; attempt++) {
      if (!(await ownsRuntime(record))) {
        const current = await readRuntime(directory);
        if (current?.nonce === record.nonce)
          await NodeFSP.unlink(NodePath.join(directory, "runtime.json")).catch(() => {});
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Background server is still shutting down. Retry after it stops.");
  } finally {
    await releaseLock();
  }
}

export async function startRuntime(input: {
  directory: string;
  executable: string;
  args: string[];
  bootstrap: {
    port: number;
    desktopBootstrapSecret?: string;
    t3Home?: string;
    desktopRuntimeKeepRunning?: boolean;
  };
}) {
  const { directory } = input;
  const releaseLock = await acquireRuntimeLock(directory);
  try {
    const previous = await readRuntime(directory);
    const secretHash = NodeCrypto.createHash("sha256")
      .update(input.bootstrap.desktopBootstrapSecret ?? "")
      .digest("hex");
    if (previous && (await ownsRuntime(previous))) {
      if (
        previous.protocol !== MANAGED_RUNTIME_PROTOCOL ||
        previous.serverProtocol !== ORCHESTRATION_PROTOCOL_VERSION ||
        previous.secretHash !== secretHash
      )
        throw new Error("Running server is incompatible. Stop it explicitly before restarting.");
      await verifyHealth(previous);
      return previous;
    }
    if (previous) {
      const sameProcess = await birth(previous.pid).then(
        (value) => value === previous.birth,
        () => false,
      );
      if (sameProcess)
        throw new Error(
          "Recorded background server is still alive but cannot be verified. Refusing to start another server.",
        );
    }
    const nonce = NodeCrypto.randomUUID();
    const logPath = NodePath.join(directory, "server.log");
    if (
      await NodeFSP.stat(logPath).then(
        (stat) => stat.size > 8 * 1024 * 1024,
        () => false,
      )
    ) {
      for (let index = 2; index >= 1; index--)
        await NodeFSP.rename(`${logPath}.${index}`, `${logPath}.${index + 1}`).catch(() => {});
      await NodeFSP.rename(logPath, `${logPath}.1`);
    }
    await writeRuntimePreferences(
      directory,
      input.bootstrap.desktopRuntimeKeepRunning ?? true,
      false,
    );
    const log = await NodeFSP.open(logPath, "a", 0o600);
    const logStart = (await log.stat()).size;
    const child = NodeChildProcess.spawn(input.executable, input.args, {
      detached: true,
      env: {
        ...process.env,
        T3CODE_MANAGED_RUNTIME_ID: nonce,
        T3CODE_MANAGED_RUNTIME_DIRECTORY: directory,
      },
      stdio: ["pipe", log.fd, log.fd],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.stdin!.end(JSON.stringify(input.bootstrap) + "\n");
      const pid = child.pid!;
      const record: RuntimeRecord = {
        protocol: MANAGED_RUNTIME_PROTOCOL,
        pid,
        birth: await birth(pid),
        nonce,
        port: input.bootstrap.port,
        secretHash,
        executable: await NodeFSP.readlink(`/proc/${pid}/exe`),
        entry: input.args[0] ?? input.executable,
        stateDirectory: NodePath.join(
          input.bootstrap.t3Home ?? NodePath.join(NodeOS.homedir(), ".t3-imaorise"),
          "userdata",
        ),
        serverProtocol: ORCHESTRATION_PROTOCOL_VERSION,
      };
      const temporary = NodePath.join(directory, `${nonce}.json`);
      await NodeFSP.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await NodeFSP.rename(temporary, NodePath.join(directory, "runtime.json"));
      // Keep the startup lock until the new server is ready. A concurrent
      // launcher must reuse a healthy server, not race its cold boot.
      await waitForManagedReadiness(record);
      await NodeFSP.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await NodeFSP.rename(temporary, NodePath.join(directory, "runtime.json"));
      child.unref();
      return record;
    } catch (error) {
      let failure = error;
      try {
        const size = (await log.stat()).size;
        const start = Math.max(logStart, size - 4096);
        const tail = Buffer.alloc(Math.max(0, size - start));
        const reader = await NodeFSP.open(logPath, "r");
        try {
          await reader.read(tail, 0, tail.length, start);
        } finally {
          await reader.close();
        }
        if (isAssignedPortConflict(tail.toString("utf8"), input.bootstrap.port))
          failure = new Error(
            `listen EADDRINUSE: address already in use 0.0.0.0:${input.bootstrap.port}`,
          );
      } catch {}
      // Retain its ownership record until the captured child actually exits.
      // Otherwise the next launcher could start another writer to this profile.
      child.kill("SIGTERM");
      const exited =
        child.exitCode !== null ||
        child.signalCode !== null ||
        (await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 15000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve(true);
          });
        }));
      if (exited) {
        const registered = await readRuntime(directory).catch(() => null);
        if (registered?.nonce === nonce)
          await NodeFSP.unlink(NodePath.join(directory, "runtime.json")).catch(() => {});
      }
      throw failure;
    } finally {
      await log.close();
    }
  } finally {
    await releaseLock();
  }
}

export async function runDesktopRuntime(args: string[]) {
  const [action, key, ...serverArgs] = args;
  if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid desktop runtime key.");
  const directory = NodePath.join(
    process.env.T3CODE_MANAGED_RUNTIME_ROOT ??
      NodePath.join(NodeOS.homedir(), ".t3-imaorise", "desktop-runtime"),
    key,
  );
  if (action === "inspect") {
    const record = await readRuntime(directory);
    if (record && (await ownsRuntime(record))) {
      let healthy = false;
      if (record.protocol === MANAGED_RUNTIME_PROTOCOL) {
        try {
          await verifyHealth(record);
          healthy = true;
        } catch {}
      }
      console.log(
        JSON.stringify({
          port: record.port,
          protocol: record.protocol,
          serverProtocol: record.serverProtocol,
          environmentId: record.environmentId,
          stateDirectory: record.stateDirectory,
          healthy,
          ...(await readRuntimePreferences(directory)),
        }),
      );
    }
    return;
  }
  if (action === "policy") {
    const value = serverArgs[0];
    if (value !== undefined && value !== "true" && value !== "false")
      throw new Error("Invalid background preference.");
    console.log(
      JSON.stringify(
        value === undefined
          ? await readRuntimePreferences(directory)
          : await writeRuntimePreferences(directory, value === "true"),
      ),
    );
    return;
  }
  if (action === "stop" || action === "stop-on-exit") {
    if (action === "stop" || !(await readRuntimePreferences(directory)).keepAgentsRunning)
      await stopRuntime(directory);
    return;
  }
  if (action !== "attach") throw new Error("Unknown desktop runtime action.");
  const lines = NodeReadline.createInterface({ input: process.stdin });
  const first = await lines[Symbol.asyncIterator]().next();
  lines.close();
  if (first.done) throw new Error("Desktop bootstrap is missing.");
  const bootstrap = JSON.parse(first.value);
  if (key !== "production") {
    // Each desktop development origin owns an isolated database. The server's
    // default dev directory is shared, even when Vite ports differ.
    bootstrap.t3Home ??= NodePath.join(NodeOS.homedir(), ".t3-imaorise", "desktop-dev", key);
  }
  const record = await startRuntime({
    directory,
    executable: process.execPath,
    args: [...process.argv.slice(1, 2), ...serverArgs],
    bootstrap,
  });
  // Re-resolve against the authoritative owned record. A desktop-lifetime
  // forwarding port would break paired devices when Desktop exits.
  if (bootstrap.port !== record.port)
    throw new Error(
      `Running server is on port ${record.port}. Reconnect using its recorded endpoint.`,
    );
  const timer = setInterval(() => {
    void ownsRuntime(record).then((live) => {
      if (!live) process.exit(1);
    });
  }, 1000);
  const detach = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", detach);
  process.on("SIGINT", detach);
}
