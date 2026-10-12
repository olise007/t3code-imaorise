export function hasPersonalSurfaceAssets(
  release: unknown,
  surface: "android" | "desktop",
  channel: "beta" | "stable" | "latest",
): boolean {
  if (
    typeof release !== "object" ||
    release === null ||
    !("assets" in release) ||
    !Array.isArray(release.assets)
  )
    return false;
  const assets: readonly unknown[] = release.assets;
  const names = new Set<string>();
  for (const asset of assets) {
    if (
      typeof asset !== "object" ||
      asset === null ||
      !("name" in asset) ||
      typeof asset.name !== "string"
    )
      continue;
    if ("size" in asset && (typeof asset.size !== "number" || asset.size <= 0)) continue;
    names.add(asset.name);
  }
  if (!names.has("BUILD-MANIFEST.json") || !names.has("SHA256SUMS")) return false;
  return surface === "android"
    ? names.has(`android-${channel === "beta" ? "beta" : "stable"}.json`) &&
        [...names].some((name) => name.endsWith(".apk"))
    : names.has(channel === "beta" ? "beta.yml" : "latest.yml") &&
        [...names].some((name) => name.endsWith(".exe")) &&
        [...names].some((name) => name.endsWith("-linux-x64.tar.gz"));
}
