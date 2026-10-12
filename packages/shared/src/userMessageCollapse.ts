import { assistantCitationLabel, collectAssistantCitations } from "./assistantCitations.ts";

const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

/** Match the visible message body, rather than encoded citation or link targets. */
export function shouldCollapseUserMessage(text: string): boolean {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  visible += linkLabels(text.slice(cursor));
  return visible.trim().length > 0 && (visible.length > 600 || visible.split("\n").length > 8);
}

/** Keep disclosure state outside recycled rows, scoped to their environment and thread. */
export function toggleExpandedUserMessage(expanded: ReadonlySet<string>, messageId: string) {
  const next = new Set(expanded);
  if (next.has(messageId)) next.delete(messageId);
  else next.add(messageId);
  return next;
}
