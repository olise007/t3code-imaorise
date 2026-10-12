import { describe, expect, it } from "vite-plus/test";
import { hasPersonalSurfaceAssets } from "./personalReleaseAssets.ts";

const evidence = ["BUILD-MANIFEST.json", "SHA256SUMS"];
const release = (names: string[]) => ({ assets: names.map((name) => ({ name, size: 100 })) });
describe("complete personal release surfaces", () => {
  it("accepts either surface independently", () => {
    expect(
      hasPersonalSurfaceAssets(
        release([...evidence, "android-beta.json", "personal.apk"]),
        "android",
        "beta",
      ),
    ).toBe(true);
    expect(
      hasPersonalSurfaceAssets(
        release([...evidence, "beta.yml", "app.exe", "t3-version-linux-x64.tar.gz"]),
        "desktop",
        "beta",
      ),
    ).toBe(true);
    expect(
      hasPersonalSurfaceAssets(
        release([...evidence, "android-beta.json", "personal.apk"]),
        "desktop",
        "beta",
      ),
    ).toBe(false);
  });
  it("rejects missing evidence, runtime, installer, APK and truncated assets", () => {
    for (const missing of [...evidence, "beta.yml", "app.exe", "t3-version-linux-x64.tar.gz"]) {
      expect(
        hasPersonalSurfaceAssets(
          release(
            [...evidence, "beta.yml", "app.exe", "t3-version-linux-x64.tar.gz"].filter(
              (name) => name !== missing,
            ),
          ),
          "desktop",
          "beta",
        ),
      ).toBe(false);
    }
    expect(
      hasPersonalSurfaceAssets(release([...evidence, "android-beta.json"]), "android", "beta"),
    ).toBe(false);
    const zero = release([...evidence, "android-beta.json", "personal.apk"]);
    zero.assets.at(-1)!.size = 0;
    expect(hasPersonalSurfaceAssets(zero, "android", "beta")).toBe(false);
  });
});
