import { DesktopWslPairingStateSchema, DesktopWslPairingInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopWslPairing from "../../wsl/DesktopWslPairing.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getWslPairingState = makeIpcMethod({
  channel: IpcChannels.GET_WSL_PAIRING_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWslPairingStateSchema,
  handler: Effect.fnUntraced(function* () {
    return yield* (yield* DesktopWslPairing.DesktopWslPairing).getState;
  }),
});
export const setWslPairingRoute = makeIpcMethod({
  channel: IpcChannels.SET_WSL_PAIRING_ROUTE_CHANNEL,
  payload: DesktopWslPairingInputSchema,
  result: DesktopWslPairingStateSchema,
  handler: Effect.fnUntraced(function* (input) {
    return yield* (yield* DesktopWslPairing.DesktopWslPairing).configure(input);
  }),
});
