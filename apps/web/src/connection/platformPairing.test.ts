import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { loadSecondaryConnectionRegistration } from "./platform";

afterEach(() => vi.unstubAllGlobals());
describe("managed desktop WSL access", () => {
  it.effect("requests access-management grants when bootstrapping the managed backend", () =>
    Effect.gen(function* () {
      vi.stubGlobal("navigator", {
        userAgent: "preview-test",
        platform: "Win32",
        maxTouchPoints: 0,
      });
      vi.stubGlobal("window", {});
      let requestedScopes: string[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/t3/environment"))
          return Response.json({
            environmentId: "managed-wsl",
            label: "WSL",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "2.0.1",
            capabilities: {},
          });
        expect(request.url).toBe("http://127.0.0.1:4775/oauth/token");
        const body = new URLSearchParams(await request.text());
        expect(body.get("subject_token")).toBe("desktop-owned-bootstrap");
        requestedScopes = (body.get("scope") ?? "").split(" ");
        return Response.json({
          access_token: "managed-bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: requestedScopes.join(" "),
        });
      };
      const result = yield* loadSecondaryConnectionRegistration({
        id: "wsl:Ubuntu",
        label: "WSL Ubuntu",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:4775",
        wsBaseUrl: "ws://127.0.0.1:4775",
        bootstrapToken: "desktop-owned-bootstrap",
      }).pipe(Effect.provide(layerRemoteHttpClient(fetcher)));
      expect(requestedScopes).toEqual(
        expect.arrayContaining([
          AuthAccessReadScope,
          AuthAccessWriteScope,
          AuthEnvironmentMaintainScope,
        ]),
      );
      expect(result.registration.target.environmentId).toBe(EnvironmentId.make("managed-wsl"));
      expect(result.registration.credential.token).toBe("managed-bearer");
    }),
  );
});
