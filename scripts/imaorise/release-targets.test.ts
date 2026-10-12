import { describe, expect, it } from "vite-plus/test";
import { selectReleaseTargets } from "./release-targets.mjs";

describe("personal release targets", () => {
  it.each([
    ["apps/mobile/src/plan.tsx", true, false],
    ["apps/desktop/src/main.ts", false, true],
    ["apps/server/src/server.ts", false, true],
    ["apps/web/src/main.tsx", false, true],
    ["packages/contracts/src/ipc.ts", true, true],
    ["packages/client-runtime/src/index.ts", true, true],
    ["docs/user/install.md", false, false],
  ])("classifies %s", (path, android, desktop) => {
    expect(selectReleaseTargets("auto", [path], [path])).toEqual({ android, desktop });
  });
  it("compares each surface against its own last publication", () => {
    expect(selectReleaseTargets("auto", ["apps/mobile/src/new.ts"], [])).toEqual({
      android: true,
      desktop: false,
    });
  });
  it.each(["android", "desktop", "all"])("supports the %s override", (target) => {
    expect(selectReleaseTargets(target, [], [])).toEqual({
      android: target !== "desktop",
      desktop: target !== "android",
    });
  });
});
