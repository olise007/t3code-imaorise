import * as Data from "effect/Data";
import {
  AuthAccessWriteScope,
  AuthSessionId,
  type AuthGrantScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  makeEnvironmentHttpApiGroupClient,
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
} from "@t3tools/client-runtime/rpc";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as Effect from "effect/Effect";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";

class EnvironmentAccessTargetError extends Data.TaggedError("EnvironmentAccessTargetError")<{
  readonly message: string;
}> {}
type AuthClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"auth">>>;
function requestAccess<A, E>(
  environmentId: EnvironmentId,
  path: string,
  request: (client: AuthClient, headers: { authorization: string }) => Effect.Effect<A, E>,
) {
  const prepared = readPreparedConnection(environmentId);
  if (
    !prepared ||
    prepared.httpAuthorization?._tag !== "Bearer" ||
    !readEnvironmentScope(environmentId, AuthAccessWriteScope)
  ) {
    return Promise.reject(new Error("Reconnect to WSL with Manage access permission."));
  }
  const headers = { authorization: `Bearer ${prepared.httpAuthorization.token}` };
  return Effect.runPromise(
    Effect.gen(function* () {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: prepared.httpBaseUrl,
      });
      if (descriptor.environmentId !== environmentId)
        return yield* Effect.fail(
          new EnvironmentAccessTargetError({
            message: "The endpoint belongs to a different environment.",
          }),
        );
      const client = yield* makeEnvironmentHttpApiGroupClient(prepared.httpBaseUrl, "auth");
      return yield* executeEnvironmentHttpRequest(
        new URL(path, prepared.httpBaseUrl).href,
        5000,
        request(client, headers),
      );
    }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch))),
  );
}
export const createEnvironmentPairingCredential = (
  environmentId: EnvironmentId,
  input: { label?: string; scopes?: readonly AuthGrantScope[] },
) =>
  requestAccess(environmentId, "/api/auth/pairing-token", (client, headers) =>
    client.pairingCredential({ headers, payload: input }),
  );
export const revokeEnvironmentPairingLink = (environmentId: EnvironmentId, id: string) =>
  requestAccess(environmentId, "/api/auth/pairing-links/revoke", (client, headers) =>
    client.revokePairingLink({ headers, payload: { id } }),
  );
export const revokeEnvironmentClient = (environmentId: EnvironmentId, sessionId: string) =>
  requestAccess(environmentId, "/api/auth/clients/revoke", (client, headers) =>
    client.revokeClient({ headers, payload: { sessionId: AuthSessionId.make(sessionId) } }),
  );
export const revokeOtherEnvironmentClients = (environmentId: EnvironmentId) =>
  requestAccess(environmentId, "/api/auth/clients/revoke-others", (client, headers) =>
    client.revokeOtherClients({ headers }),
  );
