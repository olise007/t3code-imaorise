// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { startManagedSsh, stopManagedSsh, superviseManagedSsh } from "../sshManagedRuntime.ts";

const args = process.argv.slice(2);
if (args[0] === "serve") {
  const port = Number(args[args.indexOf("--port") + 1]);
  const file = path.join(os.homedir(), ".t3-imaorise/userdata/server-runtime.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ environmentId: "fixture-environment", serverVersion: "2.0.1-test" }),
    );
  });
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => {
    fs.rmSync(file, { force: true });
    server.close();
  });
} else {
  try {
    if (args[0] === "start") console.log(JSON.stringify(await startManagedSsh(args[1]!, args[2]!)));
    else if (args[0] === "stop") await stopManagedSsh(args[1]!);
    else if (args[0] === "__ssh-helper" && args[1] === "supervise")
      await superviseManagedSsh(args[2]!, args[3]!);
    else throw new Error("Unknown fixture operation");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Fixture failed");
    process.exitCode = 1;
  }
}
