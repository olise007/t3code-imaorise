import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  /** App requesting access for mcp-elicitation approvals (#8058). */
  readonly appName?: string;
  /** Approval choices advertised by the provider (#8058); defaults apply when absent. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

/** Seed each question once. Existing edits, cleared answers, and option selections win. */
export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  let seeded: Record<string, Draft | { customAnswer: string }> = drafts;
  for (const question of questions) {
    if (
      question.initialAnswer === undefined ||
      question.allowCustomAnswer === false ||
      seeded[question.id] !== undefined
    )
      continue;
    if (seeded === drafts) seeded = { ...drafts };
    seeded[question.id] = { customAnswer: question.initialAnswer };
  }
  return seeded;
}

// Older Codex adapters recreated async requests for the same question node when
// the turn completed. Keep the original answer available to every client.
function answeredAsyncRequestsByNode(requests: readonly OrchestrationV2RuntimeRequest[]) {
  return new Map(
    requests
      .filter(
        (request) =>
          request.kind === "user_input" &&
          request.status === "resolved" &&
          request.responseCapability.type === "message" &&
          request.answers !== undefined,
      )
      .map((request) => [request.nodeId, request]),
  );
}

/** Joins pending request entities to the request items that carry display data. */
export function derivePendingThreadRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];
  const answeredAsync = answeredAsyncRequestsByNode(projection.runtimeRequests);

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const answered = answeredAsync.get(request.nodeId);
      if (
        responseCapability === "message" &&
        answered &&
        answered.providerTurnId === request.providerTurnId
      )
        continue;
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
    });
  }

  return { approvals, userInputs };
}

/** Restores answers from older requests whose timeline items were not kept in sync. */
export function createQuestionHistoryProjector() {
  type Rows = OrchestrationV2ThreadProjection["visibleTurnItems"];
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  const cache = new WeakMap<Rows[number], { request: Requests[number]; row: Rows[number] }>();
  return (
    projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runtimeRequests">,
  ): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    if (rows === previousRows && requests === previousRequests && previousResult)
      return previousResult;
    const byId = new Map(requests.map((request) => [request.id, request]));
    const answeredAsync = answeredAsyncRequestsByNode(requests);
    let result: Rows[number][] | undefined;
    for (const [index, row] of rows.entries()) {
      const item = row.item;
      let request =
        item.type === "user_input_request" && !item.questionAnswer
          ? byId.get(item.requestId)
          : undefined;
      if (
        item.type === "user_input_request" &&
        !item.questionAnswer &&
        item.responseMode === "message" &&
        item.nodeId !== null &&
        request?.answers === undefined
      ) {
        const answered = answeredAsync.get(item.nodeId);
        if (answered?.providerTurnId === item.providerTurnId) request = answered;
      }
      let next = row;
      if (
        item.type === "user_input_request" &&
        request?.status === "resolved" &&
        request.answers !== undefined
      ) {
        const cached = cache.get(row);
        next =
          cached?.request === request
            ? cached.row
            : {
                ...row,
                item: {
                  ...item,
                  status: "completed",
                  questionAnswer: {
                    requestId: request.id,
                    answers: request.answers,
                    attachmentsByQuestionId: {},
                    questionTextById: Object.fromEntries(
                      item.questions.map((question) => [question.id, question.question]),
                    ),
                  },
                },
              };
        cache.set(row, { request, row: next });
      }
      if (next !== row) result ??= rows.slice(0, index);
      result?.push(next);
    }
    previousRows = rows;
    previousRequests = requests;
    previousResult = result ?? rows;
    return previousResult;
  };
}
