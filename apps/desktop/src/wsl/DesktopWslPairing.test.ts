import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Pool from "../backend/DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import * as Settings from "../settings/DesktopAppSettings.ts";
import {
  make,
  makeLiveIO,
  pairingEndpoint,
  reconcileRoute,
  routeMapping,
  WslPairingError,
  type WslPairingIO,
} from "./DesktopWslPairing.ts";

const target = "http://127.0.0.1:4775";
const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: "wsl-environment",
  label: "WSL",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "2.0.1-beta.17",
  capabilities: {},
});
function fixture(initial: Record<string, string> = {}) {
  const mappings = new Map(Object.entries(initial));
  const tcpPorts = new Set<string>();
  const commands: string[][] = [];
  let mismatched = false;
  let denied = false;
  const io: WslPairingIO = {
    command: async (args) => {
      commands.push([...args]);
      if (args[0] === "status")
        return JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "host.tail.ts.net.", TailscaleIPs: ["100.90.1.2"] },
        });
      if (args[1] === "status")
        return JSON.stringify({
          TCP: Object.fromEntries(
            [...mappings].map(([port, url]) => [
              port,
              tcpPorts.has(port) ? { TCPForward: new URL(url).host } : { HTTPS: true },
            ]),
          ),
          Web: Object.fromEntries(
            [...mappings]
              .filter(([port]) => !tcpPorts.has(port))
              .map(([port, url]) => [
                `host.tail.ts.net:${port}`,
                { Handlers: { "/": { Proxy: url } } },
              ]),
          ),
        });
      const flag = args.find((arg) => arg.startsWith("--https=") || arg.startsWith("--tcp="))!;
      const port = flag.split("=")[1]!;
      if (args.at(-1) === "off") {
        mappings.delete(port);
        tcpPorts.delete(port);
      } else {
        mappings.set(port, args.at(-1)!.replace(/^tcp:/, "http:"));
        if (flag.startsWith("--tcp=")) tcpPorts.add(port);
        else tcpPorts.delete(port);
      }
      return "";
    },
    descriptor: async (url) =>
      mismatched && !url.startsWith("http://127.0.0.1")
        ? { ...descriptor, environmentId: EnvironmentId.make("other-environment") }
        : descriptor,
    authorize: async () => {
      if (denied) throw new WslPairingError({ message: "Permission denied" });
    },
  };
  return {
    io,
    mappings,
    commands,
    mismatch: () => {
      mismatched = true;
    },
    deny: () => {
      denied = true;
    },
  };
}
const route = { enabled: true, port: 4776, target: null };

describe("WSL Tailscale routes", () => {
  it("constructs an IP endpoint without DNS and rejects non-tailnet addresses", () => {
    const ipRoute = { ...route, protocol: "http" as const, port: 4777 };
    expect(
      pairingEndpoint(
        { Self: { TailscaleIPs: ["192.168.1.2", "fd7a::1", "100.90.1.2"] } },
        ipRoute,
      ),
    ).toBe("http://100.90.1.2:4777/");
    expect(() =>
      pairingEndpoint({ Self: { TailscaleIPs: ["192.168.1.2", "100.64..1"] } }, ipRoute),
    ).toThrow("no assigned IPv4");
    expect(() =>
      pairingEndpoint({ BackendState: "Stopped", Self: { TailscaleIPs: ["100.90.1.2"] } }, ipRoute),
    ).toThrow("Connect Tailscale");
  });
  it("creates and removes a verified IP route without modifying other services", async () => {
    const f = fixture({ "443": "http://127.0.0.1:8080" });
    const ipRoute = { ...route, protocol: "http" as const, port: 4777 };
    const result = await reconcileRoute({
      io: f.io,
      route: ipRoute,
      target,
      environmentId: descriptor.environmentId,
    });
    expect(result.endpointUrl).toBe("http://100.90.1.2:4777/");
    expect(f.commands).toContainEqual(["serve", "--bg", "--tcp=4777", "tcp://127.0.0.1:4775"]);
    await reconcileRoute({
      io: f.io,
      route: { ...ipRoute, enabled: false, target },
      target,
      environmentId: descriptor.environmentId,
    });
    expect(Object.fromEntries(f.mappings)).toEqual({ "443": "http://127.0.0.1:8080" });
    expect(f.commands).toContainEqual(["serve", "--tcp=4777", "off"]);
  });
  it("rolls back an IP route when endpoint identity verification fails", async () => {
    const f = fixture();
    f.mismatch();
    await expect(
      reconcileRoute({
        io: f.io,
        route: { ...route, protocol: "http", port: 4777 },
        target,
        environmentId: descriptor.environmentId,
      }),
    ).rejects.toThrow("different environment");
    expect(f.mappings.size).toBe(0);
  });
  it("rejects a backend port collision before touching Tailscale", async () => {
    const f = fixture();
    await expect(
      reconcileRoute({
        io: f.io,
        route: { ...route, port: 4775 },
        target,
        environmentId: descriptor.environmentId,
      }),
    ).rejects.toThrow("conflicts with the WSL backend");
    expect(f.commands).toEqual([]);
  });

  it("creates a verified WSL endpoint without changing Windows or other ports", async () => {
    const f = fixture({ "443": "http://127.0.0.1:8080", "4774": "http://127.0.0.1:4774" });
    const result = await reconcileRoute({
      io: f.io,
      route,
      target,
      environmentId: descriptor.environmentId,
    });
    expect(result.endpointUrl).toBe("https://host.tail.ts.net:4776/");
    expect(Object.fromEntries(f.mappings)).toEqual({
      "443": "http://127.0.0.1:8080",
      "4774": "http://127.0.0.1:4774",
      "4776": target,
    });
  });
  it("rejects another service even when it is offline", async () => {
    const f = fixture({ "4776": "http://127.0.0.1:9999" });
    await expect(
      reconcileRoute({ io: f.io, route, target, environmentId: descriptor.environmentId }),
    ).rejects.toThrow("another service");
    expect(f.mappings.get("4776")).toBe("http://127.0.0.1:9999");
  });
  it("rejects a port with additional paths or raw TCP forwarding", () => {
    expect(routeMapping({ TCP: { "4776": {} } }, 4776)).toBe("occupied");
    expect(
      routeMapping(
        {
          Web: {
            "host:4776": { Handlers: { "/": { Proxy: target }, "/other": { Proxy: target } } },
          },
        },
        4776,
      ),
    ).toBe("occupied");
  });
  it("rolls back a new mapping after environment identity mismatch", async () => {
    const f = fixture();
    f.mismatch();
    await expect(
      reconcileRoute({ io: f.io, route, target, environmentId: descriptor.environmentId }),
    ).rejects.toThrow("different environment");
    expect(f.mappings.has("4776")).toBe(false);
  });
  it("updates a previously owned proxy when the backend port changes", async () => {
    const f = fixture({ "4776": target });
    await reconcileRoute({
      io: f.io,
      route: { ...route, target },
      target: "http://127.0.0.1:4778",
      environmentId: descriptor.environmentId,
    });
    expect(f.mappings.get("4776")).toBe("http://127.0.0.1:4778");
  });
  it("restores the previous proxy after failed restart verification", async () => {
    const f = fixture({ "4776": target });
    f.mismatch();
    await expect(
      reconcileRoute({
        io: f.io,
        route: { ...route, target },
        target: "http://127.0.0.1:4778",
        environmentId: descriptor.environmentId,
      }),
    ).rejects.toThrow();
    expect(f.mappings.get("4776")).toBe(target);
  });
  it("removes only the owned mapping when WSL stops, then restores it", async () => {
    const f = fixture({ "4776": target, "4774": "http://127.0.0.1:4774" });
    const owned = { ...route, target };
    await reconcileRoute({ io: f.io, route: owned, target: null, environmentId: null });
    expect(f.mappings.has("4776")).toBe(false);
    expect(f.mappings.has("4774")).toBe(true);
    await reconcileRoute({
      io: f.io,
      route: owned,
      target,
      environmentId: descriptor.environmentId,
    });
    expect(f.mappings.get("4776")).toBe(target);
  });
  it("does not remove a mapping replaced by another service", async () => {
    const f = fixture({ "4776": "http://127.0.0.1:9999" });
    await reconcileRoute({
      io: f.io,
      route: { ...route, target, enabled: false },
      target: null,
      environmentId: null,
    });
    expect(f.mappings.get("4776")).toBe("http://127.0.0.1:9999");
  });
});

function service(
  f: ReturnType<typeof fixture>,
  options: { wslOnly?: boolean; ready?: boolean; failSave?: () => boolean } = {},
) {
  const instance = {
    id: Pool.BackendInstanceId("wsl:Ubuntu"),
    label: Effect.succeed("WSL Ubuntu"),
    start: Effect.void,
    stop: () => Effect.void,
    waitForReady: () => Effect.succeed(true),
    snapshot: Effect.succeed({
      ready: options.ready ?? true,
      desiredRunning: true,
      activePid: Option.some(1),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    currentConfig: Effect.succeedSome({
      httpBaseUrl: new URL(target),
    } as DesktopBackendStartConfig),
  } satisfies Pool.DesktopBackendInstance;
  return make(f.io).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.effect(
          Settings.DesktopAppSettings,
          Effect.gen(function* () {
            const settings = yield* Settings.DesktopAppSettings;
            return Settings.DesktopAppSettings.of({
              ...settings,
              setWslPairingRoute: (route) =>
                options.failSave?.()
                  ? Effect.fail(
                      new Settings.DesktopSettingsWriteError({
                        operation: "replace-settings-file",
                        path: "/test/settings.json",
                        cause: "write denied",
                      }),
                    )
                  : settings.setWslPairingRoute(route),
            });
          }),
        ).pipe(
          Layer.provide(
            Settings.layerTest({
              ...Settings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: options.wslOnly ?? false,
            }),
          ),
        ),
        Layer.succeed(Pool.DesktopBackendPool, {
          list: Effect.succeed([instance]),
          get: () => Effect.succeedSome(instance),
          primary: Effect.succeed(instance),
          register: () => Effect.succeed(instance),
          unregister: () => Effect.void,
        }),
      ),
    ),
  );
}
describe("managed WSL pairing", () => {
  it.effect("preserves IP availability when DNS verification fails", () =>
    Effect.gen(function* () {
      const f = fixture();
      const original = f.io.descriptor;
      const s = yield* service(f);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4776,
      });
      f.io.descriptor = (url) =>
        url.startsWith("https:") ? Promise.reject(new Error("DNS unavailable")) : original(url);
      const state = yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4777,
        protocol: "http",
      });
      expect(state.ipRoute?.endpointUrl).toBe("http://100.90.1.2:4777/");
      expect(state.endpointUrl).toBeNull();
      expect(state.error).not.toBeNull();
    }),
  );
  it.effect("rejects a shared port before modifying the existing DNS route", () =>
    Effect.gen(function* () {
      const f = fixture();
      const s = yield* service(f);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4776,
      });
      const error = yield* s
        .configure({
          environmentId: descriptor.environmentId,
          bearerToken: "private",
          enabled: true,
          port: 4776,
          protocol: "http",
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("different ports");
      expect(f.mappings.get("4776")).toBe(target);
    }),
  );
  it.effect("keeps DNS and IP active together and disables each independently", () =>
    Effect.gen(function* () {
      const f = fixture({ "443": "http://127.0.0.1:8080" });
      const s = yield* service(f);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4776,
      });
      const state = yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4777,
        protocol: "http",
      });
      expect(state.ipRoute?.enabled).toBe(true);
      expect(state.ipRoute?.endpointUrl).toBe("http://100.90.1.2:4777/");
      expect(f.mappings.has("4776")).toBe(true);
      yield* s.reconcile;
      expect((yield* s.getState).ipRoute?.endpointUrl).toBe(state.ipRoute?.endpointUrl);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: false,
        port: 4999,
        protocol: "http",
      });
      expect(f.mappings.has("4777")).toBe(false);
      expect(f.mappings.get("4776")).toBe(target);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: false,
        port: 4776,
      });
      expect(Object.fromEntries(f.mappings)).toEqual({ "443": "http://127.0.0.1:8080" });
    }),
  );
  it.effect("rejects an environment ID mismatch before changing routes", () =>
    Effect.gen(function* () {
      const f = fixture();
      const s = yield* service(f);
      const error = yield* s
        .configure({
          environmentId: EnvironmentId.make("windows"),
          bearerToken: "private",
          enabled: true,
          port: 4776,
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("not running");
      expect(f.commands).toEqual([]);
    }),
  );
  it.effect("rejects denied permission before changing routes", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.deny();
      const s = yield* service(f);
      const error = yield* s
        .configure({
          environmentId: descriptor.environmentId,
          bearerToken: "private",
          enabled: true,
          port: 4776,
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("Permission denied");
      expect(f.commands).toEqual([]);
    }),
  );
  it.effect("uses primary controls in WSL-only mode", () =>
    Effect.gen(function* () {
      const f = fixture();
      const s = yield* service(f, { wslOnly: true });
      expect((yield* s.getState).running).toBe(false);
      yield* s.reconcile;
      expect(f.commands).toEqual([]);
    }),
  );
  it.effect("disables the owned port even if the user edited the port field", () =>
    Effect.gen(function* () {
      const f = fixture();
      const s = yield* service(f);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4776,
      });
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: false,
        port: 4999,
      });
      expect(f.mappings.has("4776")).toBe(false);
      expect((yield* s.getState).port).toBe(4776);
    }),
  );
  it.effect("moves the HTTPS route while preserving other mappings", () =>
    Effect.gen(function* () {
      const f = fixture({ "443": "http://127.0.0.1:8080", "4774": "http://127.0.0.1:4774" });
      const s = yield* service(f);
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4776,
      });
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4885,
      });
      expect(f.mappings.has("4776")).toBe(false);
      expect(f.mappings.get("4885")).toBe(target);
      expect(f.mappings.get("4774")).toBe("http://127.0.0.1:4774");
      expect((yield* s.getState).port).toBe(4885);
    }),
  );
  it.effect("restores both ports when saving a route change fails", () =>
    Effect.gen(function* () {
      const f = fixture();
      let fail = false;
      const s = yield* service(f, { failSave: () => fail });
      yield* s.configure({
        environmentId: descriptor.environmentId,
        bearerToken: "private",
        enabled: true,
        port: 4776,
      });
      fail = true;
      yield* s
        .configure({
          environmentId: descriptor.environmentId,
          bearerToken: "private",
          enabled: true,
          port: 4885,
        })
        .pipe(Effect.flip);
      expect(f.mappings.get("4776")).toBe(target);
      expect(f.mappings.has("4885")).toBe(false);
      expect((yield* s.getState).port).toBe(4776);
    }),
  );
  it.effect("does not offer pairing for an unavailable backend", () =>
    Effect.gen(function* () {
      const f = fixture();
      const s = yield* service(f, { ready: false });
      expect((yield* s.getState).environmentId).toBeNull();
      expect(f.commands).toEqual([]);
    }),
  );
});

describe("WSL pairing HTTP authorization", () => {
  it.effect("accepts an authorized session with its JSON-encoded expiry", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                authenticated: true,
                auth: {
                  policy: "remote-reachable",
                  bootstrapMethods: ["desktop-bootstrap"],
                  sessionMethods: ["bearer-access-token"],
                  sessionCookieName: "t3_session_4776",
                  serverUpdateScope: "environment:maintain",
                },
                scopes: ["access:write", "environment:maintain"],
                expiresAt: "2026-10-12T00:00:00.000Z",
              }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      );
      const io = yield* makeLiveIO.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provide(NodeServices.layer),
      );
      yield* Effect.promise(() => io.authorize(target, "test-only-bearer"));
    }),
  );
});
