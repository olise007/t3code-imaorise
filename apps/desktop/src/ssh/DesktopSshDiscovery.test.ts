// @effect-diagnostics nodeBuiltinImport:off
// Isolated process-boundary fixtures intentionally exercise native files and processes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vite-plus/test";
import { WSL_DISCOVER_SCRIPT } from "./DesktopSshDiscovery.ts";

it.skipIf(process.platform === "win32")(
  "discovers aliases and recursive includes inside the owning Linux home",
  () => {
    const home = mkdtempSync(join(tmpdir(), "t3-ssh-discovery-"));
    try {
      const ssh = join(home, ".ssh");
      mkdirSync(join(ssh, "config.d"), { recursive: true });
      writeFileSync(
        join(ssh, "config"),
        "Host workstation\n HostName localhost\nInclude config.d/*\nHost * !ignored wildcard?\n",
      );
      writeFileSync(join(ssh, "config.d", "dev"), "Host remote-build\nInclude ../.ssh/config\n");
      writeFileSync(
        join(ssh, "known_hosts"),
        "known.example ssh-ed25519 key\n|1|hashed|entry key\n",
      );
      const result = spawnSync("sh", ["-s"], {
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
      rmSync(home, { recursive: true, force: true });
    }
  },
);
