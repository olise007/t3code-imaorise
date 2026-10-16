import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";

export interface SshSetupAttempt {
  readonly id: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly startedAt: number;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly lines: readonly {
    readonly sequence: number;
    readonly time: number;
    readonly text: string;
  }[];
  readonly truncated: boolean;
}

export function createSshSetupProgress() {
  let nextId = 0;
  let attempts: readonly SshSetupAttempt[] = [];
  let notification: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (notification !== undefined) return;
    notification = setTimeout(() => {
      notification = undefined;
      for (const listener of listeners) listener();
    }, 100);
  };
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => attempts,
    begin: (target: DesktopSshEnvironmentTarget) => {
      const id = `ssh-setup-${Date.now()}-${++nextId}`;
      attempts = [
        ...attempts.filter((item) => item.status === "running"),
        ...attempts.filter((item) => item.status !== "running").slice(-10),
        { id, target, startedAt: Date.now(), status: "running", lines: [], truncated: false },
      ];
      notify();
      return id;
    },
    append: (id: string, text: string) => {
      // Authentication/protocol responses never enter this store. Strip terminal
      // control sequences and redact URL/query-shaped credentials defensively.
      const safe = text
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/https?:\/\/\S+/gi, "[address omitted]")
        .replace(
          /((?:token|password|credential|secret|authorization|code)\s*[:=]\s*)[^\s,;]+/gi,
          "$1[redacted]",
        )
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
        .slice(0, 8192);
      attempts = attempts.map((item) => {
        if (item.id !== id || item.status !== "running") return item;
        const lines = [
          ...item.lines,
          { sequence: (item.lines.at(-1)?.sequence ?? 0) + 1, time: Date.now(), text: safe },
        ];
        let bytes = lines.reduce(
          (sum, line) => sum + new TextEncoder().encode(line.text).length,
          0,
        );
        let truncated = item.truncated;
        while (lines.length > 2000 || bytes > 262144) {
          bytes -= new TextEncoder().encode(lines.shift()!.text).length;
          truncated = true;
        }
        return { ...item, lines, truncated };
      });
      notify();
    },
    finish: (id: string, status: SshSetupAttempt["status"]) => {
      const updated = attempts.map((item) => (item.id === id ? { ...item, status } : item));
      const retained = new Set(
        updated
          .filter((item) => item.status !== "running")
          .slice(-10)
          .map((item) => item.id),
      );
      attempts = updated.filter((item) => item.status === "running" || retained.has(item.id));
      notify();
    },
  };
}
export const sshSetupProgress = createSshSetupProgress();
