import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  DesktopSshEnvironmentTargetSchema,
  type DesktopSshExecutionSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DesktopSshEnvironment } from "../../ssh/DesktopSshEnvironment.ts";
import { sshHostRequest } from "../../ssh/sshHostRequest.ts";

import {
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
  resolveSshHost,
  sshServerStatus,
  stopSshEnvironment,
} from "./sshEnvironment.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("SSH environment IPC", () => {
  const resolverLayer = (
    calls: { alias: string; source: DesktopSshExecutionSource | undefined }[],
  ) =>
    Layer.succeed(
      DesktopSshEnvironment,
      DesktopSshEnvironment.of({
        cancelSetup: () => Effect.void,
        discoverHosts: () => Effect.die("unexpected discovery"),
        resolveHost: (alias, source) =>
          Effect.sync(() => {
            calls.push({ alias, source });
            return {
              alias,
              hostname: "resolved.example",
              username: "developer",
              port: 2222,
              executionSource: source ?? { type: "local" as const },
            };
          }),
        ensureEnvironment: () => Effect.die("unexpected remote setup"),
        disconnectEnvironment: () => Effect.die("unexpected disconnect"),
        stopEnvironment: () => Effect.die("unexpected stop"),
      }),
    );

  it.effect(
    "decodes preload and legacy local requests before resolving the selected source",
    () => {
      const calls: { alias: string; source: DesktopSshExecutionSource | undefined }[] = [];
      return Effect.gen(function* () {
        const discovered = sshHostRequest("SKA_DEV_ERP_SERVER");
        assert.equal(Object.hasOwn(discovered, "executionSource"), false);
        const cases = [
          { input: discovered, alias: "SKA_DEV_ERP_SERVER", source: { type: "local" } },
          { input: "legacy-alias", alias: "legacy-alias", source: { type: "local" } },
          {
            input: { alias: "old-preload", executionSource: undefined },
            alias: "old-preload",
            source: { type: "local" },
          },
          {
            input: sshHostRequest("192.0.2.10", { type: "local" }),
            alias: "192.0.2.10",
            source: { type: "local" },
          },
          {
            input: sshHostRequest("shared", { type: "wsl", distro: "Ubuntu 26.04" }),
            alias: "shared",
            source: { type: "wsl", distro: "Ubuntu 26.04" },
          },
          {
            input: sshHostRequest("shared", { type: "wsl", distro: "Debian" }),
            alias: "shared",
            source: { type: "wsl", distro: "Debian" },
          },
        ] as const;
        for (const expected of cases) {
          const result = yield* resolveSshHost
            .handler(expected.input)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DesktopSshEnvironmentTargetSchema)));
          assert.deepEqual(calls.at(-1), { alias: expected.alias, source: expected.source });
          assert.deepEqual(result.executionSource, expected.source);
        }
        assert.equal(calls.length, cases.length);
      }).pipe(Effect.provide(resolverLayer(calls)));
    },
  );

  it.effect("rejects malformed sources before resolving or contacting a host", () => {
    const calls: { alias: string; source: DesktopSshExecutionSource | undefined }[] = [];
    return Effect.gen(function* () {
      for (const executionSource of [
        null,
        "local",
        {},
        { type: "unknown" },
        { type: "wsl" },
        { type: "wsl", distro: "" },
      ]) {
        const result = yield* Effect.result(
          resolveSshHost.handler({ alias: "shared", executionSource }),
        );
        assert.equal(result._tag, "Failure");
      }
      assert.equal(calls.length, 0);
    }).pipe(Effect.provide(resolverLayer(calls)));
  });

  it.effect("fetches and decodes the remote environment descriptor", () => {
    const requestUrls: string[] = [];
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestUrls.push(request.url);
        return jsonResponse(request, {
          environmentId: "remote-env",
          label: "Remote Devbox",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.2.3",
          capabilities: { repositoryIdentity: true },
        });
      }),
    );

    return Effect.gen(function* () {
      const descriptor = yield* fetchSshEnvironmentDescriptor.handler({
        httpBaseUrl: "http://127.0.0.1:41773/",
      });

      assert.deepEqual(descriptor, {
        environmentId: "remote-env",
        label: "Remote Devbox",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1.2.3",
        capabilities: { repositoryIdentity: true },
      });
      assert.deepEqual(requestUrls, ["http://127.0.0.1:41773/.well-known/t3/environment"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("wraps schema decode failures in a typed request error", () => {
    const layer = layerHttpClient((request) =>
      Effect.succeed(jsonResponse(request, { environmentId: "remote-env" })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://127.0.0.1:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.equal(error.operation, "fetch-environment-descriptor");
      assert.equal(error.cause instanceof SshHttpBridgeError, false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});

it.effect(
  "decodes lifecycle status and expected destination identity without preparing a runtime",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const target = {
        alias: "fixture",
        hostname: "192.0.2.1",
        username: "user",
        port: 22,
        executionSource: { type: "wsl", distro: "Ubuntu" },
      };
      const layer = Layer.mock(DesktopSshEnvironment)({
        serverStatus: (value) =>
          Effect.sync(() => {
            calls.push(value);
            return { state: "stopped" as const, checkedAt: "2026-10-17T12:00:00Z" };
          }),
        stopEnvironment: (value, options) =>
          Effect.sync(() => {
            calls.push([value, options]);
          }),
      });
      const result = yield* sshServerStatus.handler(target).pipe(Effect.provide(layer));
      assert.deepEqual(result, { state: "stopped", checkedAt: "2026-10-17T12:00:00Z" });
      yield* stopSshEnvironment
        .handler({
          target,
          options: { expectedEnvironmentId: "verified", operationId: "operation" },
        })
        .pipe(Effect.provide(layer));
      assert.deepEqual(calls, [
        target,
        [target, { expectedEnvironmentId: "verified", operationId: "operation" }],
      ]);
    }),
);
