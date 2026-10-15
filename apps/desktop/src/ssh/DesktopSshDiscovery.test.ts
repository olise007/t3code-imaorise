// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";
import { WSL_DISCOVER_SCRIPT } from "./DesktopSshDiscovery.ts";

it.skipIf(process.platform === "win32")(
  "discovers aliases and recursive includes inside the owning Linux home",
  () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-discovery-"));
    try {
      const ssh = NodePath.join(home, ".ssh");
      NodeFS.mkdirSync(NodePath.join(ssh, "config.d"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(ssh, "config"),
        "Host workstation\n HostName localhost\nInclude config.d/*\nHost * !ignored wildcard?\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(ssh, "config.d", "dev"),
        "Host remote-build\nInclude ../.ssh/config\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(ssh, "known_hosts"),
        "known.example ssh-ed25519 key\n|1|hashed|entry key\n",
      );
      const result = NodeChildProcess.spawnSync("sh", ["-s"], {
        input: WSL_DISCOVER_SCRIPT,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ssh-config\tworkstation");
      expect(result.stdout).toContain("ssh-config\tremote-build");
      expect(result.stdout).toContain("known-hosts\tknown.example");
      expect(result.stdout).not.toContain("hashed");
      expect(result.stdout).not.toContain("wildcard?");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);
