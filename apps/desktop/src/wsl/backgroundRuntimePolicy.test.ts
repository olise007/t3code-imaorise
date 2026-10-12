import { describe, expect, it, vi } from "vite-plus/test";

describe("background runtime exit policy", () => {
  it("keeps enabled WSL work alive on app exit but stops on an explicit stop", async () => {
    vi.resetModules();
    const policy = await import("./backgroundRuntimePolicy.ts");
    expect(policy.shouldStopBackgroundServer(true, true)).toBe(false);
    expect(policy.shouldStopBackgroundServer(true, false)).toBe(true);
    expect(policy.shouldStopBackgroundServer(false, true)).toBe(true);
  });
  it("Exit and stop servers overrides every environment's persistence setting", async () => {
    vi.resetModules();
    const policy = await import("./backgroundRuntimePolicy.ts");
    policy.requestStopServersOnExit();
    expect(policy.shouldStopBackgroundServer(true, true)).toBe(true);
    expect(policy.shouldStopBackgroundServer(true, false)).toBe(true);
  });
});
