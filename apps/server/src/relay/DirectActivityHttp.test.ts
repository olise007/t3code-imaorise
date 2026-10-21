import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { directActivityRequest } from "../http.ts";
import * as DirectActivity from "./DirectActivity.ts";

function request(
  options: { scopes?: AuthEnvironmentScope[]; revokeAfterRead?: boolean; cursor?: string } = {},
) {
  let reads = 0;
  let authentications = 0;
  const auth = {
    authenticateHttpRequest: () => {
      authentications++;
      return options.revokeAfterRead && reads > 0
        ? Effect.fail(
            new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "revoked" }),
          )
        : Effect.succeed({
            sessionId: AuthSessionId.make("session"),
            subject: "paired-phone",
            method: "bearer-access-token" as const,
            scopes: options.scopes ?? ["orchestration:read"],
          });
    },
  } satisfies Pick<EnvironmentAuth.EnvironmentAuth["Service"], "authenticateHttpRequest">;
  const effect = directActivityRequest.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(
          `http://environment/api/direct-agent-activity${options.cursor ? `?cursor=${options.cursor}` : ""}`,
          { headers: { authorization: "Bearer paired-token" } },
        ),
      ),
    ),
    Effect.provideService(
      EnvironmentAuth.EnvironmentAuth,
      auth as unknown as EnvironmentAuth.EnvironmentAuth["Service"],
    ),
    Effect.provideService(DirectActivity.DirectActivity, {
      read: () =>
        Effect.sync(() => {
          reads++;
          return {
            environmentId: EnvironmentId.make("environment"),
            cursor: "epoch:1",
            reset: false,
            more: false,
            events: [],
          };
        }),
    }),
  );
  return { effect, reads: () => reads, authentications: () => authentications };
}

it.effect("requires orchestration read before observing activity", () =>
  Effect.gen(function* () {
    const test = request({ scopes: [] });
    const result = yield* test.effect.pipe(Effect.flip);
    assert.equal(result._tag, "EnvironmentScopeRequiredError");
    assert.equal(test.reads(), 0);
  }),
);
it.effect("rechecks authorization before returning a parked response", () =>
  Effect.gen(function* () {
    const test = request({ revokeAfterRead: true });
    const result = yield* test.effect.pipe(Effect.flip);
    assert.equal(result._tag, "EnvironmentAuthInvalidError");
    assert.equal(test.reads(), 1);
    assert.equal(test.authentications(), 2);
  }),
);
it.effect("returns only bounded activity metadata without caching", () =>
  Effect.gen(function* () {
    const test = request();
    const response = HttpServerResponse.toWeb(yield* test.effect);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(yield* Effect.promise(() => response.json()), {
      environmentId: "environment",
      cursor: "epoch:1",
      reset: false,
      more: false,
      events: [],
    });
  }),
);
it.effect("rejects malformed cursor values without reading activity", () =>
  Effect.gen(function* () {
    const test = request({ cursor: "invalid" });
    const response = yield* test.effect;
    assert.equal(response.status, 400);
    assert.equal(test.reads(), 0);
  }),
);
