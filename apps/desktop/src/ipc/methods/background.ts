import {
  DesktopBackgroundSettingsSchema,
  DesktopBackgroundSettingsPatchSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopBackgroundRuntime from "../../wsl/DesktopBackgroundRuntime.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getBackgroundSettings = makeIpcMethod({
  channel: Channels.GET_BACKGROUND_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundSettingsSchema,
  handler: () =>
    Effect.gen(function* () {
      return yield* (yield* DesktopBackgroundRuntime.DesktopBackgroundRuntime).getSettings;
    }),
});
export const setBackgroundSettings = makeIpcMethod({
  channel: Channels.SET_BACKGROUND_SETTINGS_CHANNEL,
  payload: DesktopBackgroundSettingsPatchSchema,
  result: DesktopBackgroundSettingsSchema,
  handler: (input) =>
    Effect.gen(function* () {
      return yield* (yield* DesktopBackgroundRuntime.DesktopBackgroundRuntime).setSettings(input);
    }),
});
export const setBackgroundServerRunning = makeIpcMethod({
  channel: Channels.SET_BACKGROUND_SERVER_RUNNING_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopBackgroundSettingsSchema,
  handler: (running) =>
    Effect.gen(function* () {
      return yield* (yield* DesktopBackgroundRuntime.DesktopBackgroundRuntime).setRunning(running);
    }),
});
