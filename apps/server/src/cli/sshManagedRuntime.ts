// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDateInEffect:off
// This supervisor runs before the Effect server. Only its captured child can be stopped.
import { windowsSupervisorLaunchScript } from "./sshWindowsLaunch.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeModule from "node:module";
import * as Context from "effect/Context";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PROVIDER_RECIPE_CATALOG } from "@t3tools/shared/providerInstallRecipes";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { bundledResourceMonitorPaths } from "../resourceTelemetry/ResourceMonitorBinary.ts";

export class SshManagedRuntimeError extends Schema.TaggedError<SshManagedRuntimeError>()(
  "SshManagedRuntimeError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.detail;
  }
}

export class SshManagedRuntime extends Context.Service<
  SshManagedRuntime,
  {
    readonly verifyRuntime: Effect.Effect<void, SshManagedRuntimeError>;
    readonly start: (
      key: string,
      version: string,
      resume: boolean,
    ) => Effect.Effect<
      { remotePort: number | undefined; serverKind: string },
      SshManagedRuntimeError
    >;
    readonly stop: (key: string) => Effect.Effect<void, SshManagedRuntimeError>;
    readonly pair: (
      key: string,
      version: string,
    ) => Effect.Effect<{ credential: string }, SshManagedRuntimeError>;
    readonly supervise: (
      key: string,
      version: string,
    ) => Effect.Effect<void, SshManagedRuntimeError>;
  }
>()("t3/cli/sshManagedRuntime") {}

const operation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new SshManagedRuntimeError({
        detail: cause instanceof Error ? cause.message : "Managed SSH operation failed.",
        cause,
      }),
  });
export const layer = Layer.sync(SshManagedRuntime, () =>
  SshManagedRuntime.of({
    verifyRuntime: Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const architecture = yield* HostProcess.Architecture;
      return yield* operation(async () => {
        const root = NodePath.dirname(process.execPath);
        const require = NodeModule.createRequire(NodePath.join(root, "runtime.cjs"));
        for (const name of ["node-pty", "@ff-labs/fff-node"]) require(name);
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(":memory:");
        database.close();
        await verifyBundledResourceMonitor(root, platform, architecture);
      });
    }),
    start: (key, version, resume) =>
      Effect.flatMap(HostProcess.Platform, (platform) =>
        operation(() => startManagedSsh(key, version, platform, resume)),
      ),
    stop: (key) => operation(() => stopManagedSsh(key)),
    pair: (key, version) => operation(() => pairManagedSsh(key, version)),
    supervise: (key, version) =>
      Effect.flatMap(HostProcess.Platform, (platform) =>
        operation(() => superviseManagedSsh(key, version, platform)),
      ),
  }),
);

export async function verifyBundledResourceMonitor(
  root: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
) {
  const candidates = bundledResourceMonitorPaths(platform, architecture).map((segments) =>
    NodePath.resolve(root, ...segments),
  );
  for (const monitor of candidates) {
    if (!(await NodeFSP.stat(monitor).catch(() => null))?.isFile()) continue;
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(monitor, [], { stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("The resource monitor readiness check timed out."));
      }, 10_000);
      let hello = false;
      let greeting = "";
      child.stdout.on("data", (bytes: Buffer) => {
        greeting = (greeting + bytes.toString()).slice(-4096);
        if (greeting.includes('"type":"hello"')) hello = true;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && hello) resolve();
        else reject(new Error("The resource monitor could not start on this platform."));
      });
      child.stdin.on("error", () => {});
      child.stdin.end('{"version":1,"type":"shutdown"}\n');
    });
    return;
  }
  throw new Error("The bundled resource monitor is missing for this platform and architecture.");
}

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
  // One user home owns one server/database. Alternate aliases and Windows/WSL
  // routes must attest and reuse that same server rather than launch a second.
  return NodePath.join(
    NodeOS.homedir(),
    ".t3-imaorise",
    "ssh-managed",
    "server",
    "supervisor.json",
  );
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
    const record: unknown = JSON.parse(await NodeFSP.readFile(recordPath(key), "utf8"));
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
    if (error instanceof SyntaxError) throw new Error("Invalid supervisor record.");
    throw error;
  }
}

async function control(record: ManagedSshRecord, action: "health" | "stop") {
  const response = await fetch(`http://127.0.0.1:${record.controlPort}/${action}`, {
    method: action === "stop" ? "POST" : "GET",
    headers: { Authorization: `Bearer ${record.token}` },
    signal: AbortSignal.timeout(action === "stop" ? 15_000 : 3000),
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

async function compatibleServer(record: ManagedSshRecord, version: string) {
  const health = await control(record, "health");
  const releaseLine = (value: string) => /^(\d+\.\d+)\.\d+(?:[-+].*)?$/.exec(value)?.[1];
  const incompatible = () =>
    new Error(
      `Managed server ${record.version} is still running and is incompatible with runtime ${version}. Disconnecting leaves it running. Stop the remote server explicitly before changing versions; this also stops its agents.`,
    );
  if (!releaseLine(version) || releaseLine(record.version) !== releaseLine(version))
    throw incompatible();
  if (
    typeof health.remotePort !== "number" ||
    !Number.isInteger(health.remotePort) ||
    health.remotePort < 1 ||
    health.remotePort > 65535
  )
    throw new Error("Managed server did not report a valid port.");
  const response = await fetch(`http://127.0.0.1:${health.remotePort}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("Managed server readiness could not be verified.");
  const descriptor = (await response.json()) as {
    serverVersion?: unknown;
    environmentId?: unknown;
    orchestrationProtocolVersion?: unknown;
  };
  if (
    typeof health.environmentId !== "string" ||
    health.environmentId.length === 0 ||
    descriptor.environmentId !== health.environmentId ||
    descriptor.serverVersion !== record.version
  )
    throw new Error("Managed server identity differs from its verified supervisor.");
  if (descriptor.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION)
    throw incompatible();
  return health;
}

export async function pairManagedSsh(key: string, version: string) {
  const release = await acquireManagedLock(recordPath(key));
  try {
    const record = await readRecord(key);
    if (record === null)
      throw new Error("No verified T3-managed server exists for this connection.");
    await compatibleServer(record, version);
    // Use the running runtime's auth implementation. A newer CLI opening its
    // database could otherwise apply migrations while the older server is live.
    const output = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        record.executable,
        [
          ...(NodeSea.isSea() ? [] : process.argv.slice(1, 2)),
          "auth",
          "pairing",
          "create",
          "--base-dir",
          NodePath.join(NodeOS.homedir(), ".t3-imaorise"),
          "--json",
        ],
        { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) =>
          error
            ? reject(new Error("Could not issue a pairing credential through the running runtime."))
            : resolve(stdout),
      );
    });
    let result: { credential?: unknown };
    try {
      result = JSON.parse(output);
    } catch {
      throw new Error("The running runtime returned an invalid pairing response.");
    }
    if (
      typeof result.credential !== "string" ||
      result.credential.length === 0 ||
      result.credential.length > 4096
    )
      throw new Error("The running runtime returned an invalid pairing credential.");
    return { credential: result.credential };
  } finally {
    await release();
  }
}

export async function stopManagedSsh(key: string) {
  const release = await acquireManagedLock(recordPath(key));
  try {
    const record = await readRecord(key);
    if (record === null)
      throw new Error("No verified T3-managed server exists for this connection.");
    await control(record, "health");
    await NodeFSP.writeFile(`${recordPath(key)}.stopped`, "explicit stop\n", { mode: 0o600 });
    await control(record, "stop");
  } finally {
    await release();
  }
}

async function acquireManagedLock(file: string) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let handle;
  try {
    handle = await NodeFSP.open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recovery = `${lock}.recovery`;
    try {
      await NodeFSP.mkdir(recovery);
    } catch {
      throw new Error("Another SSH setup is inspecting the lock. Retry when it finishes.");
    }
    try {
      let previous: string;
      try {
        previous = await NodeFSP.readFile(lock, "utf8");
        const owner = JSON.parse(previous) as { pid?: unknown };
        if (
          typeof owner.pid !== "number" ||
          !Number.isInteger(owner.pid) ||
          owner.pid <= 0 ||
          processAlive(owner.pid)
        )
          throw new Error("busy");
      } catch {
        throw new Error("Another SSH setup is in progress, or its lock requires inspection.");
      }
      await NodeFSP.unlink(lock);
      handle = await NodeFSP.open(lock, "wx", 0o600);
    } finally {
      await NodeFSP.rmdir(recovery).catch(() => {});
    }
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: NodeCrypto.randomUUID() }));
  return async () => {
    await handle.close();
    await NodeFSP.unlink(lock).catch(() => {});
  };
}

export async function startManagedSsh(
  key: string,
  version: string,
  platform: NodeJS.Platform,
  resume = false,
) {
  const file = recordPath(key);
  const release = await acquireManagedLock(file);
  try {
    if (resume) await NodeFSP.rm(`${file}.stopped`, { force: true });
    else if (
      await NodeFSP.stat(`${file}.stopped`).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    )
      throw new Error(
        "Remote server was explicitly stopped. Switch this connection on to start it again.",
      );
    const existing = await readRecord(key);
    if (existing !== null) {
      try {
        const health = await compatibleServer(existing, version);
        return {
          remotePort: health.remotePort,
          serverKind: "managed",
          setupWarnings: [
            ...(await providerSetupWarnings(platform)),
            ...(existing.version === version
              ? []
              : [
                  `Reusing compatible remote server ${existing.version}. It and its agents remain running. Stop the remote server explicitly when ready to activate runtime ${version}.`,
                ]),
          ],
        };
      } catch (error) {
        if (processAlive(existing.pid)) throw error;
        await NodeFSP.unlink(file);
      }
    }
    const log = await NodeFSP.open(NodePath.join(NodePath.dirname(file), "server.log"), "a", 0o600);
    const args = [
      ...(NodeSea.isSea() ? [] : process.argv.slice(1, 2)),
      "__ssh-helper",
      "supervise",
      key,
      version,
    ];
    // OpenSSH permits explicit job breakaway. Avoid WMI, which standard SSH
    // users may not access, and never inherit the SSH session's pipe handles.
    const powershell = NodePath.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const launchFile = NodePath.join(NodePath.dirname(file), "supervise.ps1");
    if (platform === "win32") {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      await NodeFSP.writeFile(
        launchFile,
        `\uFEFF$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath\n& ${quote(process.execPath)} ${args.map(quote).join(" ")} *>> ${quote(NodePath.join(NodePath.dirname(file), "supervisor.log"))}\n`,
        { mode: 0o600 },
      );
    }
    const commandLine = [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launchFile,
    ]
      .map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`)
      .join(" ");
    const launchPowerShell = windowsSupervisorLaunchScript(
      powershell,
      commandLine,
      NodeOS.homedir(),
    );
    let spawnError: Error | undefined;
    if (platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(launchPowerShell, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            timeout: 15_000,
            env: { ...process.env, T3CODE_NO_BROWSER: "1" },
          },
          (error, stdout, stderr) => {
            void log.appendFile(`${stdout}${stderr}`).then(() => {
              if (error)
                reject(
                  new Error(
                    `Could not detach remote Windows server: ${stderr.slice(-1000) || error.message}`,
                    { cause: error },
                  ),
                );
              else resolve();
            }, reject);
          },
        );
      }).finally(() => log.close());
    } else {
      const supervisor = NodeChildProcess.spawn(process.execPath, args, {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, T3CODE_NO_BROWSER: "1" },
      });
      supervisor.once("error", (error) => {
        spawnError = error;
      });
      supervisor.unref();
      await log.close();
    }
    for (let attempt = 0; attempt < 300; attempt++) {
      if (spawnError) throw spawnError;
      const current = await readRecord(key);
      if (current !== null) {
        const health = await control(current, "health").catch(() => null);
        if (health?.remotePort)
          return {
            remotePort: health.remotePort,
            serverKind: "managed",
            setupWarnings: await providerSetupWarnings(platform),
          };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Remote server did not become ready. Inspect its SSH server log.");
  } finally {
    await release();
  }
}

async function providerSetupWarnings(platform: NodeJS.Platform) {
  const commands = [
    ...new Set([
      ...PROVIDER_RECIPE_CATALOG.map((entry) => entry.command).filter(Boolean),
      "cursor-agent",
    ]),
  ];
  const guidance = [
    "Review provider setup and sign in in this environment's provider settings. Managed or custom executables do not need to be on the SSH PATH.",
  ];
  if (platform === "win32") {
    const found = await new Promise<boolean>((resolve) => {
      NodeChildProcess.execFile(
        NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
        commands,
        { timeout: 1500, windowsHide: true },
        (_error, stdout) => resolve(stdout.trim().length > 0),
      );
    });
    return found ? [] : guidance;
  }
  const directories = (process.env.PATH ?? "").split(NodePath.delimiter).filter(Boolean);
  const extensions = [""];
  for (const command of commands) {
    for (const directory of directories) {
      for (const extension of extensions) {
        try {
          await NodeFSP.access(
            NodePath.join(directory, `${command}${extension}`),
            NodeFSP.constants.X_OK,
          );
          if ((await NodeFSP.stat(NodePath.join(directory, `${command}${extension}`))).isFile())
            return [];
        } catch {
          /* A missing candidate is normal. */
        }
      }
    }
  }
  return guidance;
}

export async function superviseManagedSsh(key: string, version: string, platform: NodeJS.Platform) {
  const file = recordPath(key);
  // Refuse another live server using the same state directory. Do not kill or adopt it.
  const home = NodePath.join(NodeOS.homedir(), ".t3-imaorise");
  try {
    const runtime = JSON.parse(
      await NodeFSP.readFile(NodePath.join(home, "userdata", "server-runtime.json"), "utf8"),
    ) as { pid: number };
    if (Number.isInteger(runtime.pid) && processAlive(runtime.pid))
      throw new Error(
        "An existing server owns this T3 home. Connect using its pairing URL, or stop it explicitly before SSH setup.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const listener = NodeHttp.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not allocate supervisor port.");
  const serverPort = await new Promise<number>((resolve, reject) => {
    const socket = NodeHttp.createServer();
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
  const log = await NodeFSP.open(NodePath.join(NodePath.dirname(file), "server.log"), "a", 0o600);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      ...(NodeSea.isSea() ? [] : process.argv.slice(1, 2)),
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
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, T3CODE_NO_BROWSER: "1" },
    },
  );
  await log.close();
  const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    if (platform === "win32") {
      // Node's Windows SIGTERM terminates only the root process. This PID is
      // captured from our spawn, never discovered from a saved record or name.
      await new Promise<void>((resolve, reject) =>
        NodeChildProcess.execFile(
          NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10_000 },
          (error) =>
            error && child.exitCode === null && child.signalCode === null
              ? reject(
                  new Error("Could not stop the owned Windows server process tree.", {
                    cause: error,
                  }),
                )
              : resolve(),
        ),
      );
    } else {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    }
  };
  const record: ManagedSshRecord = {
    protocol: 1,
    token: NodeCrypto.randomBytes(32).toString("hex"),
    controlPort: address.port,
    pid: process.pid,
    executable: process.execPath,
    version,
  };
  let environmentId: string | undefined;
  let stopping = false;
  const cleanup = async () => {
    const current = await readRecord(key).catch(() => null);
    if (current?.token === record.token) await NodeFSP.unlink(file).catch(() => {});
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
    if (request.url === "/stop" && !stopping) {
      stopping = true;
      void stopChild()
        .then(() => cleanup())
        .then(() =>
          response.end(JSON.stringify({ ...record, remotePort: serverPort, environmentId })),
        )
        .catch(() => response.writeHead(500).end());
      return;
    }
    response.end(JSON.stringify({ ...record, remotePort: serverPort, environmentId }));
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
        await NodeFSP.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await NodeFSP.rename(temporary, file);
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        return;
      }
    } catch {
      /* Readiness is bounded; never infer that another PID belongs to us. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopChild();
  await cleanup();
  throw new Error("Remote server did not become ready.");
}
