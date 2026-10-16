// @effect-diagnostics multipleEffectProvide:off - The catalog fixture supplies independently mocked service layers.
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { makeProviderVersionCatalog } from "./ProviderVersionCatalog.ts";

it.effect(
  "offers exact official artifacts, separates prereleases, and disables missing integrity",
  () =>
    Effect.gen(function* () {
      const release = (version: string, digest: string | null, prerelease = false) => ({
        tag_name: `rust-v${version}`,
        draft: false,
        prerelease,
        published_at: "2026-10-01T00:00:00Z",
        assets: [
          {
            name: "codex-package-x86_64-unknown-linux-musl.tar.gz",
            browser_download_url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-package-x86_64-unknown-linux-musl.tar.gz`,
            size: 100,
            digest,
          },
        ],
      });
      const entries = [
        release("0.156.1", `sha256:${"a".repeat(64)}`),
        release("0.156.0", null),
        release("0.157.0-alpha.1", `sha256:${"b".repeat(64)}`, true),
      ];
      const catalog = yield* makeProviderVersionCatalog().pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/latest")
                    ? entries[0]
                    : request.url.includes("/tags/")
                      ? entries[2]
                      : entries,
                ),
              ),
            ),
          ),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ),
        Effect.provide(
          Layer.mock(ModelManifest.ModelManifest)({
            current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          }),
        ),
      );
      const input = {
        provider: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
        page: 1,
        prereleases: false,
      };
      const stable = yield* catalog.page(input);
      expect(stable.releases.map((entry) => entry.version)).toEqual(["0.156.1", "0.156.0"]);
      expect(stable.releases[0]).toMatchObject({
        available: true,
        latestStable: true,
        channel: "stable",
      });
      expect(stable.releases[1]).toMatchObject({ available: false, integrity: null });
      expect((yield* catalog.page({ ...input, prereleases: true })).releases).toHaveLength(3);
      const selected = yield* catalog.resolve(input.provider, "0.157.0-alpha.1");
      expect(selected.release).toMatchObject({
        compatibility: "unknown",
        channel: "prerelease",
        integrity: `sha256:${"b".repeat(64)}`,
      });
      expect(selected.artifact?.kind).toBe("codex");
    }),
);

it.effect(
  "pages official package-manager releases independently of native artifacts and retains release dates",
  () =>
    Effect.gen(function* () {
      const name = "@openai/codex";
      const versions = Object.fromEntries(
        Array.from({ length: 55 }, (_, index) => [
          `1.0.${index}`,
          {
            dist: {
              tarball: `https://registry.npmjs.org/${name}/-/codex-1.0.${index}.tgz`,
              integrity: `sha512-${"a".repeat(86)}==`,
            },
          },
        ]),
      );
      versions["2.0.0-beta.1"] = {
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/codex-beta.tgz`,
          integrity: `sha512-${"b".repeat(86)}==`,
        },
      };
      const catalog = yield* makeProviderVersionCatalog().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json(
                      request.url.endsWith("/1.0.1")
                        ? { version: "1.0.1", ...versions["1.0.1"] }
                        : {
                            "dist-tags": { latest: "1.0.54" },
                            versions,
                            time: { "1.0.54": "2026-10-01T00:00:00Z" },
                          },
                    ),
                  ),
                ),
              ),
            ),
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "x64"),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ModelManifest.ModelManifest)({
              current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
            }),
          ),
        ),
      );
      const input = {
        provider: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("external"),
        page: 1,
        prereleases: false,
      };
      const page = yield* catalog.page(input, name);
      expect(page.releases).toHaveLength(50);
      expect(page.hasMore).toBe(true);
      expect(page.releases[0]).toMatchObject({
        version: "1.0.54",
        releasedAt: "2026-10-01T00:00:00Z",
        latestStable: true,
      });
      expect((yield* catalog.page({ ...input, page: 2 }, name)).releases).toHaveLength(5);
      expect(
        (yield* catalog.page({ ...input, prereleases: true }, name)).releases[0]?.channel,
      ).toBe("prerelease");
      const exact = yield* catalog.resolve(input.provider, "1.0.1", name);
      expect(exact.artifact?.kind).toBe("package");
      expect(exact.release.source).toContain("@openai/codex/-/codex-1.0.1.tgz");
    }),
);
