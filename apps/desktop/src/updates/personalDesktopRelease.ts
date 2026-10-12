import { hasPersonalSurfaceAssets } from "@t3tools/shared/personalReleaseAssets";

export function desktopReleaseFeed(releases: unknown, channel: "beta" | "latest") {
  if (!Array.isArray(releases)) throw new Error("Invalid desktop release response.");
  const metadataName = channel === "beta" ? "beta.yml" : "latest.yml";
  for (const release of releases) {
    if (
      !release ||
      release.draft ||
      Boolean(release.prerelease) !== (channel === "beta") ||
      !Array.isArray(release.assets)
    )
      continue;
    if (!hasPersonalSurfaceAssets(release, "desktop", channel)) continue;
    const metadata = release.assets.find((asset: { name?: string }) => asset.name === metadataName);
    if (
      !metadata ||
      !release.assets.some((asset: { name?: string }) => asset.name?.endsWith(".exe"))
    )
      continue;
    const url: unknown = metadata.browser_download_url;
    if (
      typeof url !== "string" ||
      !url.startsWith("https://github.com/olise007/t3code-imaorise/releases/download/") ||
      !url.endsWith(`/${metadataName}`)
    )
      throw new Error("Invalid desktop update asset URL.");
    return url.slice(0, -metadataName.length);
  }
  return null;
}
