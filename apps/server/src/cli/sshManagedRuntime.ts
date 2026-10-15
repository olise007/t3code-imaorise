// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDateInEffect:off
// This supervisor runs before the Effect server. Only its captured child can be stopped.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as cp from "node:child_process";
import * as sea from "node:sea";

interface ManagedSshRecord {
  protocol: 1;
  token: string;
  controlPort: number;
  pid: number;
  executable: string;
  version: string;
}

const recordPath = (key: string) => {
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("Invalid managed SSH identity.");
  return path.join(os.homedir(), ".t3-imaorise", "ssh-managed", key, "supervisor.json");
};

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function readRecord(key: string): Promise<ManagedSshRecord | null> {
  try {
    const record: unknown = JSON.parse(await fs.readFile(recordPath(key), "utf8"));
    if (typeof record !== "object" || record === null)
      throw new Error("Invalid supervisor record.");
    const value = record as ManagedSshRecord;
    if (
      value.protocol !== 1 ||
      !Number.isInteger(value.controlPort) ||
      value.controlPort < 1 ||
      value.controlPort > 65535 ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.executable !== "string" ||
      typeof value.version !== "string"
    )
      throw new Error("Invalid supervisor record.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function control(record: ManagedSshRecord, action: "health" | "stop") {
  const response = await fetch(`http://127.0.0.1:${record.controlPort}/${action}`, {
    method: action === "stop" ? "POST" : "GET",
    headers: { Authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("Remote supervisor identity could not be verified.");
  const result = (await response.json()) as {
    token?: string;
    executable?: string;
    version?: string;
    remotePort?: number;
    environmentId?: string;
  };
  if (
    result.token !== record.token ||
    result.executable !== record.executable ||
    result.version !== record.version
  )
    throw new Error("Remote supervisor identity changed.");
  return result;
}

export async function stopManagedSsh(key: string) {
  const record = await readRecord(key);
  if (record === null) throw new Error("No verified T3-managed server exists for this connection.");
  await control(record, "stop");
}

export async function startManagedSsh(key: string, version: string) {
  const file = recordPath(key);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let handle;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "Another SSH setup is in progress. Retry when it finishes; an abandoned lock requires inspection.",
    );
  }
  try {
    const existing = await readRecord(key);
    if (existing !== null) {
      try {
        const health = await control(existing, "health");
        if (health.version !== version || health.executable !== process.execPath)
          throw new Error(
            "A different managed runtime is still running. Stop it explicitly before changing versions.",
          );
        return { remotePort: health.remotePort, serverKind: "managed" };
      } catch (error) {
        if (processAlive(existing.pid)) throw error;
        await fs.unlink(file);
      }
    }
    const log = await fs.open(path.join(path.dirname(file), "server.log"), "a", 0o600);
    const args = [
      ...(sea.isSea() ? [] : process.argv.slice(1, 2)),
      "__ssh-helper",
      "supervise",
      key,
      version,
    ];
    const supervisor = cp.spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, T3CODE_NO_BROWSER: "1" },
    });
    // The child is owned by this spawn, but it must survive this SSH command.
    supervisor.unref();
    await log.close();
    let spawnError: Error | undefined;
    supervisor.once("error", (error) => {
      spawnError = error;
    });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnError) throw new Error("Could not start the remote supervisor.");
      const current = await readRecord(key);
      if (current !== null) {
        const health = await control(current, "health").catch(() => null);
        if (health?.remotePort) return { remotePort: health.remotePort, serverKind: "managed" };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Remote server did not become ready. Inspect its SSH server log.");
  } finally {
    await handle.close();
    await fs.unlink(lock).catch(() => {});
  }
}

export async function superviseManagedSsh(key: string, version: string) {
  const file = recordPath(key);
  // Refuse another live server using the same state directory. Do not kill or adopt it.
  const home = path.join(os.homedir(), ".t3-imaorise");
  try {
    const runtime = JSON.parse(
      await fs.readFile(path.join(home, "userdata", "server-runtime.json"), "utf8"),
    ) as { pid: number };
    if (Number.isInteger(runtime.pid) && processAlive(runtime.pid))
      throw new Error(
        "An existing server owns this T3 home. Connect using its pairing URL, or stop it explicitly before SSH setup.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const listener = http.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not allocate supervisor port.");
  const serverPort = await new Promise<number>((resolve, reject) => {
    const socket = http.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const value = socket.address();
      if (!value || typeof value === "string") {
        reject(new Error("Could not allocate server port."));
        return;
      }
      socket.close(() => resolve(value.port));
    });
  });
  const child = cp.spawn(
    process.execPath,
    [
      ...(sea.isSea() ? [] : process.argv.slice(1, 2)),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(serverPort),
      "--base-dir",
      home,
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, T3CODE_NO_BROWSER: "1" },
    },
  );
  const record: ManagedSshRecord = {
    protocol: 1,
    token: crypto.randomBytes(32).toString("hex"),
    controlPort: address.port,
    pid: process.pid,
    executable: process.execPath,
    version,
  };
  let environmentId: string | undefined;
  let stopping = false;
  const cleanup = async () => {
    const current = await readRecord(key).catch(() => null);
    if (current?.token === record.token) await fs.unlink(file).catch(() => {});
    listener.close();
  };
  child.once("error", () => {
    void cleanup();
  });
  child.once("exit", () => {
    void cleanup();
  });
  listener.on("request", (request, response) => {
    if (request.headers.authorization !== `Bearer ${record.token}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== "/health" && !(request.url === "/stop" && request.method === "POST")) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/health" && !environmentId) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ...record, remotePort: serverPort, environmentId }));
    if (request.url === "/stop" && !stopping) {
      stopping = true;
      child.kill("SIGTERM");
    }
  });
  for (let attempt = 0; attempt < 250 && child.exitCode === null; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const descriptor = (await response.json()) as {
          serverVersion: string;
          environmentId: string;
        };
        if (descriptor.serverVersion !== version)
          throw new Error("Remote server version differs from its runtime.");
        environmentId = descriptor.environmentId;
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await fs.rename(temporary, file);
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        return;
      }
    } catch {
      /* Readiness is bounded; never infer that another PID belongs to us. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGTERM");
  await cleanup();
  throw new Error("Remote server did not become ready.");
}
