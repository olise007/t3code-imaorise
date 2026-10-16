import {
  ServerProviderUpdateError,
  type ProviderDriverKind,
  type ProviderVersionCatalogInput,
  type ProviderVersionCatalog as Catalog,
  type ProviderVersionRelease,
} from "@t3tools/contracts";
import {
  providerArchiveRecipe,
  NODE_PROVIDER_RUNTIME,
  type ProviderArchiveRecipe,
} from "@t3tools/shared/providerInstallRecipes";
import { satisfiesSemverRange, compareSemverVersions } from "@t3tools/shared/semver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import { resolveCodexReleaseAsset, type CodexReleaseAsset } from "./CodexInstallation.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

const GithubRelease = Schema.Struct({
  tag_name: Schema.String,
  prerelease: Schema.Boolean,
  draft: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
      size: Schema.Number,
      digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
const NpmCatalog = Schema.Struct({
  "dist-tags": Schema.Record(Schema.String, Schema.String),
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({
      dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.optionalKey(Schema.String) }),
    }),
  ),
  time: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
type Github = typeof GithubRelease.Type;
export type VersionArtifact =
  | { kind: "codex"; asset: CodexReleaseAsset }
  | { kind: "archive"; recipe: ProviderArchiveRecipe }
  | { kind: "package"; name: string; url: string; integrity: string }
  | { kind: "antigravity"; asset: AntigravityReleaseAsset };
export interface ResolvedProviderRelease {
  readonly release: ProviderVersionRelease;
  readonly artifact: VersionArtifact | null;
}

const npmNames: Readonly<Record<string, { linux: string; windows: string }>> = {
  claudeAgent: {
    linux: "@anthropic-ai/claude-code-linux-x64",
    windows: "@anthropic-ai/claude-code-win32-x64",
  },
  grok: { linux: "@xai-official/grok-linux-x64", windows: "@xai-official/grok-win32-x64" },
  opencode: {
    linux: "@opencode/cli-linux-x64-baseline",
    windows: "@opencode/cli-windows-x64-baseline",
  },
};
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/** Official catalogs only; missing integrity or a changed layout never falls back to a bundled release. */
export const makeProviderVersionCatalog = Effect.fn("ProviderVersionCatalog.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const manifest = yield* ModelManifest.ModelManifest;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const host = platform === "win32" ? "windows" : "linux";
  const error = (provider: ProviderDriverKind) =>
    new ServerProviderUpdateError({
      provider,
      reason:
        "Could not read the official version catalog. Check the environment's connection or try again later.",
    });
  const get = <S extends Schema.Top>(url: string, schema: S, accept = "application/json") =>
    http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Accept", accept),
          HttpClientRequest.setHeader("User-Agent", "T3-Code-Imaorise"),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            let bytes = 0;
            const text = yield* response.stream.pipe(
              Stream.mapEffect((chunk) => {
                bytes += chunk.length;
                return bytes <= 16 * 1024 * 1024
                  ? Effect.succeed(chunk)
                  : Effect.fail("The official catalog exceeds the supported response limit.");
              }),
              Stream.decodeText(),
              Stream.mkString,
            );
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text);
          }),
        ),
        Effect.scoped,
        Effect.timeout("30 seconds"),
      );
  const classify = Effect.fn("ProviderVersionCatalog.classify")(function* (
    provider: ProviderDriverKind,
    version: string,
    data: Omit<ProviderVersionRelease, "compatibility" | "recommended" | "available" | "reason">,
    artifact: VersionArtifact | null,
  ) {
    const policy =
      resolveProviderCompatibility((yield* manifest.current).compatibility, provider, version) ??
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        provider,
        version,
      );
    const compatibility = policy?.status ?? "unknown";
    const blocked = compatibility === "broken" || compatibility === "unsupported";
    return {
      artifact,
      release: {
        ...data,
        compatibility,
        recommended:
          policy?.recommendedVersion === version ||
          (data.latestStable &&
            compatibility === "supported" &&
            Boolean(
              policy?.recommendedRange && satisfiesSemverRange(version, policy.recommendedRange),
            )),
        available: artifact !== null && !blocked,
        reason: blocked
          ? (policy?.message ?? "This version is incompatible with T3 Code.")
          : artifact
            ? null
            : `No verified artifact is available for ${platform}-${arch}. Use the provider's installation instructions.`,
      },
    } satisfies ResolvedProviderRelease;
  });
  const fromGithub = Effect.fn("ProviderVersionCatalog.github")(function* (
    provider: ProviderDriverKind,
    entry: Github,
    latest: string | null,
  ) {
    const version = entry.tag_name.replace(/^(?:rust-)?v/, "");
    const codexTarget = resolveCodexReleaseAsset(platform, arch)?.target;
    const recipe = providerArchiveRecipe(provider, host);
    const name =
      provider === "codex"
        ? `codex-package-${codexTarget}.tar.gz`
        : platform === "win32"
          ? `pi-windows-${arch}.zip`
          : `pi-${platform}-${arch}.tar.gz`;
    const asset = entry.assets.find((asset) => asset.name === name);
    const integrity =
      asset?.digest && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? asset.digest : null;
    const repository = provider === "codex" ? "openai/codex" : "earendil-works/pi";
    const valid =
      asset &&
      integrity &&
      asset.size > 0 &&
      asset.browser_download_url.startsWith(`https://github.com/${repository}/releases/download/`);
    const artifact: VersionArtifact | null = valid
      ? provider === "codex" && codexTarget
        ? {
            kind: "codex",
            asset: {
              version,
              target: codexTarget,
              url: asset.browser_download_url,
              sha256: integrity.slice(7),
              archiveBytes: asset.size,
            },
          }
        : recipe && arch === "x64" && (platform === "linux" || platform === "win32")
          ? {
              kind: "archive",
              recipe: { ...recipe, version, url: asset.browser_download_url, integrity },
            }
          : null
      : null;
    return yield* classify(
      provider,
      version,
      {
        version,
        releasedAt: entry.published_at,
        channel: entry.prerelease || version.includes("-") ? "prerelease" : "stable",
        integrity,
        source: asset?.browser_download_url ?? `https://github.com/${repository}/releases`,
        latestStable: latest === entry.tag_name,
      },
      artifact,
    );
  });
  const load = Effect.fn("ProviderVersionCatalog.load")(function* (
    input: ProviderVersionCatalogInput,
    externalPackage?: string,
  ) {
    const provider = input.provider;
    if (!externalPackage && (provider === "codex" || provider === "pi")) {
      const repository = provider === "codex" ? "openai/codex" : "earendil-works/pi";
      const base = `https://api.github.com/repos/${repository}/releases`;
      const entries = yield* get(
        `${base}?per_page=50&page=${input.page}`,
        Schema.Array(GithubRelease),
      );
      const latest = yield* get(`${base}/latest`, GithubRelease).pipe(
        Effect.map((release) => release.tag_name),
        Effect.orElseSucceed(() => null),
      );
      const releases = yield* Effect.forEach(
        entries.filter(
          (release) =>
            !release.draft &&
            versionPattern.test(release.tag_name.replace(/^(?:rust-)?v/, "")) &&
            (input.prereleases ||
              (!release.prerelease &&
                !release.tag_name.includes("-", release.tag_name.startsWith("rust-") ? 5 : 0))),
        ),
        (entry) => fromGithub(provider, entry, latest),
      );
      return { releases, hasMore: entries.length === 50, message: null };
    }
    const name = externalPackage ?? npmNames[provider]?.[host];
    if (name && arch === "x64" && (platform === "linux" || platform === "win32")) {
      const metadata = yield* get(
        `https://registry.npmjs.org/${name.replace("/", "%2f")}`,
        NpmCatalog,
        "application/json",
      );
      const versions = Object.keys(metadata.versions)
        .filter(
          (version) =>
            versionPattern.test(version) && (input.prereleases || !version.includes("-")),
        )
        .sort((a, b) => compareSemverVersions(b, a));
      const releases = yield* Effect.forEach(
        versions.slice((input.page - 1) * 50, input.page * 50),
        (version) => {
          const dist = metadata.versions[version]!.dist;
          const integrity =
            dist.integrity && /^sha512-[A-Za-z0-9+/]+=*$/.test(dist.integrity)
              ? dist.integrity
              : null;
          const recipe = providerArchiveRecipe(provider, host);
          const artifact: VersionArtifact | null =
            (recipe || externalPackage) &&
            integrity &&
            dist.tarball.startsWith(`https://registry.npmjs.org/${name}/-/`)
              ? externalPackage
                ? { kind: "package", name, url: dist.tarball, integrity }
                : { kind: "archive", recipe: { ...recipe!, version, url: dist.tarball, integrity } }
              : null;
          return classify(
            provider,
            version,
            {
              version,
              releasedAt: metadata.time?.[version] ?? null,
              channel: version.includes("-") ? "prerelease" : "stable",
              integrity,
              source: dist.tarball,
              latestStable: metadata["dist-tags"].latest === version,
            },
            artifact,
          );
        },
      );
      return { releases, hasMore: versions.length > input.page * 50, message: null };
    }
    const asset =
      provider === "antigravity" ? resolveAntigravityReleaseAsset(platform, arch) : null;
    return {
      releases:
        asset && input.page === 1
          ? [
              yield* classify(
                provider,
                asset.version,
                {
                  version: asset.version,
                  releasedAt: null,
                  channel: "stable",
                  integrity: `sha256:${asset.sha256}`,
                  source: asset.url,
                  latestStable: false,
                  dependencies:
                    platform === "linux" || platform === "win32"
                      ? [
                          {
                            name: "Node.js, only if a compatible runtime is missing",
                            version: NODE_PROVIDER_RUNTIME[host].version,
                            source: NODE_PROVIDER_RUNTIME[host].url,
                            integrity: NODE_PROVIDER_RUNTIME[host].integrity,
                          },
                        ]
                      : [],
                },
                { kind: "antigravity", asset },
              ),
            ]
          : [],
      hasMore: false,
      message: asset
        ? "This vendor does not expose a verified release history. Only the shipped, verified release is available."
        : "This provider has no verified automatic version catalog for this platform. Existing package-manager and custom installations keep their own update workflow.",
    };
  });
  return {
    resolve: (provider: ProviderDriverKind, version: string, externalPackage?: string) =>
      Effect.gen(function* () {
        if (!versionPattern.test(version)) return yield* error(provider);
        if (!externalPackage && (provider === "codex" || provider === "pi")) {
          const repo = provider === "codex" ? "openai/codex" : "earendil-works/pi";
          const entry = yield* get(
            `https://api.github.com/repos/${repo}/releases/tags/${provider === "codex" ? "rust-v" : "v"}${version}`,
            GithubRelease,
          );
          if (entry.draft || entry.tag_name.replace(/^(?:rust-)?v/, "") !== version)
            return yield* error(provider);
          return yield* fromGithub(provider, entry, null);
        }
        // Npm catalogs have no pagination endpoint; resolve the exact dist metadata again.
        const name = externalPackage ?? npmNames[provider]?.[host];
        if (name) {
          const entry = yield* get(
            `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`,
            Schema.Struct({
              version: Schema.String,
              dist: Schema.Struct({
                tarball: Schema.String,
                integrity: Schema.optionalKey(Schema.String),
              }),
            }),
          );
          const recipe = providerArchiveRecipe(provider, host);
          const integrity = entry.dist.integrity ?? null;
          const artifact: VersionArtifact | null =
            (recipe || externalPackage) &&
            entry.version === version &&
            integrity &&
            /^sha512-[A-Za-z0-9+/]+=*$/.test(integrity) &&
            entry.dist.tarball.startsWith(`https://registry.npmjs.org/${name}/-/`)
              ? externalPackage
                ? { kind: "package", name, url: entry.dist.tarball, integrity }
                : {
                    kind: "archive",
                    recipe: { ...recipe!, version, integrity, url: entry.dist.tarball },
                  }
              : null;
          return yield* classify(
            provider,
            version,
            {
              version,
              releasedAt: null,
              channel: version.includes("-") ? "prerelease" : "stable",
              integrity,
              source: entry.dist.tarball,
              latestStable: false,
            },
            artifact,
          );
        }
        const data = yield* load({
          provider,
          instanceId: "catalog" as ProviderVersionCatalogInput["instanceId"],
          page: 1,
          prereleases: true,
        });
        const found = data.releases.find((entry) => entry.release.version === version);
        if (!found) return yield* error(provider);
        return found;
      }).pipe(Effect.mapError(() => error(provider))),
    page: (input: ProviderVersionCatalogInput, externalPackage?: string) =>
      Effect.gen(function* () {
        const data = yield* load(input, externalPackage);
        const snapshots = yield* providers.getProviders;
        const instance = snapshots.find(
          (provider) =>
            provider.instanceId === input.instanceId && provider.driver === input.provider,
        );
        return {
          releases: data.releases.map((entry) => entry.release),
          page: input.page,
          hasMore: data.hasMore,
          installedVersion: instance?.version ?? null,
          selectedVersion: instance?.version ?? null,
          affectedInstances: snapshots
            .filter((provider) => provider.driver === input.provider)
            .map((provider) => provider.displayName || provider.instanceId),
          message: data.message,
        } satisfies Catalog;
      }).pipe(Effect.mapError(() => error(input.provider))),
  };
});
