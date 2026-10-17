// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native hosted process fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

/** Assert the SEA dispatch really replies over IPC instead of silently using a fallback. */
export async function verifyPackagedPtyHelper(executable: string) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This fixture executes the real host-native addon without an Effect runtime.
  if (process.platform !== "win32") return;
  const require = NodeModule.createRequire(
    NodePath.join(NodePath.dirname(executable), "package.json"),
  );
  const pty = require("node-pty") as {
    spawn: (
      shell: string,
      args: string[],
      options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
    ) => {
      pid: number;
      onData: (callback: (data: string) => void) => { dispose: () => void };
      onExit: (callback: () => void) => { dispose: () => void };
      kill: () => void;
    };
  };
  const terminal = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
    cwd: NodePath.dirname(executable),
    cols: 80,
    rows: 24,
    env: process.env,
  });
  let terminalExited = false;
  const lifetime = terminal.onExit(() => {
    terminalExited = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        output.dispose();
        exit.dispose();
        reject(new Error("Packaged helper fixture shell did not start"));
      }, 15000);
      const output = terminal.onData(() => {
        if (terminal.pid > 0) {
          clearTimeout(timer);
          output.dispose();
          exit.dispose();
          resolve();
        }
      });
      const exit = terminal.onExit(() => {
        clearTimeout(timer);
        output.dispose();
        exit.dispose();
        reject(new Error("Packaged helper fixture shell exited before readiness"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const options: NodeChildProcess.ForkOptions & { windowsHide: boolean } = {
        execPath: executable,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      };
      const child = NodeChildProcess.fork("__pty-console-list", [String(terminal.pid)], options);
      let finished = false;
      let validReply = false;
      const done = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          child.kill();
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(
        () => done(new Error("Packaged PTY console helper did not reply")),
        10000,
      );
      child.on("error", done);
      child.on("message", (value) => {
        if (
          value &&
          typeof value === "object" &&
          "consoleProcessList" in value &&
          Array.isArray(value.consoleProcessList) &&
          value.consoleProcessList.includes(terminal.pid)
        )
          validReply = true;
        else done(new Error("Packaged PTY helper did not return its captured shell"));
      });
      child.once("exit", (code) => {
        if (!finished)
          done(
            validReply && code === 0
              ? undefined
              : new Error(`Packaged PTY helper exited without a valid reply (exit ${code})`),
          );
      });
    });
  } finally {
    if (!terminalExited)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listener.dispose();
          reject(new Error("Owned fixture PTY did not finish shutdown"));
        }, 10000);
        const listener = terminal.onExit(() => {
          clearTimeout(timer);
          listener.dispose();
          resolve();
        });
        terminal.kill();
      });
    lifetime.dispose();
  }
}
