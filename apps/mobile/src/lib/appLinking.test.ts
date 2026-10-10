import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "t3code-imaorise://",
    "t3code-imaorise:///",
    "t3code-imaorise-dev://",
    "t3code-imaorise-preview://",
  ])("ignores scheme-only URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "t3code-imaorise://threads/env-1/thread-1",
    "t3code-imaorise://pair?pairingUrl=x",
    "t3code-imaorise-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "t3code-imaorise://expo-development-client/?url=x",
    "t3code-imaorise://expo-sharing/anything",
  ])("ignores lifecycle URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });
});
