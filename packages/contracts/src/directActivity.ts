import * as Schema from "effect/Schema";
import { EnvironmentId, RunId, ThreadId } from "./baseSchemas.ts";

export const DIRECT_ACTIVITY_PATH = "/api/direct-agent-activity";
export const DirectActivityEvent = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  phase: Schema.Literals(["waiting_for_approval", "waiting_for_input", "completed", "failed"]),
  title: Schema.String,
  headline: Schema.String,
  path: Schema.String,
});
export type DirectActivityEvent = typeof DirectActivityEvent.Type;
export const DirectActivityBatch = Schema.Struct({
  environmentId: EnvironmentId,
  cursor: Schema.String,
  reset: Schema.Boolean,
  more: Schema.Boolean,
  events: Schema.Array(DirectActivityEvent),
});
export type DirectActivityBatch = typeof DirectActivityBatch.Type;
