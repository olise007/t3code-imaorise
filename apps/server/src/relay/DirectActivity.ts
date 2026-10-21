import type { DirectActivityBatch, DirectActivityEvent } from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { shouldPublishAgentAwarenessEvent } from "./AgentAwarenessRelay.ts";
import { DirectActivityJournal } from "./DirectActivityJournal.ts";

export class DirectActivity extends Context.Service<
  DirectActivity,
  {
    readonly read: (cursor: string | null) => Effect.Effect<DirectActivityBatch>;
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
        const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity));
        const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        );
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
        const initial = journal.read(cursor);
        if (initial.reset || initial.events.length > 0) return initial;
        yield* Deferred.await(waiting).pipe(Effect.timeoutOption("25 seconds"));
        return journal.read(cursor);
      }),
  });
});
export const layer = Layer.effect(DirectActivity, make);
