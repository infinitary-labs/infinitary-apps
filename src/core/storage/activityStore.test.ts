import { feedLineFrom } from "@shared/feed";
import { describe, expect, it } from "vitest";
import { ActivityStore } from "./activityStore";
import { openInMemoryDatabase } from "./db";

/**
 * A line's English as Activity saved it, without the fact it keeps beside
 * it (docs/i18n.md, "Saved facts"; INF-3674's piece 3): the fact is
 * `src/shared/i18n/said.test.ts`'s, the words are this test's.
 */
const english = (line: ReturnType<typeof feedLineFrom>) => {
  if (!line) return line;
  const { said: _said, ...words } = line;
  return words;
};

describe("ActivityStore (P10: the feed survives)", () => {
  it("caps retention and the read limit independently", () => {
    const store = new ActivityStore(openInMemoryDatabase());
    for (let i = 0; i < 260; i += 1) {
      store.record({ kind: "info", text: `line ${i}` });
    }
    const recent = store.recent();
    expect(recent).toHaveLength(20);
    expect(recent.at(-1)?.text).toBe("line 259");
    expect(store.recent(500)).toHaveLength(200);
    expect(store.recent(500)[0]?.text).toBe("line 60");
  });

  // INF-3674's piece 3: a line's fact survives a restart beside its English,
  // so a line written before a language change follows it.
  it("keeps a line's fact beside its words, and leaves out a fact it cannot read", () => {
    const db = openInMemoryDatabase();
    const store = new ActivityStore(db, () => 1_000);
    const said = { m: "settleMergingChange", a: { change: "PR #61" } };
    store.record({ kind: "info", text: "Merging PR #61", said });
    const unread = store.record({ kind: "info", text: "Old words" });
    db.prepare("UPDATE activity_events SET said_json = ? WHERE id = ?").run('{"m":1}', unread);
    expect(new ActivityStore(db, () => 1_000).recent()).toEqual([
      { kind: "info", text: "Merging PR #61", said, at: 1_000 },
      { kind: "info", text: "Old words", at: 1_000 },
    ]);
  });

  it("rewrites a line in its place and withdraws it, as a settled run does", () => {
    let now = 1_000;
    const store = new ActivityStore(openInMemoryDatabase(), () => now);
    store.record({ kind: "info", text: "Captain · window wash 48% → 50%" });
    const run = store.record({ kind: "info", text: "Captain · activity collapsed" });
    now = 2_000;
    store.rewrite(run, { kind: "info", text: "Captain · activity expanded" });
    expect(store.recent()).toEqual([
      { kind: "info", text: "Captain · window wash 48% → 50%", at: 1_000 },
      { kind: "info", text: "Captain · activity expanded", at: 2_000 },
    ]);
    store.withdraw(run);
    expect(store.recent().map((line) => line.text)).toEqual(["Captain · window wash 48% → 50%"]);
  });

  it("clears with the retention purge (D-13)", () => {
    const store = new ActivityStore(openInMemoryDatabase());
    store.record({ kind: "ok", text: "work landed" });
    store.clear();
    expect(store.recent()).toEqual([]);
  });
});

describe("feedLineFrom (the one shared mapping)", () => {
  it("maps the task-less events to the same lines the renderer shows", () => {
    expect(english(feedLineFrom({ type: "firstmate_note", text: "queued - starts at 9" }))).toEqual(
      {
        kind: "info",
        text: "queued - starts at 9",
      },
    );
    expect(
      english(
        feedLineFrom({ type: "memory_noted", text: "Always squash-merge when landing work." }),
      ),
    ).toEqual({
      kind: "info",
      text: "First mate · remembered: Always squash-merge when landing work.",
    });
    expect(english(feedLineFrom({ type: "user_turn", text: "hello" }))).toEqual({
      kind: "you",
      text: "Captain: hello",
    });
    expect(english(feedLineFrom({ type: "user_turn", text: "" }))).toEqual({
      kind: "you",
      text: "Captain: image",
    });
    // The Firstmate's own failed turn has no task record, so it is still
    // authored here and never silent.
    expect(
      english(
        feedLineFrom({ type: "turn_failed", taskId: "firstmate", error: "Connection error." }),
      ),
    ).toEqual({
      kind: "danger",
      text: "First mate · problem: could not reach the provider - try again",
    });
    // A cut-off the seat paused on is not a problem: its pause line speaks.
    expect(
      english(
        feedLineFrom({
          type: "turn_failed",
          taskId: "firstmate",
          error: "Not logged in",
          cutOff: { class: "signed_out" },
          paused: true,
        }),
      ),
    ).toBeNull();
    // One that paused nothing - a spent allowance with no known reset - is
    // an ordinary failure, and says so.
    expect(
      english(
        feedLineFrom({
          type: "turn_failed",
          taskId: "firstmate",
          error: "rate limited",
          cutOff: { class: "no_headroom" },
        }),
      ),
    ).toEqual({
      kind: "danger",
      text: expect.stringMatching(/^First mate · problem: /),
    });
  });

  it("carries a task's own line as the core authored it, keyed to the task (P3)", () => {
    expect(
      english(
        feedLineFrom({
          type: "task_event",
          taskId: "t1",
          key: "SCR-1",
          kind: "dispatched",
          text: "started",
          at: 5,
          feed: true,
        }),
      ),
    ).toEqual({ kind: "info", text: "started", taskKey: "SCR-1" });
    expect(
      english(
        feedLineFrom({
          type: "task_event",
          taskId: "t1",
          key: "SCR-1",
          kind: "landed",
          text: "Fix it · put in",
          at: 5,
          feed: true,
        }),
      ),
    ).toMatchObject({ kind: "ok" });
    expect(
      english(
        feedLineFrom({
          type: "task_event",
          taskId: "t1",
          key: "SCR-1",
          kind: "progress",
          text: "halfway",
          at: 5,
          feed: false,
        }),
      ),
    ).toBeNull();
  });

  it("leaves the task-bound runtime events to the record's timeline (P3)", () => {
    // These still flow (the character, Observe and the strip consume them)
    // but the feed line for each is derived from the task_events row the
    // same moment writes, so it is not authored twice.
    expect(
      english(
        feedLineFrom({
          type: "task_started",
          taskId: "t1",
          title: "Fix it",
          machineId: "local",
          crewmate: "crewmate 1",
        }),
      ),
    ).toBeNull();
    expect(
      english(
        feedLineFrom({
          type: "task_report",
          taskId: "t1",
          title: "Fix it",
          crewmate: "crewmate 1",
        }),
      ),
    ).toBeNull();
    expect(
      english(feedLineFrom({ type: "task_landed", taskId: "t1", title: "Fix it", mode: "merge" })),
    ).toBeNull();
    expect(
      english(
        feedLineFrom({ type: "task_finished", taskId: "t1", status: "completed", title: "Fix it" }),
      ),
    ).toBeNull();
    expect(
      english(
        feedLineFrom({ type: "turn_failed", taskId: "t1", error: "boom", crewmate: "crewmate 2" }),
      ),
    ).toBeNull();
  });

  it("keeps non-feed events out of the feed", () => {
    expect(
      english(feedLineFrom({ type: "assistant_delta", taskId: "t1", text: "..." })),
    ).toBeNull();
    expect(english(feedLineFrom({ type: "firstmate_state", busy: true }))).toBeNull();
  });
});
