import { describe, expect, it } from "vite-plus/test";
import config from "./app.config";

describe("Imaorise Android isolation", () => {
  it("uses separate app storage and a separate pairing protocol", () => {
    expect(config.name).toContain("Imaorise");
    expect(config.android?.package).toMatch(/^com\.imaorise\.t3code/);
    expect(config.scheme).toMatch(/^t3code-imaorise/);
  });

  it("cannot fetch official OTA updates or target the upstream EAS project", () => {
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.owner).toBeUndefined();
    expect(config.extra?.clerk.publishableKey).toBeNull();
    expect(config.extra?.relay.url).toBeNull();
  });
});
