import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, RunId, type DirectActivityEvent } from "@t3tools/contracts";
import { DirectActivityJournal } from "./DirectActivityJournal.ts";

const environmentId = EnvironmentId.make("environment");
const event = (id: string): DirectActivityEvent => ({
  id,
  environmentId,
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
  phase: "completed",
  title: "Task",
  headline: "Done",
  path: "/threads/environment/thread",
});
describe("direct activity replay", () => {
  it("baselines new listeners and restarted environments without replaying completions", () => {
    const journal = new DirectActivityJournal(environmentId, "epoch");
    journal.append(event("past"));
    expect(journal.read(null)).toMatchObject({ cursor: "epoch:1", reset: true, events: [] });
    journal.append(event("new"));
    expect(journal.read("epoch:1")).toMatchObject({ reset: false, events: [event("new")] });
    expect(journal.read("old:0")).toMatchObject({ reset: true, events: [] });
    expect(journal.read("epoch:9999")).toMatchObject({ reset: true, events: [] });
  });
  it("bounds replay pages and resets expired cursors", () => {
    const journal = new DirectActivityJournal(environmentId, "epoch");
    for (let i = 1; i <= 1001; i++) journal.append(event(String(i)));
    expect(journal.read("epoch:0")).toMatchObject({ reset: true, events: [] });
    const page = journal.read("epoch:1");
    expect(page.events).toHaveLength(100);
    expect(page).toMatchObject({ cursor: "epoch:101", more: true, reset: false });
    expect(journal.read("epoch:1001")).toMatchObject({ more: false, reset: false, events: [] });
  });
});
