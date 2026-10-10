import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Data from "effect/Data";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  sessionGrantsScope,
  type DesktopWslPairingState,
  type DesktopWslPairingInputSchema,
} from "@t3tools/contracts";
import { buildTailscaleHttpsBaseUrl } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

type Route = DesktopAppSettings.DesktopSettings["wslPairingRoute"];
type Input = typeof DesktopWslPairingInputSchema.Type;
export interface WslPairingIO {
  command: (args: readonly string[]) => Promise<string>;
  descriptor: (url: string) => Promise<typeof ExecutionEnvironmentDescriptor.Type>;
  authorize: (url: string, token: string) => Promise<void>;
}

export class WslPairingError extends Data.TaggedError("WslPairingError")<{
  readonly message: string;
}> {}
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeSession = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState));
const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      Self: Schema.optionalKey(Schema.Struct({ DNSName: Schema.optionalKey(Schema.String) })),
    }),
  ),
);
export const makeLiveIO = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const client = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const requestJson = (url: string, token?: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const request = HttpClientRequest.get(url);
        const response = yield* client.execute(
          token
            ? HttpClientRequest.setHeader(request, "Authorization", `Bearer ${token}`)
            : request,
        );
        if (response.status !== 200)
          return yield* Effect.fail(
            new WslPairingError({
              message:
                "WSL rejected the request. Reconnect with permission to manage access and maintain the environment.",
            }),
          );
        return yield* response.json;
      }).pipe(Effect.timeout("5 seconds"), Effect.scoped),
    );
  return {
    command: (args) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(platform === "win32" ? "tailscale.exe" : "tailscale", [...args]),
          );
          const output = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          );
          if (Number(yield* child.exitCode) !== 0)
            return yield* Effect.fail(
              new WslPairingError({
                message:
                  "Tailscale could not complete setup. Install Tailscale, sign in, and check that HTTPS is enabled for your tailnet.",
              }),
            );
          return output;
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.scoped,
          Effect.mapError(
            () =>
              new WslPairingError({
                message:
                  "Tailscale could not complete setup. Install Tailscale, sign in, and check that HTTPS is enabled for your tailnet.",
              }),
          ),
        ),
      ),
    descriptor: async (url) =>
      decodeDescriptor(await requestJson(new URL("/.well-known/t3/environment", url).href)),
    authorize: async (url, token) => {
      const session = decodeSession(
        await requestJson(new URL("/api/auth/session", url).href, token),
      );
      if (
        !session.authenticated ||
        !sessionGrantsScope(session, AuthAccessWriteScope) ||
        !sessionGrantsScope(session, AuthEnvironmentMaintainScope)
      ) {
        throw new WslPairingError({
          message: "WSL pairing requires Manage access and Maintain environment permissions.",
        });
      }
    },
  } satisfies WslPairingIO;
});

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/** Read the whole port, not just '/', so unrelated paths cannot be overwritten. */
export function routeMapping(config: ServeConfig, port: number) {
  const entries = Object.entries(config.Web ?? {}).filter(([host]) => host.endsWith(`:${port}`));
  if (entries.length === 0 && !config.TCP?.[String(port)]) return null;
  if (entries.length !== 1) return "occupied";
  const handlers = entries[0]![1].Handlers ?? {};
  return Object.keys(handlers).length === 1 && handlers["/"]?.Proxy
    ? handlers["/"].Proxy
    : "occupied";
}

export async function reconcileRoute(input: {
  io: WslPairingIO;
  route: Route;
  target: string | null;
  environmentId: string | null;
}) {
  const { io, route, target, environmentId } = input;
  if (route.enabled && target && Number(new URL(target).port) === route.port) {
    throw new WslPairingError({
      message: `HTTPS port ${route.port} conflicts with the WSL backend. Choose another port, such as ${route.port === 4776 ? 4777 : 4776}.`,
    });
  }
  const mapping = routeMapping(
    JSON.parse(await io.command(["serve", "status", "--json"])),
    route.port,
  );
  if (!target || !route.enabled) {
    if (route.target && mapping === route.target)
      await io.command(["serve", `--https=${route.port}`, "off"]);
    return { endpointUrl: null, target: route.target, previousTarget: mapping };
  }
  if (mapping && mapping !== target && mapping !== route.target) {
    throw new WslPairingError({
      message: `HTTPS port ${route.port} belongs to another service. Choose a different port.`,
    });
  }
  const status = JSON.parse(await io.command(["status", "--json"]));
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName || (status.BackendState && status.BackendState !== "Running")) {
    throw new WslPairingError({
      message: "Sign in to Tailscale and connect it before pairing WSL.",
    });
  }
  const endpointUrl = buildTailscaleHttpsBaseUrl({ magicDnsName: dnsName, servePort: route.port });
  if (mapping !== target) await io.command(["serve", "--bg", `--https=${route.port}`, target]);
  try {
    if ((await io.descriptor(endpointUrl)).environmentId !== environmentId) {
      throw new WslPairingError({
        message: "The HTTPS address belongs to a different environment.",
      });
    }
  } catch (error) {
    if (mapping !== target) {
      if (mapping && mapping !== "occupied")
        await io.command(["serve", "--bg", `--https=${route.port}`, mapping]);
      else await io.command(["serve", `--https=${route.port}`, "off"]);
    }
    throw new WslPairingError({
      message:
        error instanceof WslPairingError
          ? error.message
          : `The WSL HTTPS endpoint on port ${route.port} is unreachable. Check Tailscale connectivity or try another HTTPS port.`,
    });
  }
  return { endpointUrl, target, previousTarget: mapping };
}

export class DesktopWslPairing extends Context.Service<
  DesktopWslPairing,
  {
    readonly getState: Effect.Effect<DesktopWslPairingState>;
    readonly configure: (input: Input) => Effect.Effect<DesktopWslPairingState, WslPairingError>;
    readonly reconcile: Effect.Effect<void>;
  }
>()("@t3tools/desktop/wsl/DesktopWslPairing") {}

export const make = (io: WslPairingIO) =>
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const mutex = yield* Semaphore.make(1);
    const attempt = <A>(f: () => Promise<A>) =>
      Effect.tryPromise({
        try: f,
        catch: (e) =>
          e instanceof WslPairingError
            ? e
            : new WslPairingError({ message: "WSL pairing failed. Retry setup." }),
      });
    const target = Effect.gen(function* () {
      const s = yield* settings.get;
      if (!s.localEnvironmentEnabled || !s.wslBackendEnabled || s.wslOnly) return null;
      const instance = (yield* pool.list).find((i) => i.id === `wsl:${s.wslDistro ?? "default"}`);
      if (!instance || !(yield* instance.snapshot).ready) return null;
      const config = yield* instance.currentConfig;
      if (Option.isNone(config)) return null;
      const url = config.value.httpBaseUrl.href.replace(/\/$/, "");
      const descriptor = yield* attempt(() => io.descriptor(url));
      return { url, descriptor };
    });
    const read = Effect.gen(function* () {
      const s = yield* settings.get;
      const t = yield* target;
      let endpointUrl: string | null = null;
      if (t && s.wslPairingRoute.enabled) {
        if (Number(new URL(t.url).port) === s.wslPairingRoute.port)
          return yield* Effect.fail(
            new WslPairingError({
              message: `HTTPS port ${s.wslPairingRoute.port} conflicts with the WSL backend. Choose another port, such as ${s.wslPairingRoute.port === 4776 ? 4777 : 4776}.`,
            }),
          );
        const status = yield* decodeStatus(
          yield* attempt(() => io.command(["status", "--json"])),
        ).pipe(
          Effect.mapError(
            () =>
              new WslPairingError({
                message: "Tailscale status could not be read. Reconnect and retry.",
              }),
          ),
        );
        if (!status.Self?.DNSName)
          return yield* Effect.fail(
            new WslPairingError({ message: "Sign in to Tailscale to pair WSL." }),
          );
        endpointUrl = buildTailscaleHttpsBaseUrl({
          magicDnsName: status.Self.DNSName.replace(/\.$/, ""),
          servePort: s.wslPairingRoute.port,
        });
        const verifiedUrl = endpointUrl;
        if (
          (yield* attempt(() => io.descriptor(verifiedUrl))).environmentId !==
          t.descriptor.environmentId
        ) {
          return yield* Effect.fail(
            new WslPairingError({
              message: "The WSL HTTPS endpoint belongs to a different environment. Retry setup.",
            }),
          );
        }
      }
      return {
        environmentId: t?.descriptor.environmentId ?? null,
        distro: s.wslDistro,
        running: t !== null,
        enabled: s.wslPairingRoute.enabled,
        port: s.wslPairingRoute.port,
        endpointUrl,
        error: null,
      } satisfies DesktopWslPairingState;
    });
    const getState = read.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const s = yield* settings.get;
          const t = yield* target.pipe(Effect.orElseSucceed(() => null));
          return {
            environmentId: t?.descriptor.environmentId ?? null,
            distro: s.wslDistro,
            running: t !== null,
            enabled: s.wslPairingRoute.enabled,
            port: s.wslPairingRoute.port,
            endpointUrl: null,
            error: error.message,
          };
        }),
      ),
    );
    const reconcileBody = Effect.gen(function* () {
      const s = yield* settings.get;
      if (!s.wslPairingRoute.enabled && !s.wslPairingRoute.target) return;
      const t = yield* target;
      const result = yield* attempt(() =>
        reconcileRoute({
          io,
          route: s.wslPairingRoute,
          target: t?.url ?? null,
          environmentId: t?.descriptor.environmentId ?? null,
        }),
      );
      if (result.target !== s.wslPairingRoute.target)
        yield* settings.setWslPairingRoute({ ...s.wslPairingRoute, target: result.target });
    });
    const configure = (input: Input) =>
      mutex
        .withPermits(1)(
          Effect.gen(function* () {
            if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
              return yield* Effect.fail(
                new WslPairingError({ message: "Enter an HTTPS port between 1 and 65535." }),
              );
            const t = yield* target;
            if (!t || t.descriptor.environmentId !== input.environmentId)
              return yield* Effect.fail(
                new WslPairingError({
                  message: "The selected WSL environment is not running. Reconnect and retry.",
                }),
              );
            yield* attempt(() => io.authorize(t.url, input.bearerToken));
            if (input.enabled) {
              for (const backend of yield* pool.list) {
                const config = yield* backend.currentConfig;
                if (Option.isSome(config) && Number(config.value.httpBaseUrl.port) === input.port)
                  return yield* Effect.fail(
                    new WslPairingError({
                      message: `HTTPS port ${input.port} conflicts with a managed backend. Choose another port, such as ${input.port === 4776 ? 4777 : 4776}.`,
                    }),
                  );
              }
            }
            const s = yield* settings.get;
            const previous = s.wslPairingRoute;
            const selectedPort = input.enabled ? input.port : previous.port;
            const route = {
              enabled: input.enabled,
              port: selectedPort,
              target: previous.port === selectedPort ? previous.target : null,
            };
            const result = yield* attempt(() =>
              reconcileRoute({ io, route, target: t.url, environmentId: input.environmentId }),
            );
            let oldRouteRemoved = false;
            yield* Effect.gen(function* () {
              if (previous.port !== selectedPort && previous.target) {
                const oldMapping = yield* attempt(async () =>
                  routeMapping(
                    JSON.parse(await io.command(["serve", "status", "--json"])),
                    previous.port,
                  ),
                );
                if (oldMapping === previous.target) {
                  yield* attempt(() => io.command(["serve", `--https=${previous.port}`, "off"]));
                  oldRouteRemoved = true;
                }
              }
              yield* settings.setWslPairingRoute({ ...route, target: result.target });
            }).pipe(
              Effect.onError(() =>
                attempt(async () => {
                  const config = JSON.parse(await io.command(["serve", "status", "--json"]));
                  if (
                    routeMapping(config, selectedPort) === (input.enabled ? result.target : null)
                  ) {
                    if (result.previousTarget && result.previousTarget !== "occupied")
                      await io.command([
                        "serve",
                        "--bg",
                        `--https=${selectedPort}`,
                        result.previousTarget,
                      ]);
                    else await io.command(["serve", `--https=${selectedPort}`, "off"]);
                  }
                  if (
                    oldRouteRemoved &&
                    previous.target &&
                    routeMapping(config, previous.port) === null
                  )
                    await io.command([
                      "serve",
                      "--bg",
                      `--https=${previous.port}`,
                      previous.target,
                    ]);
                }).pipe(Effect.ignore),
              ),
            );
            return yield* getState;
          }),
        )
        .pipe(
          Effect.mapError((e) =>
            e instanceof WslPairingError
              ? e
              : new WslPairingError({ message: "Could not save WSL pairing settings." }),
          ),
        );
    return DesktopWslPairing.of({
      getState,
      configure,
      reconcile: mutex
        .withPermits(1)(reconcileBody)
        .pipe(Effect.catch(() => Effect.void)),
    });
  });
export const layer = Layer.effect(DesktopWslPairing, makeLiveIO.pipe(Effect.flatMap(make)));
