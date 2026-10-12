import { describe, expect, it, vi } from "vite-plus/test";

describe("tray window behavior", () => {
  it.each([true, false])("close hides only when enabled=%s", async (enabled) => {
    vi.resetModules();
    const policy = await import("./trayWindowPolicy.ts");
    policy.setTrayAvailable(true);
    const actions: string[] = [];
    policy.handleTrayClose({
      event: { preventDefault: () => actions.push("prevent") },
      canUseTray: true,
      getEnabled: () => Promise.resolve(enabled),
      hide: () => actions.push("hide"),
      close: () => actions.push("close"),
      bypass: false,
      setBypass: () => actions.push("bypass"),
    });
    await Promise.resolve();
    expect(actions).toEqual(enabled ? ["prevent", "hide"] : ["prevent", "bypass", "close"]);
  });
  it("keeps the window reachable when tray creation fails", async () => {
    vi.resetModules();
    const policy = await import("./trayWindowPolicy.ts");
    expect(policy.shouldHideToTray(true)).toBe(false);
  });
  it("honors close settings and bypasses hiding for actual quit", async () => {
    vi.resetModules();
    const policy = await import("./trayWindowPolicy.ts");
    policy.setTrayAvailable(true);
    expect(policy.shouldHideToTray(false)).toBe(false);
    expect(policy.shouldHideToTray(true)).toBe(true);
    policy.beginTrayQuit();
    expect(policy.shouldHideToTray(true)).toBe(false);
  });
});
