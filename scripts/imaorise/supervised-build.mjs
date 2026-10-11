import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build supervisor has no application Effect runtime.
const platform = NodeOS.platform();
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const digest = async (file) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(file))
    .digest("hex");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Sequential, pinned-source supervision. Progress never contains commands or environment values. */
export async function runSupervisedBuild({ revision, output, steps, resume = false }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("A full source revision is required.");
  const order = ["android", "linux", "windows"];
  if (
    !steps.length ||
    steps.some(
      (step, i) =>
        !order.includes(step.name) ||
        (i && order.indexOf(step.name) <= order.indexOf(steps[i - 1].name)),
    )
  )
    throw new Error("Steps must be unique and ordered Android, Linux, Windows.");
  await NodeFSP.mkdir(output, { recursive: true });
  const statusPath = NodePath.join(output, "build-progress.json");
  let previous;
  try {
    previous = JSON.parse(await NodeFSP.readFile(statusPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous?.status === "running" && alive(previous.pid))
    throw new Error("The recorded build supervisor is still running.");
  if (previous?.status === "running" && previous.childPid && alive(previous.childPid))
    throw new Error("The recorded build child is still running; inspect it before resuming.");
  if (previous && previous.revision !== revision)
    throw new Error("Progress belongs to another source revision; use a new output directory.");
  const progress = {
    schemaVersion: 1,
    revision,
    pid: process.pid,
    childPid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: null,
    step: null,
    steps: {},
    exitCode: null,
    signal: null,
  };
  const save = async () => {
    progress.updatedAt = new Date().toISOString();
    const temporary = `${statusPath}.${process.pid}.tmp`;
    await NodeFSP.writeFile(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
    await NodeFSP.rename(temporary, statusPath);
  };
  let child;
  let cancellation;
  const cancel = (signal) => {
    cancellation = signal;
    if (child?.pid) {
      if (platform === "win32") child.kill(signal);
      else {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Child already exited. */
        }
      }
    }
  };
  const onTerm = () => cancel("SIGTERM");
  const onInt = () => cancel("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    await save();
    for (const step of steps) {
      if (cancellation) throw new Error("Build cancelled.");
      const source = await exec("git", ["rev-parse", "HEAD"], { cwd: step.cwd });
      if (source.stdout.trim() !== revision)
        throw new Error("Build checkout does not match the pinned revision.");
      const dirty = await exec("git", ["status", "--porcelain"], { cwd: step.cwd });
      if (dirty.stdout.trim()) throw new Error("Build checkout must be clean.");
      const old = previous?.steps?.[step.name];
      if (resume && old?.status === "completed" && old.artifacts?.length) {
        for (const artifact of old.artifacts) {
          if (
            !step.artifacts.includes(artifact.path) ||
            (await digest(artifact.path)) !== artifact.sha256
          )
            throw new Error("Previously completed artifacts failed validation.");
        }
        if (old.artifacts.length !== step.artifacts.length)
          throw new Error("Artifact set changed.");
        progress.steps[step.name] = old;
        continue;
      }
      progress.step = step.name;
      const record = {
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
        signal: null,
        artifacts: [],
      };
      progress.steps[step.name] = record;
      await save();
      const result = await new Promise((resolve, reject) => {
        child = NodeChildProcess.spawn(step.command, step.args ?? [], {
          cwd: step.cwd,
          env: process.env,
          stdio: "inherit",
          detached: platform !== "win32",
        });
        progress.childPid = child.pid ?? null;
        const saved = save();
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          saved.then(() => resolve({ code, signal }), reject);
        });
        saved.catch(reject);
      });
      child = undefined;
      progress.childPid = null;
      record.exitCode = result.code;
      record.signal = result.signal;
      record.completedAt = new Date().toISOString();
      if (result.code !== 0 || cancellation) {
        record.status = cancellation ? "interrupted" : "failed";
        progress.exitCode = result.code;
        progress.signal = cancellation ?? result.signal;
        throw new Error(`${step.name} did not complete successfully.`);
      }
      // Only a successful command can reserve artifacts for a later explicit resume.
      for (const file of step.artifacts)
        record.artifacts.push({ path: file, sha256: await digest(file) });
      record.status = "completed";
      await save();
    }
    progress.status = "completed";
    progress.exitCode = 0;
  } catch (error) {
    progress.status = cancellation ? "interrupted" : "failed";
    if (progress.step && progress.steps[progress.step]?.status === "running")
      progress.steps[progress.step].status = progress.status;
    progress.exitCode ??= 1;
    progress.signal ??= cancellation ?? null;
    throw error;
  } finally {
    progress.completedAt = new Date().toISOString();
    await save();
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
  return progress;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await NodeFSP.readFile(process.argv[2], "utf8"));
  await runSupervisedBuild({ ...config, resume: process.argv.includes("--resume") });
}
