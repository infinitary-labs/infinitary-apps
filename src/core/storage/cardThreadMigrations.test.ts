import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { ALL_VERSIONS, appliedVersions, tmpUserData } from "../../../tests/helpers/migrations";
import { seedTask } from "../tasks/seedTask";
import { INTERIM_ANSWERS_VERSION, openDatabase } from "./db";

// INF-2730's repair: a card an older build left waiting for good, because an
// author's interim line kept the captain message it named as its answer and
// the real answer after it was saved as a comment.

describe("clearing the answers interim lines kept", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears only an interim line's answer, so the stuck card's next answer ends its wait", () => {
    const dir = tmpUserData();
    const older = openDatabase(dir, INTERIM_ANSWERS_VERSION - 1);
    // Today's card service names INF-2796's later `after_merge_json` and
    // INF-3071's `ended_json` columns, lent to the older schema here; their
    // own migrations leave them in place.
    older.exec("ALTER TABLE cards ADD COLUMN after_merge_json TEXT");
    older.exec("ALTER TABLE cards ADD COLUMN ended_json TEXT");
    const before = setup(older);
    seedTask(before.tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    const cards = before.make();
    const id = cards.emitCrewmateCard(
      "t1",
      { title: "The plan", body: "<p>The plan.</p>", actions: [] },
      "Fix the meter",
      "model",
    );
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    const first = cards.addMessage(id, "captain", "Which units?");
    const answer = cards.replyFromCrewmate("t1", {
      cardId: id,
      text: "Watts.",
      answersMessage: first.id,
    });
    expect(answer).toContain(`It answers the captain's message ${first.id}.`);
    const asked = cards.addMessage(id, "captain", "Plan the architecture first.");
    cards.replyFromCrewmate("t1", {
      cardId: id,
      text: "Reading every place the line is written.",
      interim: true,
      answersMessage: asked.id,
    });
    const interim = before.cardStore.messages(id).at(-1);
    // The older writer kept the message the interim line named as its answer.
    older
      .prepare("UPDATE card_messages SET answers_message = ? WHERE id = ?")
      .run(asked.id, interim?.id);
    const comment = cards.replyFromCrewmate("t1", {
      cardId: id,
      text: "The plan is on the card.",
      answersMessage: asked.id,
    });
    expect(comment).not.toContain("It answers");
    expect(cards.threadAwaitingAuthor("t1")).toBe(true);
    cards.dispose();
    older.close();

    const upgraded = openDatabase(dir);
    try {
      expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
      const after = setup(upgraded);
      expect(
        after.cardStore.messages(id).map((line) => [line.who, line.text, line.answersMessage]),
      ).toEqual([
        ["captain", "Which units?", undefined],
        ["crewmate", "Watts.", first.id],
        ["captain", "Plan the architecture first.", undefined],
        ["crewmate", "Reading every place the line is written.", undefined],
        // A comment stays a comment: the repair never makes it the answer.
        ["crewmate", "The plan is on the card.", undefined],
      ]);
      const restarted = after.make();
      expect(restarted.threadAwaitingAuthor("t1")).toBe(true);
      expect(
        restarted.replyFromCrewmate("t1", {
          cardId: id,
          text: "The plan is on the card, once more.",
          answersMessage: asked.id,
        }),
      ).toContain(`It answers the captain's message ${asked.id}.`);
      expect(restarted.threadAwaitingAuthor("t1")).toBe(false);
      restarted.dispose();
    } finally {
      upgraded.close();
    }
  });
});
