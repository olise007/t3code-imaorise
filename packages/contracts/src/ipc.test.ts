import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopSshEnvironmentTargetSchema,
  unsupportedDesktopSshTargetReason,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("saved upstream SSH compatibility", () => {
  const target = { alias: "work", hostname: "work.example", username: "dev", port: 22 };
  it("accepts absent and explicitly local sources", () => {
    expect(unsupportedDesktopSshTargetReason(target)).toBeNull();
    expect(
      unsupportedDesktopSshTargetReason({ ...target, executionSource: { type: "local" } }),
    ).toBeNull();
  });
  it("preserves the owning distro through saved-profile decoding", () => {
    const saved = { ...target, executionSource: { type: "wsl" as const, distro: "Ubuntu" } };
    const decoded = Schema.decodeUnknownSync(DesktopSshEnvironmentTargetSchema)(saved);
    expect(decoded).toEqual(saved);
    expect(unsupportedDesktopSshTargetReason(decoded)).toContain("replacement");
  });
});
