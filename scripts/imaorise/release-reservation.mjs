import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { selectReleaseTargets } from "./release-targets.mjs";
import { hasPersonalSurfaceAssets } from "../../packages/shared/src/personalReleaseAssets.ts";
const repo = "olise007/t3code-imaorise";
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== "refs/heads/imaorise")
  throw new Error("Personal releases require the trusted fork branch.");
const gh = (...args) =>
  NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
const releases = gh(
  "api",
  "--paginate",
  `repos/${repo}/releases?per_page=100`,
  "--jq",
  ".[] | {tag_name, draft, prerelease, body, assets: [.assets[] | {name, size}]}",
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const channel = process.env.RELEASE_CHANNEL === "stable" ? "stable" : "beta";
let revision = process.env.GITHUB_SHA;
let base = "2.0.1";
if (channel === "stable") {
  const beta = releases.find(
    (r) => r.tag_name === process.env.TESTED_BETA && r.prerelease && !r.draft,
  );
  if (!beta || !/^v2\.\d+\.\d+-beta\.\d+$/.test(beta.tag_name))
    throw new Error("Stable requires a published tested personal beta tag.");
  const record = JSON.parse(beta.body.split("\n")[0]);
  revision = record.sourceRevision;
  base = beta.tag_name.slice(1).split("-beta.")[0];
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Beta source revision is invalid.");
} else {
  const stable = releases
    .filter((r) => !r.draft && /^v2\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => r.tag_name.slice(1))
    .sort((a, b) => {
      const x = a.split(".").map(Number),
        y = b.split(".").map(Number);
      return x[1] - y[1] || x[2] - y[2];
    })
    .at(-1);
  if (stable) {
    const parts = stable.split(".").map(Number);
    base = `2.${parts[1]}.${parts[2] + 1}`;
  }
}
const version = channel === "beta" ? `${base}-beta.${process.env.GITHUB_RUN_NUMBER}` : base;
const changesSince = (surface) => {
  const previous = releases.find(
    (release) =>
      !release.draft &&
      release.prerelease === (channel === "beta") &&
      hasPersonalSurfaceAssets(release, surface, channel) &&
      (() => {
        try {
          return /^[a-f0-9]{40}$/.test(JSON.parse(release.body.split("\n")[0]).sourceRevision);
        } catch {
          return false;
        }
      })(),
  );
  if (!previous) return ["package.json"];
  const source = JSON.parse(previous.body.split("\n")[0]).sourceRevision;
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Invalid published source revision.");
  return NodeChildProcess.execFileSync("git", ["diff", "--name-only", "-z", source, revision], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
};
const requestedTarget = process.env.RELEASE_TARGET || "auto";
let targets = selectReleaseTargets(
  requestedTarget,
  requestedTarget === "auto" ? changesSince("android") : [],
  requestedTarget === "auto" ? changesSince("desktop") : [],
);
const tag = `v${version}`;
const existing = releases.find((r) => r.tag_name === tag);
if (existing) {
  const reserved = JSON.parse(existing.body.split("\n")[0]);
  if (reserved.targets) targets = reserved.targets;
}
NodeFS.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `android=${targets.android}\ndesktop=${targets.desktop}\nhas_targets=${targets.android || targets.desktop}\n`,
);
if (!targets.android && !targets.desktop) process.exit(0);
if (existing && !existing.draft)
  throw new Error("This release has already been published; do not overwrite it.");
const maxCode = Math.max(
  5215,
  ...releases.map((r) => {
    try {
      const value = JSON.parse(r.body.split("\n")[0]).versionCode;
      return Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }),
);
const reservation = existing
  ? JSON.parse(existing.body.split("\n")[0])
  : {
      schemaVersion: 1,
      sourceRevision: revision,
      versionCode: maxCode + 1,
      runId: process.env.GITHUB_RUN_ID,
      channel,
      version,
      targets,
    };
if (reservation.runId !== process.env.GITHUB_RUN_ID || reservation.sourceRevision !== revision)
  throw new Error("Reservation belongs to a different source or workflow run.");
if (
  releases.some(
    (r) =>
      !r.draft &&
      (() => {
        try {
          return JSON.parse(r.body.split("\n")[0]).versionCode >= reservation.versionCode;
        } catch {
          return false;
        }
      })(),
  )
)
  throw new Error("A newer release has already shipped.");
if (!existing)
  gh(
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--target",
    revision,
    "--draft",
    "--title",
    `T3 Code Imaorise ${version}`,
    "--notes",
    `${JSON.stringify(reservation)}\n\nPersonal ${channel} release. Windows is unsigned. Android uses the existing personal signing certificate.`,
    ...(channel === "beta" ? ["--prerelease"] : []),
  );
NodeFS.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `revision=${revision}\nversion=${version}\nversion_code=${reservation.versionCode}\ntag=${tag}\nchannel=${channel}\n`,
);
