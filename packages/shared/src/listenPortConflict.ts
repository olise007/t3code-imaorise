/** A connection refusal or arbitrary EADDRINUSE mention does not prove a bind failure. */
export function isAssignedPortConflict(output: string, port: number): boolean {
  return new RegExp(
    `listen EADDRINUSE:[^\\r\\n]*address already in use[^\\r\\n]*:${port}(?:\\s|$)`,
  ).test(output);
}
