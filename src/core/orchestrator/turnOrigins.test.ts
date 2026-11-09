import { describe, expect, it } from "vitest";
import type { InboxRow } from "../storage/inboxStore";
import { turnOriginOf } from "./turnOrigins";
import type { WakeFacts } from "./wakes";

/**
 * INF-2326: a task filed from the captain's click keeps the button's words
 * and what they wrote with it, never a script's click; the choice that
 * closed an answer task names that card.
 */
const row = (facts: WakeFacts) => ({ id: 1, facts }) as unknown as InboxRow;
const keyOf = () => undefined;

describe("the origin a served wake offers", () => {
  it("keeps the captain's click with the words they wrote, and never a script's", () => {
    const click = {
      kind: "card-choice",
      to: "firstmate",
      source: "chrome",
      card: { id: "card-plan", title: "Plan for clearer cards" },
      choice: {
        id: "file",
        label: "File the picked improvements",
        answers: [
          {
            name: "anything_else",
            values: [],
            changed: true,
            written: "start them later, not now",
          },
        ],
      },
    } as WakeFacts;
    expect(turnOriginOf(row(click), keyOf)).toEqual({
      origin: {
        kind: "chose",
        cardId: "card-plan",
        card: "Plan for clearer cards",
        choice: "File the picked improvements",
        written: "start them later, not now",
      },
      refs: ["card-plan"],
    });
    expect(turnOriginOf(row({ ...click, source: "frame" } as WakeFacts), keyOf)).toBeUndefined();
  });

  it("names the card whose choice closed an answer task", () => {
    const closed = {
      kind: "answer-closed",
      handoff: {
        version: 1,
        event: "answer_task_closed",
        task: { id: "t1", key: "INF-2326", title: "Plan clearer card origins" },
        card: { id: "card-10aa", title: "Plan for clearer card origins and card words" },
        choice: { id: "approve", label: "Approve and build", effect: null },
        close: { status: "done", reason: "answered", actor: "captain" },
      },
    } as WakeFacts;
    expect(turnOriginOf(row(closed), keyOf)?.origin).toEqual({
      kind: "chose",
      cardId: "card-10aa",
      card: "Plan for clearer card origins and card words",
      choice: "Approve and build",
    });
  });

  // INF-3202: a report that names where the captain typed the words it
  // passes on offers them, with when he typed them; one that names none
  // offers its task alone, as before.
  it("offers a report's task, with the captain's words it passed on when it named them", () => {
    const report = {
      kind: "report",
      task: { id: "t-3106", title: "Plan the keyboard trap fix" },
      crewmate: "crewmate",
      excerpt: "Passed on the captain's request about the stale picture.",
      filed: [],
      cards: [],
    } as unknown as WakeFacts;
    const keyed = (id: string) => (id === "t-3106" ? "INF-3106" : undefined);
    expect(turnOriginOf(row(report), keyed)).toEqual({
      origin: { kind: "report", taskId: "t-3106" },
      refs: ["t-3106", "INF-3106"],
    });
    const words = { text: "fix this stale picture problem", at: 1_794_189_223_422 };
    expect(
      turnOriginOf(row({ ...report, captainWords: words } as WakeFacts), keyed)?.origin,
    ).toEqual({ kind: "report", taskId: "t-3106", words });
  });
});
