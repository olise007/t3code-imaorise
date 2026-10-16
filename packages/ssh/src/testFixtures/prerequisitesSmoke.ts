// @effect-diagnostics nodeBuiltinImport:off - Hosted, disposable Docker boundary only.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";
import {
  buildSetupReview,
  linuxInspectionScript,
  linuxPackageInstallScript,
  parseInspection,
  runtimeRequirements,
} from "../prerequisites.ts";
import { NODE_PROVIDER_RUNTIME } from "@t3tools/shared/providerInstallRecipes";

if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("This fixture runs only in hosted GitHub Actions.");
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const container = (
  await execFile("docker", [
    "run",
    "--detach",
    "--rm",
    "--memory=1g",
    "--cpus=1",
    "ubuntu:24.04",
    "sleep",
    "1800",
  ])
).stdout.trim();
const run = async (script: string) =>
  await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn("docker", ["exec", "-i", container, "sh", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(script);
  });
try {
  const node = NODE_PROVIDER_RUNTIME.linux;
  const initialized = await run(`set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install --no-install-recommends -y ca-certificates curl tar gzip git libstdc++6
curl -fsSL '${node.url}' -o /tmp/node.tar.gz
printf '%s  %s\\n' '${node.integrity.slice(7)}' /tmp/node.tar.gz | sha256sum -c -
mkdir -p /opt/node
tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1
`);
  NodeAssert.equal(initialized.code, 0, initialized.stderr);
  const before = await run("/opt/node/bin/node --version\n");
  NodeAssert.notEqual(before.code, 0);
  NodeAssert.match(before.stderr, /libatomic\.so\.1/u);
  const inspected = await run(linuxInspectionScript);
  NodeAssert.equal(inspected.code, 0, inspected.stderr);
  const target = { alias: "fixture", hostname: "fixture", username: "root", port: 22 };
  const review = buildSetupReview({
    target,
    requirements: runtimeRequirements("linux", "fixture"),
    reviewId: "fixture-review",
    values: parseInspection(inspected.stdout),
    providers: [],
  });
  NodeAssert.deepEqual(review.blockers, []);
  NodeAssert.equal(review.items.find((i) => i.id === "libatomic.so.1")?.installed, false);
  NodeAssert.deepEqual(review.commands, [
    "apt-get update",
    "apt-get install --no-install-recommends -y libatomic1",
  ]);
  // The controller explicitly approves this exact fixture report. Service tests cover rejection,
  // identity changes and stale approvals without issuing an installation command.
  const installed = await run(linuxPackageInstallScript(review));
  NodeAssert.equal(installed.code, 0, installed.stderr);
  const after = await run(linuxInspectionScript);
  const checked = buildSetupReview({
    target,
    requirements: review.requirements,
    reviewId: review.reviewId,
    values: parseInspection(after.stdout),
    providers: [],
  });
  NodeAssert.equal(checked.remoteIdentity, review.remoteIdentity);
  NodeAssert.ok(checked.items.every((item) => item.installed));
  const started = await run(
    '/opt/node/bin/node -e \'const server=require("node:http").createServer();server.listen(0,"127.0.0.1",()=>server.close())\'\n',
  );
  NodeAssert.equal(started.code, 0, started.stderr);
  process.stdout.write(
    "Minimal Ubuntu fixture: missing libatomic reproduced, detected, explicitly approved, installed, reinspected, and runtime startup verified.\n",
  );
} finally {
  await execFile("docker", ["rm", "--force", container]);
}
