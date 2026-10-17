// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native helper runs before the server runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

/** SEA cannot execute node-pty's JavaScript fork target. Dispatch only this native helper. */
export function windowsConsoleProcessList(shellPid: number): Promise<number[]> {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.WATCH_REPORT_DEPENDENCIES;
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.fork("__pty-console-list", [String(shellPid)], {
        env,
        execArgv: [],
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch {
      resolve([shellPid]);
      return;
    }
    let settled = false;
    const finish = (pids: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pids);
    };
    const fallback = () => finish([shellPid]);
    const timer = setTimeout(() => {
      fallback();
      child.kill(); // Only the helper captured from our own fork.
    }, 5000);
    child.on("error", fallback);
    child.once("exit", fallback);
    child.once("disconnect", fallback);
    child.on("message", (message) => {
      if (!message || typeof message !== "object" || !("consoleProcessList" in message)) return;
      const values = message.consoleProcessList;
      if (!Array.isArray(values)) return;
      const pids = values.filter(
        (value: unknown): value is number =>
          typeof value === "number" && Number.isInteger(value) && value > 0,
      );
      if (pids.length !== values.length) return;
      // A console enumeration must never turn into signalling the hosting server.
      if (pids.includes(process.pid) || pids.includes(process.ppid)) return fallback();
      finish(pids.includes(shellPid) ? pids : [shellPid]);
    });
  });
}

/** Console attachment changes process-wide state, so this runs only in an IPC child. */
export function runWindowsConsoleProcessList(value: string | undefined) {
  const pid = Number(value);
  if (process.platform !== "win32" || !process.send || !Number.isInteger(pid) || pid <= 0) {
    process.exitCode = 1;
    return;
  }
  let consoleProcessList: number[] = [];
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule: (name: string) => {
        module: { getConsoleProcessList: (pid: number) => number[] };
      };
    };
    consoleProcessList = utils
      .loadNativeModule("conpty_console_list")
      .module.getConsoleProcessList(pid);
  } catch {
    // The shell may already have exited; native cleanup still closes its pseudoconsole.
  }
  if (process.connected)
    process.send({ consoleProcessList }, () => {
      if (process.connected) process.disconnect();
    });
}
