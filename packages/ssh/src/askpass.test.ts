// @effect-diagnostics nodeBuiltinImport:off
// Exercise the real process-boundary helper without connecting to a host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { buildSshAskpassHelperDescriptor, buildSshChildEnvironment } from "./auth.ts";

it.effect("only confirms the exact approved fingerprint prompt and keeps passwords separate", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-askpass-")),
    );
    const descriptor = yield* buildSshAskpassHelperDescriptor({ directory }).pipe(
      Effect.provide(NodeServices.layer),
    );
    try {
      for (const file of descriptor.files)
        yield* Effect.promise(() =>
          NodeFSP.writeFile(file.path, file.contents, { mode: file.mode }),
        );
      const prompt = "Are you sure you want to continue connecting (yes/no/[fingerprint])?";
      const env = yield* buildSshChildEnvironment({
        interactiveAuth: true,
        askpassDirectory: directory,
        baseEnv: {
          ...process.env,
          T3_SSH_TRUST_PROMPT: prompt,
          T3_SSH_AUTH_SECRET: "pāss phrase $;",
        },
      }).pipe(Effect.provide(NodeServices.layer));
      const invoke = (value: string) =>
        NodeChildProcess.spawnSync(descriptor.launcherPath, [value], {
          env,
          encoding: "utf8",
          timeout: 5000,
        });
      expect(invoke(prompt).stdout.trim()).toBe("yes");
      const multiline = invoke('Host "quoted"\nSHA256:changed\nContinue (yes/no)?');
      expect(multiline.status).toBe(1);
      const encoded = multiline.stderr.match(/T3_SSH_PROMPT:([A-Za-z0-9+/=]+)/)?.[1];
      expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(
        'Host "quoted"\nSHA256:changed\nContinue (yes/no)?',
      );
      const unapproved = invoke(prompt.replace("fingerprint", "changed fingerprint"));
      expect(unapproved.status).toBe(1);
      expect(unapproved.stderr).toContain("T3_SSH_PROMPT:");
      expect(unapproved.stdout).not.toContain("pāss");
      expect(invoke("Enter passphrase for key:").stdout.trim()).toBe("pāss phrase $;");
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);
