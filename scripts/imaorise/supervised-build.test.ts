import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { runSupervisedBuild } from "./supervised-build.mjs";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-supervisor-test-"));
  const cwd = NodePath.join(root, "source");
  await NodeFSP.mkdir(cwd);
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd });
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "Test",
    ],
    { cwd },
  );
  const revision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const output = NodePath.join(root, "output");
  const artifact = NodePath.join(output, "artifact.txt");
  const step = (name: string, code: string) => ({
    name,
    cwd,
    command: process.execPath,
    args: ["-e", code],
    artifacts: [artifact],
  });
  return { root, cwd, revision, output, artifact, step };
}

describe("personal build supervision", () => {
  it("records failure atomically and never starts the next step", async () => {
    const f = await fixture();
    try {
      await expect(
        runSupervisedBuild({
          ...f,
          steps: [
            f.step("android", "process.exit(7)"),
            f.step("linux", "throw Error('must not run')"),
          ],
        }),
      ).rejects.toThrow("android");
      const status = JSON.parse(
        await NodeFSP.readFile(NodePath.join(f.output, "build-progress.json"), "utf8"),
      );
      expect(status.status).toBe("failed");
      expect(status.steps.android.exitCode).toBe(7);
      expect(status.steps.linux).toBeUndefined();
      expect(status.revision).toBe(f.revision);
      expect(JSON.stringify(status)).not.toContain("process.exit");
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("reuses only recorded successful artifacts with matching source and checksum", async () => {
    const f = await fixture();
    try {
      const steps = [
        f.step("linux", `require('fs').writeFileSync(${JSON.stringify(f.artifact)}, 'verified')`),
      ];
      await runSupervisedBuild({ ...f, steps });
      const resumed = await runSupervisedBuild({
        ...f,
        resume: true,
        steps: [f.step("linux", "process.exit(99)")],
      });
      expect(resumed.status).toBe("completed");
      await NodeFSP.writeFile(f.artifact, "corrupt");
      await expect(runSupervisedBuild({ ...f, resume: true, steps })).rejects.toThrow("validation");
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("records cancellation and stops only its owned child group", async () => {
    const f = await fixture();
    try {
      const config = NodePath.join(f.root, "config.json");
      await NodeFSP.writeFile(
        config,
        JSON.stringify({
          revision: f.revision,
          output: f.output,
          steps: [f.step("android", "console.log('READY'); setInterval(() => {}, 1000)")],
        }),
      );
      const supervisor = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "supervised-build.mjs"), config],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        supervisor.once("error", reject);
        supervisor.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("READY")) supervisor.kill("SIGTERM");
        });
        supervisor.once("exit", () => resolve());
      });
      const status = JSON.parse(
        await NodeFSP.readFile(NodePath.join(f.output, "build-progress.json"), "utf8"),
      );
      expect(status.status).toBe("interrupted");
      expect(status.signal).toBe("SIGTERM");
      expect(status.steps.android.status).toBe("interrupted");
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
  it("rejects a source mismatch before executing commands", async () => {
    const f = await fixture();
    try {
      await expect(
        runSupervisedBuild({
          ...f,
          revision: "a".repeat(40),
          steps: [f.step("windows", "process.exit(99)")],
        }),
      ).rejects.toThrow("pinned revision");
    } finally {
      await NodeFSP.rm(f.root, { recursive: true, force: true });
    }
  });
});
