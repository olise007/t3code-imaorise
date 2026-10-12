// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ownsRuntime,
  readRuntime,
  startRuntime,
  stopRuntime,
  waitForManagedReadiness,
  runtimeServerArguments,
} from "./desktopRuntime.ts";

const directories: string[] = [];
it("launches an embedded runtime without treating its executable as the home directory", () => {
  const args = ["serve", "--port", "5779"];
  expect(
    runtimeServerArguments(["/runtime/t3", "/runtime/t3", "desktop-runtime"], args, true),
  ).toEqual(args);
  expect(
    runtimeServerArguments(["/usr/bin/node", "/runtime/bin.mjs", "desktop-runtime"], args, false),
  ).toEqual(["/runtime/bin.mjs", ...args]);
});
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await stopRuntime(directory);
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

async function fixture(deferListen = false) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-background-test-"));
  directories.push(directory);
  await NodeFSP.mkdir(NodePath.join(directory, "userdata"));
  await NodeFSP.writeFile(
    NodePath.join(directory, "userdata", "environment-id"),
    "test-environment",
  );
  const entry = NodePath.join(directory, "server.mjs");
  // A ready file is written only after listen; watching it supplies a concrete
  // startup milestone without sleeping or polling in the test.
  await NodeFSP.writeFile(
    entry,
    `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const line = await createInterface({ input: process.stdin })[Symbol.asyncIterator]().next();
    const { port } = JSON.parse(line.value);
    if (${deferListen}) await new Promise(() => setInterval(() => {}, 1000));
    const server = createServer((req, res) => res.end(JSON.stringify({ environmentId: "test-environment", orchestrationProtocolVersion: 2, serverVersion: "test" })));
    server.listen(port, '127.0.0.1', () => writeFileSync(${JSON.stringify(NodePath.join(directory, "ready"))}, 'ready'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `,
  );
  const reservation = NodeNet.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address() as NodeNet.AddressInfo;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const cancellation = new AbortController();
  const watcher = NodeFSP.watch(directory, { signal: cancellation.signal });
  const ready = (async () => {
    try {
      for await (const event of watcher) if (event.filename === "ready") return;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }
  })();
  return {
    input: {
      directory,
      executable: process.execPath,
      args: [entry],
      bootstrap: { port: address.port, desktopBootstrapSecret: "test-secret", t3Home: directory },
    },
    ready,
    watcher,
    cancelWatch: () => cancellation.abort(),
  };
}

describe("managed WSL runtime", () => {
  it("serializes concurrent launches without starting a second server", async () => {
    const { input, watcher } = await fixture();
    try {
      const records = await Promise.all([startRuntime(input), startRuntime(input)]);
      expect(records[0].pid).toBe(records[1].pid);
    } finally {
      await watcher.return?.();
    }
  });
  it("reuses the verified process and preserves work across reconnects", async () => {
    const { input, ready, watcher } = await fixture();
    try {
      const first = await startRuntime(input);
      await ready;
      const second = await startRuntime(input);
      expect(second.pid).toBe(first.pid);
      expect(await ownsRuntime(second)).toBe(true);
      expect(await readRuntime(input.directory)).toEqual(first);
      await expect(
        startRuntime({
          ...input,
          bootstrap: { ...input.bootstrap, desktopBootstrapSecret: "changed" },
        }),
      ).rejects.toThrow("incompatible");
      expect(await ownsRuntime(first)).toBe(true);
      await stopRuntime(input.directory);
      expect(await ownsRuntime(first)).toBe(false);
      expect(await readRuntime(input.directory)).toBeNull();
    } finally {
      await watcher.return?.();
    }
  });

  it("reports an assigned-port bind conflict without stopping the port owner", async () => {
    const { input, watcher, cancelWatch } = await fixture();
    const owner = NodeNet.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => owner.listen(input.bootstrap.port, "127.0.0.1", resolve));
    try {
      await expect(startRuntime(input)).rejects.toThrow(
        `EADDRINUSE: address already in use 0.0.0.0:${input.bootstrap.port}`,
      );
      expect(owner.listening).toBe(true);
      expect(await readRuntime(input.directory)).toBeNull();
    } finally {
      cancelWatch();
      await watcher.return?.();
      await new Promise<void>((resolve) => owner.close(() => resolve()));
    }
  });

  it("keeps polling an attested live process beyond the old startup cutoff", async () => {
    const { input, watcher } = await fixture();
    try {
      const record = await startRuntime(input);
      let probes = 0;
      await waitForManagedReadiness(record, {
        verify: async () => {
          if (++probes <= 301) throw new Error("Still starting");
        },
        live: ownsRuntime,
        wait: async () => {},
      });
      expect(probes).toBe(302);
      expect(await ownsRuntime(record)).toBe(true);
    } finally {
      await watcher.return?.();
    }
  });

  it("stops an owned child while startup holds the readiness lock", async () => {
    const { input, watcher, cancelWatch } = await fixture(true);
    const changes = NodeFSP.watch(input.directory);
    const registered = (async () => {
      for await (const event of changes) if (event.filename === "runtime.json") return;
    })();
    const starting = startRuntime(input).then(
      () => "ready",
      () => "interrupted",
    );
    try {
      await registered;
      const record = await readRuntime(input.directory);
      expect(record).not.toBeNull();
      await stopRuntime(input.directory);
      expect(await starting).toBe("interrupted");
      expect(await readRuntime(input.directory)).toBeNull();
      expect(await ownsRuntime(record!)).toBe(false);
    } finally {
      cancelWatch();
      await watcher.return?.();
      await changes.return?.();
    }
  });

  it("rejects a symlinked metadata directory before signaling its live child", async () => {
    const { input, watcher } = await fixture();
    try {
      const record = await startRuntime(input);
      const alias = NodePath.join(input.directory, "alias");
      await NodeFSP.symlink(input.directory, alias, "dir");
      await expect(stopRuntime(alias)).rejects.toThrow("not owned");
      expect(await ownsRuntime(record)).toBe(true);
    } finally {
      await watcher.return?.();
    }
  });

  it("does not signal a process whose recorded birth identity is wrong", async () => {
    const { input, ready, watcher } = await fixture();
    try {
      const record = await startRuntime(input);
      await ready;
      await NodeFSP.writeFile(
        NodePath.join(input.directory, "runtime.json"),
        JSON.stringify({ ...record, birth: "wrong" }),
      );
      await expect(stopRuntime(input.directory)).rejects.toThrow("Invalid runtime identity");
      expect(await ownsRuntime(record)).toBe(true);
      await NodeFSP.writeFile(
        NodePath.join(input.directory, "runtime.json"),
        JSON.stringify(record),
      );
    } finally {
      await watcher.return?.();
    }
  });
});
