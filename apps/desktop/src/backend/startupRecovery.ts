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

export { isAssignedPortConflict } from "@t3tools/shared/listenPortConflict";

export function appendStartupOutput(tail: string, chunk: string): string {
  return (tail + chunk).slice(-4096);
}
