// @effect-diagnostics nodeBuiltinImport:off
// Exercise the real process-boundary helper without connecting to a host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { expect, it } from "vite-plus/test";
import { buildSshAskpassHelperDescriptor } from "./auth.ts";

it("only confirms the exact approved fingerprint prompt and keeps passwords separate", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-askpass-"));
  const platform = Effect.runSync(HostProcess.Platform);
  const descriptor = await Effect.runPromise(
    buildSshAskpassHelperDescriptor({ directory }).pipe(Effect.provide(NodeServices.layer)),
  );
  try {
    for (const file of descriptor.files)
      await NodeFSP.writeFile(file.path, file.contents, { mode: file.mode });
    const prompt = "Are you sure you want to continue connecting (yes/no/[fingerprint])?";
    const invoke = (value: string) =>
      NodeChildProcess.spawnSync(
        platform === "win32" ? "powershell.exe" : descriptor.launcherPath,
        platform === "win32"
          ? [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              NodePath.join(directory, "ssh-askpass.ps1"),
              value,
            ]
          : [value],
        {
          env: {
            ...process.env,
            T3_SSH_TRUST_PROMPT: prompt,
            T3_SSH_AUTH_SECRET: "pāss phrase $;",
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
    expect(invoke(prompt).stdout.trim()).toBe("yes");
    const unapproved = invoke(prompt.replace("fingerprint", "changed fingerprint"));
    expect(unapproved.status).toBe(1);
    expect(unapproved.stderr).toContain("T3_SSH_PROMPT:");
    expect(unapproved.stdout).not.toContain("pāss");
    expect(invoke("Enter passphrase for key:").stdout.trim()).toBe("pāss phrase $;");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
