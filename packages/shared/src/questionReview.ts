/** The review step is local; providers receive only the final answer map. */
export function questionReviewStep(count: number, index: number) {
  const bounded = Math.max(0, Math.min(index, count > 1 ? count : Math.max(0, count - 1)));
  return {
    index: bounded,
    reviewing: count > 1 && bounded === count,
    previous: Math.max(0, bounded - 1),
    next: Math.min(count, bounded + 1),
  };
}

export function questionAnswerSummary(
  answer: string | readonly string[] | undefined,
  secret = false,
): string {
  if (answer === undefined) return "Not answered";
  if (secret) return "Hidden answer";
  return Array.isArray(answer) ? answer.join(", ") : String(answer);
}
