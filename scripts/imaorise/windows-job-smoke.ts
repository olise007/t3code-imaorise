// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - Native disposable hosted ownership fixture.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { windowsServerJobScript } from "../../apps/server/src/cli/sshWindowsJob.ts";

if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32")
  throw new Error("Native Windows hosted fixture only.");
const home = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3 owned job "));
const program = Path.join(home, "owned parent.cjs");
await FS.writeFile(
  program,
  `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.once('spawn',()=>console.log(JSON.stringify({parent:process.pid,child:child.pid})));
setInterval(()=>{},1000);`,
);
const quote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
const command = [process.execPath, program].map(quote).join(" ");
const script = Path.join(home, "owned job.ps1");
await FS.writeFile(script, `\uFEFF${windowsServerJobScript(process.execPath, command, home)}`);
try {
  for (const mode of ["command", "eof"] as const) {
    const owner = ChildProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let details = "";
    owner.stderr.on("data", (chunk) => {
      details = (details + String(chunk)).slice(-2000);
    });
    owner.stdin.on("error", () => {});
    const exited = new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Job owner exited ${code}: ${details}`)),
      );
    });
    // Attach immediately so an early native error never becomes an unhandled rejection.
    void exited.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const deadline = setTimeout(
          () => reject(new Error(`Owned child did not start: ${details}`)),
          30000,
        );
        const early = (code: number | null) => {
          clearTimeout(deadline);
          reject(new Error(`Owner failed before readiness: ${code}; ${details}`));
        };
        owner.once("exit", early);
        owner.stdout.on("data", (chunk) => {
          output = (output + String(chunk)).slice(-4000);
          for (const line of output.split(/\r?\n/)) {
            try {
              const ids = JSON.parse(line) as { parent?: number; child?: number };
              if (
                Number.isInteger(ids.parent) &&
                Number.isInteger(ids.child) &&
                ids.parent! > 0 &&
                ids.child! > 0
              ) {
                clearTimeout(deadline);
                owner.off("exit", early);
                resolve();
                return;
              }
            } catch {
              /* Wait for the complete readiness record. */
            }
          }
        });
      });
      if (mode === "command") owner.stdin.write("stop\n");
      else owner.stdin.end();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Owned tree shutdown timed out")), 12000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      // The helper returns zero only after its Job Object reports zero active
      // members, including the grandchild created after the server was launched.
      console.log(`Verified Windows owned-tree ${mode} shutdown, including descendants.`);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.stdin.end();
        owner.kill(); // Only this captured owner; closing its job handle kills its tree.
        let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited.catch(() => {}),
            new Promise<never>((_, reject) => {
              cleanupDeadline = setTimeout(
                () => reject(new Error("Owned fixture cleanup timed out")),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(cleanupDeadline);
        }
      }
    }
  }
} finally {
  await FS.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
