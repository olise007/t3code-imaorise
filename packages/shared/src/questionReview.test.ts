import { describe, expect, it } from "vite-plus/test";
import { questionAnswerSummary, questionReviewStep } from "./questionReview";
describe("question review progression", () => {
  it("reaches review after the last question and returns to it after editing", () => {
    let index = 0;
    index = questionReviewStep(3, index).next;
    index = questionReviewStep(3, index).next;
    expect(questionReviewStep(3, index).reviewing).toBe(false);
    index = questionReviewStep(3, index).next;
    expect(questionReviewStep(3, index).reviewing).toBe(true);
    expect(questionReviewStep(3, index).previous).toBe(2);
  });
  it("never requires a review step for single questions", () => {
    expect(questionReviewStep(1, 1).reviewing).toBe(false);
    expect(questionReviewStep(1, 1).index).toBe(0);
  });
  it("does not reveal secret values in summaries", () => {
    expect(questionAnswerSummary("supersecret", true)).toBe("Hidden answer");
    expect(questionAnswerSummary(["one", "two"])).toBe("one, two");
    expect(questionAnswerSummary(undefined)).toBe("Not answered");
    expect(questionAnswerSummary(undefined, true, true)).toBe("Required answer missing");
  });
});
