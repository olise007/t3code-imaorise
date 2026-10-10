import { describe, expect, it } from "vite-plus/test";
import { buildRemoteT3RunnerScript } from "./tunnel.ts";

describe("Imaorise SSH runtime isolation", () => {
  it("refuses an upstream archive and accepts an explicitly supplied source runtime", () => {
    expect(() => buildRemoteT3RunnerScript({ archiveVersion: "1.2.3" })).toThrow(
      "Managed SSH runtime downloads are disabled",
    );
    const script = buildRemoteT3RunnerScript({ nodeScriptPath: "/opt/t3code-imaorise/bin.mjs" });
    expect(script).toContain("/opt/t3code-imaorise/bin.mjs");
    expect(script).toContain("$HOME/.t3-imaorise/runtime/versions");
  });
});
