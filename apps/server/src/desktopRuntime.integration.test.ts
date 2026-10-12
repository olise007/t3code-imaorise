// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ownsRuntime, readRuntime, stopRuntime } from "./desktopRuntime.ts";

async function exit(child: NodeChildProcess.ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("detached runtime process integration", () => {
  it("keeps a long-running child and pending work after detach, reconnects once, and accepts remote management", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-continuity-"));
    const directory = NodePath.join(root, "runtimes", "acceptance");
    const profile = NodePath.join(root, "profile");
    await NodeFSP.mkdir(NodePath.join(profile, "userdata"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(profile, "userdata", "environment-id"),
      "test-environment",
    );
    const reserve = NodeNet.createServer();
    await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const address = reserve.address() as NodeNet.AddressInfo;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const entry = NodePath.join(root, "launcher.mjs");
    const runtimeUrl = NodeURL.pathToFileURL(
      NodePath.resolve("apps/server/src/desktopRuntime.ts"),
    ).href;
    await NodeFSP.writeFile(
      entry,
      `
      import { runDesktopRuntime, runManagedRuntimeAction } from ${JSON.stringify(runtimeUrl)};
      import { createInterface } from 'node:readline';
      import { createServer } from 'node:http';
      import { writeFileSync, appendFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      if (process.argv[2] === 'desktop-runtime') await runDesktopRuntime(process.argv.slice(3));
      else {
        const lines=createInterface({input:process.stdin});
        const first=await lines[Symbol.asyncIterator]().next();lines.close();
        const bootstrap=JSON.parse(first.value);
        const state={ counter:0, sessionId:'persistent-session', pendingQuestion:'choose-a-or-b', completedCommand:'retained' };
        appendFileSync(${JSON.stringify(NodePath.join(root, "launches"))},'launch\\n');
        const tool=spawn(process.execPath,['-e',"setInterval(()=>process.stdout.write('tick\\\\n'),50)"],{stdio:['ignore','pipe','ignore']});
        tool.stdout.on('data',()=>{state.counter++;writeFileSync(${JSON.stringify(NodePath.join(root, "progress"))},JSON.stringify(state));});
        const server=createServer(async(req,res)=>{
          if(req.url==='/control') {
            let text='';for await(const chunk of req)text+=chunk;
            try{res.end(JSON.stringify(await runManagedRuntimeAction(JSON.parse(text),{directory:process.env.T3CODE_MANAGED_RUNTIME_DIRECTORY,nonce:process.env.T3CODE_MANAGED_RUNTIME_ID,distro:'Test Ubuntu'})));}
            catch{res.statusCode=500;res.end('{}');}
          }else res.end(JSON.stringify({environmentId:'test-environment',orchestrationProtocolVersion:2,serverVersion:'test'}));
        });
        server.listen(bootstrap.port,'127.0.0.1');
        process.on('SIGTERM',()=>{tool.kill('SIGTERM');server.close(()=>process.exit(0));});
      }
    `,
    );
    const wrappers: NodeChildProcess.ChildProcess[] = [];
    const watcher = NodeFSP.watch(root);
    const events = watcher[Symbol.asyncIterator]();
    const nextProgress = async (minimum: number) => {
      while (true) {
        const next = await events.next();
        if (next.done) throw new Error("Progress watcher closed.");
        const event = next.value;
        if (event.filename !== "progress") continue;
        try {
          const state = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "progress"), "utf8"));
          if (state.counter > minimum) return state;
        } catch {}
      }
    };
    const attach = async () => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [entry, "desktop-runtime", "attach", "acceptance", "--bootstrap-fd", "0"],
        {
          env: { ...process.env, T3CODE_MANAGED_RUNTIME_ROOT: NodePath.join(root, "runtimes") },
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
      wrappers.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.stdin.end(
        JSON.stringify({
          port: address.port,
          t3Home: profile,
          desktopBootstrapSecret: "acceptance-only",
        }) + "\n",
      );
      return child;
    };
    try {
      const first = await attach();
      const initial = await nextProgress(0);
      const record = await readRuntime(directory);
      expect(record).not.toBeNull();
      first.kill("SIGTERM");
      await exit(first);
      const continued = await nextProgress(initial.counter);
      expect(continued.sessionId).toBe(initial.sessionId);
      expect(continued.pendingQuestion).toBe(initial.pendingQuestion);
      expect(continued.completedCommand).toBe("retained");
      expect(await ownsRuntime(record!)).toBe(true);
      const response = await fetch(`http://127.0.0.1:${record!.port}/control`, {
        method: "POST",
        body: JSON.stringify({
          action: "set",
          settings: {
            distro: "Test Ubuntu",
            keepAgentsRunning: false,
            closeToTray: true,
            minimizeToTray: false,
            serverRunning: true,
          },
        }),
      });
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({
        keepAgentsRunning: false,
        serverRunning: true,
      });
      const second = await attach();
      await nextProgress(continued.counter);
      expect((await readRuntime(directory))?.pid).toBe(record!.pid);
      expect(
        (await NodeFSP.readFile(NodePath.join(root, "launches"), "utf8")).trim().split("\n"),
      ).toHaveLength(1);
      second.kill("SIGTERM");
      await exit(second);
      expect(await ownsRuntime(record!)).toBe(true);
      const stop = await fetch(`http://127.0.0.1:${record!.port}/control`, {
        method: "POST",
        body: JSON.stringify({ action: "stop" }),
      });
      expect(stop.ok).toBe(true);
      expect(await stop.json()).toMatchObject({ serverRunning: false });
      await stopRuntime(directory);
      expect(await ownsRuntime(record!)).toBe(false);
    } finally {
      await watcher.return?.();
      for (const child of wrappers) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exit(child);
      }
      await stopRuntime(directory);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
