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
const fixture = (current: OrchestrationV2ThreadShell[] = []) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const inspections = yield* Queue.unbounded<void>();
    const shells = yield* Queue.unbounded<OrchestrationV2ThreadShell>();
    const threads = {
      getThreadShell: () => Queue.take(shells),
      streamDomainEvents: Stream.fromQueue(events),
      listProjectThreads: () =>
        Queue.offer(inspections, undefined).pipe(Effect.andThen(Effect.succeed(current))),
    } satisfies Pick<
      ThreadManagement.ThreadManagementService["Service"],
      "getThreadShell" | "streamDomainEvents" | "listProjectThreads"
    >;
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
    };
    const projects = {
      listShells: () => Effect.succeed([project]),
      getById: () => Effect.succeed(Option.some(project)),
    } satisfies Pick<ProjectService.ProjectService["Service"], "getById" | "listShells">;
    const service = yield* DirectActivity.make.pipe(
      Effect.provideService(
        ThreadManagement.ThreadManagementService,
        threads as unknown as ThreadManagement.ThreadManagementService["Service"],
      ),
      Effect.provideService(
        ProjectService.ProjectService,
        projects as unknown as ProjectService.ProjectService["Service"],
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
      inspected: Queue.take(inspections),
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
        const test = yield* fixture();
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

it.effect("resynchronizes current approval and input requests without historical completions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture([
        shell({ status: "completed" }),
        shell({
          id: ThreadId.make("approval-thread"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(0),
          },
        }),
        shell({
          id: ThreadId.make("input-thread"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("input"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(0),
          },
        }),
      ]);
      const initial = yield* test.service.read(null);
      assert.isTrue(initial.reset);
      assert.deepEqual(
        initial.events.map((event) => event.phase),
        ["waiting_for_approval", "waiting_for_input"],
      );
      const expired = yield* test.service.read("old-process:0");
      assert.isTrue(expired.reset);
      assert.deepEqual(
        expired.events.map((event) => event.id),
        initial.events.map((event) => event.id),
      );
    }),
  ),
);

it.effect("paginates resynchronized attention within the bounded activity feed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture(
        Array.from({ length: 110 }, (_, index) =>
          shell({
            id: ThreadId.make(`thread-${index}`),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make(`request-${index}`),
              kind: "command",
              createdAt: DateTime.makeUnsafe(0),
            },
          }),
        ),
      );
      const first = yield* test.service.read(null);
      assert.equal(first.events.length, 100);
      assert.isTrue(first.more);
      const next = yield* test.service.read(first.cursor);
      assert.equal(next.events.length, 10);
      assert.isFalse(next.more);
    }),
  ),
);

it.effect(
  "concurrent full-window resynchronizations preserve live events and each reader's pagination",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = Array.from({ length: 1000 }, (_, index) =>
          shell({
            id: ThreadId.make(`pending-${index}`),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make(`request-${index}`),
              kind: "command",
              createdAt: DateTime.makeUnsafe(0),
            },
          }),
        );
        const test = yield* fixture(current);
        const one = yield* test.service.read(null).pipe(Effect.forkScoped);
        const two = yield* test.service.read("old-process:0").pipe(Effect.forkScoped);
        yield* test.inspected;
        yield* test.inspected;
        yield* test.emit(shell({ id: ThreadId.make("live-thread"), status: "completed" }));
        const finish = (first: import("@t3tools/contracts").DirectActivityBatch) =>
          Effect.gen(function* () {
            let page = first;
            const ids = new Set(page.events.map((event) => event.id));
            assert.equal(page.events.length, 100);
            while (page.more) {
              page = yield* test.service.read(page.cursor);
              for (const event of page.events) ids.add(event.id);
            }
            assert.equal(ids.size, 1000);
            const live = yield* test.service.read(page.cursor);
            assert.deepEqual(
              live.events.map((event) => event.threadId),
              [ThreadId.make("live-thread")],
            );
          });
        yield* finish(yield* Fiber.join(one));
        yield* finish(yield* Fiber.join(two));
      }),
    ),
);
