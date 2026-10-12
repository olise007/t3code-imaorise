/** Classify every changed path; unknown build inputs conservatively affect both. */
export function affectedTargets(paths) {
  let android = false;
  let desktop = false;
  for (const path of paths) {
    if (/^(docs\/|.*\.(md|txt)$)/.test(path)) continue;
    if (path.startsWith("apps/mobile/")) android = true;
    else if (/^apps\/(desktop|server|web)\//.test(path)) desktop = true;
    else if (path.startsWith("apps/marketing/")) continue;
    else android = desktop = true;
  }
  return { android, desktop };
}

export function selectReleaseTargets(target, androidPaths, desktopPaths) {
  if (target === "android") return { android: true, desktop: false };
  if (target === "desktop") return { android: false, desktop: true };
  if (target === "all") return { android: true, desktop: true };
  if (target !== "auto") throw new Error(`Unknown release target: ${target}`);
  return {
    android: affectedTargets(androidPaths).android,
    desktop: affectedTargets(desktopPaths).desktop,
  };
}
