import { RuntimeRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

function renderPanel(pendingUserInput: PendingUserInput = prompt) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("reviews every answer with edit controls, attachments and masked secrets", () => {
    const batch = {
      ...prompt,
      questions: [
        prompt.questions[0]!,
        { ...prompt.questions[0]!, id: "secret", options: [], isSecret: true },
        { ...prompt.questions[0]!, id: "missing", options: [] },
      ],
    };
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[batch]}
        respondingRequestIds={[]}
        answers={{
          "question-1": { selectedOptionValues: ["Incremental"], attachmentNames: ["design.md"] },
          secret: { customAnswer: "private-answer" },
        }}
        questionIndex={3}
        onSelectQuestion={() => {}}
        onToggleOption={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(markup).toContain("Review answers");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("design.md");
    expect(markup).toContain("Hidden answer");
    expect(markup).not.toContain("private-answer");
    expect(markup).toContain("Required answer missing");
    expect(markup.match(/Edit answer/g)).toHaveLength(3);
  });
  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("offers dismiss only for async questions", () => {
    expect(renderPanel()).toContain("data-pending-user-input-dismiss");
    expect(renderPanel({ ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });
});
