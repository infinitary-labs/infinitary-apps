import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { TaskService } from "../tasks/taskService";
import { AskEnding } from "./askEnding";
import { IN_TURN, readOpenWork } from "./openWork";

/** open_work's typed host over a real ask graph and an empty card stack. */
function hostOf(tasks: TaskService) {
  const ending = new AskEnding({
    tasks,
    openCards: () => [],
    storedCard: () => undefined,
    shownAt: () => 0,
    seenCards: () => [],
  });
  return {
    tasks,
    ending,
    openCards: () => [],
    storedCard: () => undefined,
    pastCard: () => undefined,
    owed: () => "none" as const,
    thread: () => ({ cardId: "unused", messages: [] }),
  };
}

function body(text: string): Record<string, unknown> {
  return JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>;
}

describe("open_work ask reads", () => {
  // A message still in its own turn must not look nameable: emit_card with
  // that ask_id is refused (INF-2664), and a misleading "no answer yet"
  // state sent the first mate into a retry loop.
  it("reports an unread message as in a turn, not as needing an answer yet", () => {
    const tasks = new TaskService({ db: freshDatabase(), strict: true });
    tasks.capture.openAsk({ id: "parked", text: "can the disk stay on the Mac?" });
    const read = readOpenWork(hostOf(tasks), { ask: "parked" });
    expect(body(read.text)).toMatchObject({
      ask_id: "parked",
      state: IN_TURN,
      words: "can the disk stay on the Mac?",
    });
    expect(body(read.text).state).not.toBe("no answer yet");
  });

  it("still reports no answer yet once a finished reply has closed the turn", () => {
    const tasks = new TaskService({ db: freshDatabase(), strict: true });
    tasks.capture.openAsk({ id: "read", text: "can the disk stay on the Mac?" });
    tasks.capture.closeAsk("read", "closed");
    expect(body(readOpenWork(hostOf(tasks), { ask: "read" }).text)).toMatchObject({
      ask_id: "read",
      state: "no answer yet",
    });
  });
});
