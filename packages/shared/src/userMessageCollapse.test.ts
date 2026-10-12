import { describe, expect, it } from "vitest";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "./assistantCitations";
import { buildPlanImplementationPrompt } from "./proposedPlan";
import { shouldCollapseUserMessage, toggleExpandedUserMessage } from "./userMessageCollapse";

describe("user message collapse", () => {
  it("keeps short messages and boundary values open", () => {
    expect(shouldCollapseUserMessage(" \n ")).toBe(false);
    expect(shouldCollapseUserMessage("x".repeat(600))).toBe(false);
    expect(shouldCollapseUserMessage("x".repeat(601))).toBe(true);
    expect(shouldCollapseUserMessage(Array(8).fill("line").join("\n"))).toBe(false);
    expect(shouldCollapseUserMessage(Array(9).fill("line").join("\n"))).toBe(true);
  });

  it("collapses an approved plan without modifying its submission text", () => {
    const plan = "## Implementation\n\n" + "Preserve the complete plan. ".repeat(40);
    const submission = buildPlanImplementationPrompt(plan);
    expect(shouldCollapseUserMessage(submission)).toBe(true);
    expect(submission).toBe(`PLEASE IMPLEMENT THIS PLAN:\n${plan.trim()}`);
  });

  it("counts file links and context chips by their visible labels", () => {
    const text =
      Array.from(
        { length: 8 },
        (_, i) => `[file${i}.ts](/workspace/${"directory/".repeat(20)}file${i}.ts)`,
      ).join(", ") + ` [terminal](t3-context://v1/terminal/${"a".repeat(36)})`;
    expect(text.length).toBeGreaterThan(600);
    expect(shouldCollapseUserMessage(text)).toBe(false);
  });

  it("counts encoded quotations by the citation label", () => {
    const quote = "A long quoted paragraph. ".repeat(60);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      text: quote,
      comment: "Explain this",
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });
    expect(shouldCollapseUserMessage(`${citation} Explain this.`)).toBe(false);
    expect(shouldCollapseUserMessage(`${citation} ${"More text. ".repeat(70)}`)).toBe(true);
  });

  it("keeps independent disclosure state across recycled rows and threads", () => {
    const initial = new Set<string>();
    const first = toggleExpandedUserMessage(initial, "env:thread:first");
    const second = toggleExpandedUserMessage(first, "env:thread:second");
    const otherThread = toggleExpandedUserMessage(second, "env:other:first");
    const collapsed = toggleExpandedUserMessage(otherThread, "env:thread:first");
    expect(initial.size).toBe(0);
    expect(first.has("env:thread:first")).toBe(true);
    expect(collapsed.has("env:thread:first")).toBe(false);
    expect(collapsed.has("env:thread:second")).toBe(true);
    expect(collapsed.has("env:other:first")).toBe(true);
  });
});
