import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DirectActivity from "./DirectActivity.ts";

const threadId = ThreadId.make("thread");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("provider");
function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: threadId,
    projectId,
    title: "Task",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: RunId.make("run"),
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: DateTime.makeUnsafe(10),
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(10),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}
const fixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const shells = yield* Queue.unbounded<OrchestrationV2ThreadShell>();
  const threads = {
    getThreadShell: () => Queue.take(shells),
    streamDomainEvents: Stream.fromQueue(events),
  } satisfies Pick<
    ThreadManagement.ThreadManagementService["Service"],
    "getThreadShell" | "streamDomainEvents"
  >;
  const projects = {
    getById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "Project",
          workspaceRoot: "/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
        }),
      ),
  } satisfies Pick<ProjectService.ProjectService["Service"], "getById">;
  const service = yield* DirectActivity.make.pipe(
    Effect.provideService(
      ThreadManagement.ThreadManagementService,
      threads as ThreadManagement.ThreadManagementService["Service"],
    ),
    Effect.provideService(
      ProjectService.ProjectService,
      projects as ProjectService.ProjectService["Service"],
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      getDescriptor: Effect.die("unused"),
    }),
    Effect.provide(NodeCrypto.layer),
  );
  let sequence = 0;
  return {
    service,
    emit: (state: OrchestrationV2ThreadShell) =>
      Queue.offer(shells, state).pipe(
        Effect.andThen(
          Queue.offer(events, {
            id: EventId.make(`event-${++sequence}`),
            threadId,
            type: "run.updated",
            payload: {},
          } as OrchestrationV2DomainEvent),
        ),
      ),
  };
});

it.effect(
  "projects attention and completion independently of cloud publishing and coalesces duplicate states",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const baseline = yield* test.service.read(null);
        const pending = yield* test.service.read(baseline.cursor).pipe(Effect.forkScoped);
        yield* test.emit(
          shell({
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("approval"),
              kind: "command",
              createdAt: DateTime.makeUnsafe(0),
            },
          }),
        );
        const attention = yield* Fiber.join(pending);
        assert.equal(attention.events[0]?.phase, "waiting_for_approval");
        const next = yield* test.service.read(attention.cursor).pipe(Effect.forkScoped);
        yield* test.emit(
          shell({
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("approval"),
              kind: "command",
              createdAt: DateTime.makeUnsafe(0),
            },
          }),
        );
        yield* test.emit(shell({ status: "completed" }));
        const complete = yield* Fiber.join(next);
        assert.equal(complete.events.length, 1);
        assert.equal(complete.events[0]?.phase, "completed");
        assert.equal(complete.events[0]?.runId, "run");
      }),
    ),
);
