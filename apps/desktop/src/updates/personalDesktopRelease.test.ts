import { describe, expect, it } from "vite-plus/test";
import { desktopReleaseFeed } from "./personalDesktopRelease.ts";

describe("surface-specific update discovery", () => {
  it("skips a newer Android release and finds the desktop assets", () => {
    const url = "https://github.com/olise007/t3code-imaorise/releases/download/v2.0.1/latest.yml";
    expect(
      desktopReleaseFeed(
        [
          { assets: [{ name: "android-stable.json" }, { name: "app.apk" }] },
          {
            assets: [
              { name: "latest.yml", browser_download_url: url },
              { name: "app.exe" },
              { name: "t3-version-linux-x64.tar.gz" },
              { name: "BUILD-MANIFEST.json" },
              { name: "SHA256SUMS" },
            ],
          },
        ],
        "latest",
      ),
    ).toBe(url.slice(0, -"latest.yml".length));
  });
  it("ignores drafts, other channels, and incomplete desktop releases", () => {
    expect(
      desktopReleaseFeed(
        [
          {
            draft: true,
            assets: [
              { name: "latest.yml" },
              { name: "app.exe" },
              { name: "t3-version-linux-x64.tar.gz" },
              { name: "BUILD-MANIFEST.json" },
              { name: "SHA256SUMS" },
            ],
          },
          {
            prerelease: true,
            assets: [
              { name: "beta.yml" },
              { name: "app.exe" },
              { name: "t3-version-linux-x64.tar.gz" },
              { name: "BUILD-MANIFEST.json" },
              { name: "SHA256SUMS" },
            ],
          },
          { assets: [{ name: "latest.yml" }] },
        ],
        "latest",
      ),
    ).toBeNull();
  });
});
