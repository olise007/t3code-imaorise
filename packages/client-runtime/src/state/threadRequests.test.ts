import {
  NodeId,
  ProviderTurnId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");

describe("initial user input drafts", () => {
  const questions = [
    { id: "editor", initialAnswer: "  Proposed commit\n\n" },
    { id: "empty", initialAnswer: "" },
    { id: "ordinary" },
    { id: "choices", initialAnswer: "Ignore this", allowCustomAnswer: false },
  ];

  it("seeds editable answers and preserves edits and selections on later snapshots", () => {
    const seeded = seedUserInputDraftAnswers(questions, {});
    expect(seeded).toEqual({
      editor: { customAnswer: "  Proposed commit\n\n" },
      empty: { customAnswer: "" },
    });
    const edits = {
      ...seeded,
      editor: { customAnswer: "" },
      empty: { selectedOptionValues: ["empty"], customAnswer: "" },
    };
    expect(seedUserInputDraftAnswers(questions, edits)).toEqual(edits);
    expect(
      seedUserInputDraftAnswers(questions, { editor: { customAnswer: "Edited commit" } }).editor,
    ).toEqual({ customAnswer: "Edited commit" });
    expect(seedUserInputDraftAnswers(questions, {}).editor).toEqual({
      customAnswer: "  Proposed commit\n\n",
    });
  });
});

it.each(["pending", "resolved"] as const)(
  "restores answers when a duplicate async request is %s",
  (status) => {
    const original = projection.runtimeRequests[0]!;
    const answered = {
      ...original,
      status: "resolved" as const,
      answers: { next: "My typed response" },
    };
    const duplicate = { ...original, id: RuntimeRequestId.make("duplicate"), status };
    const originalItem = projection.turnItems[0]!;
    if (originalItem.type !== "user_input_request") throw new Error("Missing question fixture");
    const item = { ...originalItem, requestId: duplicate.id, status: "cancelled" as const };
    const row = {
      item,
      position: 0,
      sourceItemId: item.id,
      sourceThreadId: item.threadId,
      visibility: "local" as const,
    };
    const restored = {
      ...projection,
      runtimeRequests: [answered, duplicate],
      turnItems: [item],
      visibleTurnItems: [row],
    };
    expect(derivePendingThreadRequests(restored).userInputs).toEqual([]);
    const history = createQuestionHistoryProjector()(restored);
    expect(history[0]?.item).toMatchObject({
      status: "completed",
      questionAnswer: {
        requestId: original.id,
        answers: { next: "My typed response" },
        questionTextById: { next: "What should happen next?" },
      },
    });
    expect(item.status).toBe("cancelled");

    // A different turn or node must remain independently answerable.
    const differentTurn = {
      ...duplicate,
      status: "pending" as const,
      providerTurnId: ProviderTurnId.make("different-turn"),
    };
    expect(
      derivePendingThreadRequests({ ...restored, runtimeRequests: [answered, differentTurn] })
        .userInputs,
    ).toHaveLength(1);
    const differentNode = {
      ...duplicate,
      status: "pending" as const,
      nodeId: NodeId.make("different-node"),
    };
    expect(
      derivePendingThreadRequests({ ...restored, runtimeRequests: [answered, differentNode] })
        .userInputs,
    ).toHaveLength(1);
  },
);
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });

  it("removes answered requests from the composer while retaining their answers in projection data", () => {
    const answered = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
        resolvedAt: v2Now,
        answers: { next: "  continue  " },
      })),
    };
    expect(derivePendingThreadRequests(answered).userInputs).toEqual([]);
    expect(answered.runtimeRequests[0]?.answers).toEqual({ next: "  continue  " });
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});
