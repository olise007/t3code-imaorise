import { DesktopBackendStartupStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const getBackendStartupStates = makeIpcMethod({
  channel: Channels.GET_BACKEND_STARTUP_STATES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopBackendStartupStateSchema),
  handler: Effect.fn("desktop.ipc.backendStartup.read")(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    return yield* Effect.forEach(yield* pool.list, (instance) =>
      Effect.gen(function* () {
        const status = (yield* instance.snapshot).startupStatus;
        return {
          id: instance.id,
          label: yield* instance.label,
          ...(status === undefined ? {} : { status }),
        };
      }),
    );
  }),
});

export const retryBackendStartup = makeIpcMethod({
  channel: Channels.RETRY_BACKEND_STARTUP_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backendStartup.retry")(function* (id) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instance = yield* pool.get(DesktopBackendPool.BackendInstanceId(id));
    if (Option.isNone(instance)) return;
    yield* instance.value.retryStartup ?? Effect.void;
  }),
});
