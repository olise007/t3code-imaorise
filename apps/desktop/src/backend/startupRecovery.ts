export type StartupFailureCategory =
  | "port-conflict"
  | "process-exit"
  | "readiness-timeout"
  | "unreachable-endpoint"
  | "identity-mismatch";

export interface StartupStatus {
  phase: "starting" | "retrying" | "slow" | "running" | "failed";
  category?: StartupFailureCategory;
  port: number;
  attempt: number;
  diagnostic?: string;
}

export const MAX_PORT_ATTEMPTS = 5;

// A connection error or arbitrary mention of EADDRINUSE is insufficient.
// Match the listen failure and the exact port assigned to this child.
export function isAssignedPortConflict(output: string, port: number): boolean {
  return new RegExp(
    `listen EADDRINUSE:[^\\r\\n]*address already in use[^\\r\\n]*:${port}(?:\\s|$)`,
  ).test(output);
}

export function appendStartupOutput(tail: string, chunk: string): string {
  return (tail + chunk).slice(-4096);
}
