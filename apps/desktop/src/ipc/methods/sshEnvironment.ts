import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentAuthError,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  EnvironmentAuthInvalidError,
  DesktopDiscoveredSshHostSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshServerStatusSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshExecutionSourceSchema,
  DesktopSshDiscoveryReportSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancelledType,
  DesktopSshPasswordPromptResolutionInputSchema,
  ExecutionEnvironmentDescriptor,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  SshSetupApproval,
} from "@t3tools/contracts";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";
import { discoverConnections } from "../../ssh/DesktopSshDiscovery.ts";

type DesktopSshEnvironmentRequestOperation =
  | "fetch-environment-descriptor"
  | "bootstrap-bearer-session"
  | "fetch-session-state"
  | "issue-websocket-ticket";

type DesktopSshEnvironmentRequestCause = RemoteEnvironmentAuthError | SshHttpBridgeError;

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);
const isEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);

function readSshHttpStatus(cause: DesktopSshEnvironmentRequestCause): number | null {
  if (
    cause instanceof RemoteEnvironmentAuthUndeclaredStatusError ||
    cause instanceof SshHttpBridgeError
  ) {
    return cause.status ?? null;
  }
  if (isEnvironmentRequestInvalidError(cause)) {
    return 400;
  }
  if (isEnvironmentAuthInvalidError(cause)) {
    return 401;
  }
  if (isEnvironmentScopeRequiredError(cause)) {
    return 403;
  }
  if (isEnvironmentOperationForbiddenError(cause)) {
    return 403;
  }
  if (isEnvironmentInternalError(cause)) {
    return 500;
  }
  return null;
}

export class DesktopSshEnvironmentRequestError extends Data.TaggedError(
  "DesktopSshEnvironmentRequestError",
)<{
  readonly operation: DesktopSshEnvironmentRequestOperation;
  readonly cause: DesktopSshEnvironmentRequestCause;
  readonly sshHttpStatus: number | null;
}> {
  override get message() {
    const prefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${prefix}SSH remote API request failed during ${this.operation}.`;
  }
}

const withLoopbackSshApi =
  <A, R>(
    operation: DesktopSshEnvironmentRequestOperation,
    use: (httpBaseUrl: string) => Effect.Effect<A, RemoteEnvironmentAuthError, R>,
  ) =>
  (httpBaseUrl: string): Effect.Effect<A, DesktopSshEnvironmentRequestError, R> =>
    resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.flatMap(use),
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation,
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );

export const discoverSshHosts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopDiscoveredSshHostSchema),
  handler: Effect.fn("desktop.ipc.sshEnvironment.discoverHosts")(function* () {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.discoverHosts();
  }),
});

export const resolveSshHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_HOST_CHANNEL,
  payload: Schema.Union([
    Schema.String,
    Schema.Struct({
      alias: Schema.String,
      executionSource: Schema.optional(DesktopSshExecutionSourceSchema),
    }),
  ]),
  result: DesktopSshEnvironmentTargetSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolveHost")(function* (alias) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.resolveHost(
      typeof alias === "string" ? alias : alias.alias,
      typeof alias === "string" ? { type: "local" } : (alias.executionSource ?? { type: "local" }),
    );
  }),
});

export const discoverSshConnections = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_SSH_CONNECTIONS_CHANNEL,
  payload: Schema.optional(Schema.String),
  result: DesktopSshDiscoveryReportSchema,
  handler: (loadDistro) => discoverConnections(loadDistro),
});

export const sshServerStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SSH_SERVER_STATUS_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: DesktopSshServerStatusSchema,
  handler: (target) =>
    Effect.flatMap(
      DesktopSshEnvironment.DesktopSshEnvironment,
      (service) =>
        service.serverStatus?.(target) ??
        Effect.map(DateTime.now, (now) => ({
          state: "unknown" as const,
          checkedAt: DateTime.formatIso(now),
        })),
    ),
});
export const stopSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STOP_SSH_ENVIRONMENT_CHANNEL,
  payload: Schema.Union([
    DesktopSshEnvironmentTargetSchema,
    Schema.Struct({
      target: DesktopSshEnvironmentTargetSchema,
      options: Schema.Struct({
        expectedEnvironmentId: Schema.optionalKey(Schema.NonEmptyString),
        operationId: Schema.optionalKey(Schema.NonEmptyString),
      }),
    }),
  ]),
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(DesktopSshEnvironment.DesktopSshEnvironment, (service) =>
      "target" in input
        ? service.stopEnvironment(input.target, input.options)
        : service.stopEnvironment(input),
    ),
});
export const cancelSshSetup = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_SSH_SETUP_CHANNEL,
  payload: Schema.Union([
    DesktopSshEnvironmentTargetSchema,
    Schema.Struct({
      target: DesktopSshEnvironmentTargetSchema,
      operationId: Schema.NonEmptyString,
    }),
  ]),
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(DesktopSshEnvironment.DesktopSshEnvironment, (service) =>
      "target" in input
        ? service.cancelSetup(input.target, input.operationId)
        : service.cancelSetup(input),
    ),
});
export const forgetSshCredentials = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORGET_SSH_CREDENTIALS_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: Schema.Void,
  handler: (target) =>
    Effect.flatMap(
      DesktopSshEnvironment.DesktopSshEnvironment,
      (service) => service.forgetCredentials?.(target) ?? Effect.void,
    ),
});

export const ensureSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentEnsureInputSchema,
  result: DesktopSshEnvironmentEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.ensureEnvironment")(function* ({
    target,
    options,
  }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.ensureEnvironment(target, options).pipe(
      Effect.catchIf(DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation, (error) =>
        Effect.succeed({
          type: DesktopSshPasswordPromptCancelledType,
          message: error.message,
        }),
      ),
    );
  }),
});

export const disconnectSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.disconnectEnvironment")(function* (target) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    yield* sshEnvironment.disconnectEnvironment(target);
  }),
});

export const fetchSshEnvironmentDescriptor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  payload: DesktopSshHttpBaseUrlInputSchema,
  result: ExecutionEnvironmentDescriptor,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchDescriptor")(function* ({ httpBaseUrl }) {
    return yield* withLoopbackSshApi("fetch-environment-descriptor", (resolvedHttpBaseUrl) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvedHttpBaseUrl }),
    )(httpBaseUrl);
  }),
});

export const bootstrapSshBearerSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  payload: DesktopSshBearerBootstrapInputSchema,
  result: AuthAccessTokenResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.bootstrapBearerSession")(function* ({
    httpBaseUrl,
    credential,
  }) {
    return yield* withLoopbackSshApi("bootstrap-bearer-session", (resolvedHttpBaseUrl) =>
      bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedHttpBaseUrl,
        credential,
      }),
    )(httpBaseUrl);
  }),
});

export const fetchSshSessionState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthSessionState,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchSessionState")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("fetch-session-state", (resolvedHttpBaseUrl) =>
      fetchRemoteSessionState({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const issueSshWebSocketTicket = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthWebSocketTicketResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.issueWebSocketTicket")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("issue-websocket-ticket", (resolvedHttpBaseUrl) =>
      issueRemoteWebSocketTicket({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const resolveSshPasswordPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  payload: DesktopSshPasswordPromptResolutionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolvePasswordPrompt")(function* ({
    requestId,
    password,
  }) {
    const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    yield* prompts.resolve({ requestId, password });
  }),
});

export const resolveSshSetupReview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_SETUP_REVIEW_CHANNEL,
  payload: Schema.Struct({ requestId: Schema.String, approval: Schema.NullOr(SshSetupApproval) }),
  result: Schema.Void,
  handler: ({ requestId, approval }) =>
    Effect.flatMap(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, (prompts) =>
      prompts.resolve({ requestId, password: approval === null ? null : JSON.stringify(approval) }),
    ),
});
