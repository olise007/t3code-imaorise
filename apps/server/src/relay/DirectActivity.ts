import * as NodeBuffer from "node:buffer";
import type {
  DirectActivityBatch,
  DirectActivityEvent,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { shouldPublishAgentAwarenessEvent } from "./AgentAwarenessRelay.ts";
import { DirectActivityJournal } from "./DirectActivityJournal.ts";

const SnapshotPosition = Schema.fromJsonString(
  Schema.Struct({
    baseline: Schema.String.check(Schema.isPattern(/^[\w-]+:\d+$/)),
    after: Schema.String.check(Schema.isMaxLength(256)),
  }),
);
const encodePosition = Schema.encodeSync(SnapshotPosition);
const decodePosition = Schema.decodeUnknownOption(SnapshotPosition);

function snapshotCursor(cursor: string | null): { baseline: string; after: string } | null {
  if (!cursor || !/^s-[\w-]+:0$/.test(cursor)) return null;
  return Option.getOrNull(
    decodePosition(NodeBuffer.Buffer.from(cursor.slice(2, -2), "base64url").toString("utf8")),
  );
}

export class DirectActivityUnavailable extends Data.TaggedError("DirectActivityUnavailable") {}

export class DirectActivity extends Context.Service<
  DirectActivity,
  {
    readonly read: (
      cursor: string | null,
    ) => Effect.Effect<DirectActivityBatch, DirectActivityUnavailable>;
  }
>()("t3/relay/DirectActivity") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const crypto = yield* Crypto.Crypto;
  const epoch = yield* crypto.randomUUIDv4;
  const startedAt = yield* Clock.currentTimeMillis;
  const journal = new DirectActivityJournal(environmentId, epoch);
  let wake = yield* Deferred.make<void>();
  const identities = new Map<string, string>();

  const entryFor = (thread: OrchestrationV2ThreadShell, project: { readonly title: string }) =>
    Effect.gen(function* () {
      const state = projectThreadAwarenessV2({ environmentId, thread, project });
      if (
        !state ||
        !(
          state.phase === "waiting_for_approval" ||
          state.phase === "waiting_for_input" ||
          state.phase === "completed" ||
          state.phase === "failed"
        )
      )
        return null;
      const phase = state.phase;
      const runId = thread.activeRunId ?? thread.latestRunId;
      const identity = `${runId}:${phase}:${thread.pendingRuntimeRequest?.id ?? ""}`;
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity));
      const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const entry: DirectActivityEvent = {
        id: `${environmentId}:${thread.id}:${fingerprint}`,
        environmentId,
        threadId: thread.id,
        runId,
        phase,
        title: state.threadTitle.slice(0, 120),
        headline: state.headline.slice(0, 120),
        path: state.deepLink,
      };
      return entry;
    });

  const resynchronize = (baseline: string, after = "") =>
    Effect.gen(function* () {
      const projectShells = yield* projects.listShells();
      const candidates: Array<{
        thread: OrchestrationV2ThreadShell;
        project: { readonly title: string };
      }> = [];
      for (const project of projectShells) {
        const shells = yield* threads.listProjectThreads({
          projectId: project.id,
          includeSubagents: false,
        });
        for (const thread of shells) {
          if (
            thread.id <= after ||
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            thread.pendingRuntimeRequest === null
          )
            continue;
          const phase = projectThreadAwarenessV2({ environmentId, thread, project })?.phase;
          if (phase === "waiting_for_approval" || phase === "waiting_for_input")
            candidates.push({ thread, project });
        }
        candidates.sort((a, b) =>
          a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0,
        );
        candidates.length = Math.min(candidates.length, 101);
      }
      const page = candidates.slice(0, 100);
      const entries = yield* Effect.forEach(page, ({ thread, project }) =>
        entryFor(thread, project),
      );
      const more = candidates.length > 100;
      // Snapshot pagination is stateless and never mutates another listener's live replay window.
      const cursor = more
        ? `s-${NodeBuffer.Buffer.from(encodePosition({ baseline, after: page.at(-1)!.thread.id })).toString("base64url")}:0`
        : baseline;
      return {
        environmentId,
        cursor,
        reset: true,
        more,
        events: entries.filter((entry) => entry !== null),
      };
    }).pipe(Effect.catchCause(() => Effect.fail(new DirectActivityUnavailable())));

  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (!shouldPublishAgentAwarenessEvent(event)) return;
        const thread = yield* threads.getThreadShell(event.threadId);
        if (!thread || thread.archivedAt !== null) {
          identities.delete(event.threadId);
          return;
        }
        const project = yield* projects.getById(thread.projectId);
        if (Option.isNone(project)) return;
        const state = projectThreadAwarenessV2({ environmentId, thread, project: project.value });
        const runId = thread.activeRunId ?? thread.latestRunId;
        const phase = state?.phase;
        const identity = `${runId}:${phase}:${thread.pendingRuntimeRequest?.id ?? ""}`;
        if (identities.get(thread.id) === identity) return;
        identities.delete(thread.id);
        identities.set(thread.id, identity);
        if (identities.size > 10000) identities.delete(identities.keys().next().value!);
        if (
          !state ||
          !(
            phase === "waiting_for_approval" ||
            phase === "waiting_for_input" ||
            phase === "completed" ||
            phase === "failed"
          )
        )
          return;
        if (
          (phase === "completed" || phase === "failed") &&
          (!thread.latestRunCompletedAt ||
            DateTime.toEpochMillis(thread.latestRunCompletedAt) < startedAt)
        )
          return;
        const entry = yield* entryFor(thread, project.value);
        if (!entry) return;
        journal.append(entry);
        const previous = wake;
        wake = yield* Deferred.make<void>();
        yield* Deferred.succeed(previous, undefined);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Direct activity projection failed", { cause }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  return DirectActivity.of({
    read: (cursor) =>
      Effect.gen(function* () {
        const waiting = wake;
        const snapshot = snapshotCursor(cursor);
        if (snapshot && !journal.read(snapshot.baseline).reset)
          return yield* resynchronize(snapshot.baseline, snapshot.after);
        const initial = journal.read(cursor);
        if (initial.reset) return yield* resynchronize(initial.cursor);
        if (initial.events.length > 0) return initial;
        yield* Deferred.await(waiting).pipe(Effect.timeoutOption("25 seconds"));
        const result = journal.read(cursor);
        return result.reset ? yield* resynchronize(result.cursor) : result;
      }),
  });
});
export const layer = Layer.effect(DirectActivity, make);
