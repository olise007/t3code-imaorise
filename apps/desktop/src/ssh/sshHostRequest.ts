import type { DesktopSshExecutionSource } from "@t3tools/contracts";

export function sshHostRequest(alias: string, executionSource?: DesktopSshExecutionSource) {
  return { alias, ...(executionSource === undefined ? {} : { executionSource }) };
}
