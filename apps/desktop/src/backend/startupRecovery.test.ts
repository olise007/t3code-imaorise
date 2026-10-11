import { describe, expect, it } from "@effect/vitest";
import { appendStartupOutput, isAssignedPortConflict } from "./startupRecovery.ts";

describe("startup bind diagnostics", () => {
  it("requires a listen failure for the exact assigned port", () => {
    expect(
      isAssignedPortConflict(
        "ServeError: listen EADDRINUSE: address already in use 0.0.0.0:4774\n",
        4774,
      ),
    ).toBe(true);
    for (const text of [
      "ERR_CONNECTION_REFUSED",
      "EADDRINUSE",
      "listen EADDRINUSE: address already in use 0.0.0.0:47740",
      "listen EADDRINUSE: address already in use 0.0.0.0:4775",
    ]) {
      expect(isAssignedPortConflict(text, 4774)).toBe(false);
    }
  });
  it("handles split chunks with bounded memory", () => {
    const prefix = appendStartupOutput("x".repeat(10000), "listen EADDR");
    const tail = appendStartupOutput(prefix, "INUSE: address already in use 127.0.0.1:4774\n");
    expect(tail.length).toBeLessThanOrEqual(4096);
    expect(isAssignedPortConflict(tail, 4774)).toBe(true);
  });
});
