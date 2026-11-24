import type { CardDraft } from "@shared/cardDrafts";
import type { Card } from "@shared/cards";
import { CARD_MAX_ANSWERS } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { describe, expect, it } from "vitest";
import {
  setup as crewSetup,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  tick,
} from "../../../tests/helpers/crewHarness";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { exportTaskRecords } from "../tasks/taskExport";
import { TaskTimeline } from "../tasks/taskTimeline";
import { CardDrafts } from "./cardDrafts";
import { readOpenWork } from "./openWork";
import { sourceFacts } from "./workShape";

fakeCrewTimersEachTest();

// Intent (INF-5446, the captain's ask): "it would be cool if the answers you
// selected on cards showed up on other devices too (like if you don't finish
// the card completely)" - the first mate's computer keeps each open card's
// unsent picks, words and notes, merges two windows' changes by question,
// and forgets them when the card closes.

const card: Card = {
  id: "card-1",
  taskId: "task-1",
  author: "crewmate",
  priority: 30,
  title: "Choose how the export runs",
  meta: "crewmate 1",
  body: "<fieldset><legend>Format</legend></fieldset>",
  actions: [
    { id: "later", label: "Not now", variant: "ghost" },
    { id: "go", label: "Approve and build", variant: "primary" },
  ],
  status: "ready",
  createdAt: 1000,
};

const pick = (name: string, value: string): FrameAnswer => ({
  name,
  values: [value],
  labels: [value],
  changed: true,
});

function setup() {
  const db = openInMemoryDatabase();
  const cards = new CardStore(db);
  cards.upsert(card);
  const pushed: CardDraft[] = [];
  const drafts = new CardDrafts(db, (draft) => pushed.push(draft));
  return { db, cards, drafts, pushed };
}

function draftOf(result: ReturnType<CardDrafts["change"]>): CardDraft {
  if (!("draft" in result)) throw new Error(`refused: ${result.refused}`);
  return result.draft;
}

describe("CardDrafts", () => {
  it("keeps picks, words and notes for an open card and reads them back after a restart", () => {
    const { db, drafts, pushed } = setup();
    const draft = draftOf(
      drafts.change(card.id, {
        since: 0,
        answers: [pick("format", "csv")],
        words: "Keep the header row",
      }),
    );
    expect(draft).toMatchObject({ revision: 1, words: "Keep the header row" });
    expect(pushed).toEqual([draft]);
    expect(new CardDrafts(db, () => {}).read()).toEqual([draft]);
  });

  it("merges two windows' changes by question and keeps the newer value of the same question", () => {
    const { drafts } = setup();
    // Window A picks a format; window B, which heard nothing yet, picks a schedule.
    draftOf(drafts.change(card.id, { since: 0, answers: [pick("format", "csv")] }));
    const merged = draftOf(
      drafts.change(card.id, { since: 0, answers: [pick("when", "nightly")] }),
    );
    expect(merged.answers.map((a) => a.name).sort()).toEqual(["format", "when"]);
    // Window B, still at revision 0, sends a stale format: A's newer pick stays.
    const stale = drafts.change(card.id, { since: 0, answers: [pick("format", "json")] });
    const kept = draftOf(stale);
    expect(kept.answers.find((a) => a.name === "format")?.values).toEqual(["csv"]);
    // The answer says the newer change passed B's format over.
    expect("passed" in stale && stale.passed).toEqual({ answers: ["format"] });
    // Having heard revision 2, B's change of format is taken.
    const taken = draftOf(drafts.change(card.id, { since: 2, answers: [pick("format", "json")] }));
    expect(taken.answers.find((a) => a.name === "format")?.values).toEqual(["json"]);
    expect(taken.revision).toBe(3);
  });

  it("pushes only a change that moved something", () => {
    const { drafts, pushed } = setup();
    draftOf(drafts.change(card.id, { since: 0, words: "Ship it" }));
    draftOf(drafts.change(card.id, { since: 1, words: "Ship it" }));
    expect(pushed).toHaveLength(1);
  });

  it("forgets a card's draft when the card is answered or removed, and refuses a late change", () => {
    const { db, cards, drafts } = setup();
    draftOf(drafts.change(card.id, { since: 0, answers: [pick("format", "csv")] }));
    cards.resolve(card.id, "go");
    expect(drafts.read()).toEqual([]);
    expect(drafts.change(card.id, { since: 1, words: "too late" })).toEqual({ refused: "closed" });
    expect(drafts.read()).toEqual([]);

    cards.upsert({ ...card, id: "card-2" });
    draftOf(drafts.change("card-2", { since: 0, words: "draft" }));
    db.prepare("DELETE FROM cards WHERE id = ?").run("card-2");
    expect(drafts.read()).toEqual([]);
    expect(drafts.change("missing", { since: 0, words: "x" })).toEqual({ refused: "closed" });
  });

  it("keeps a draft only in its own table, where no agent, card record or export reads", async () => {
    const crew = fakeCrewmate();
    const h = crewSetup(crew);
    const { taskId } = await h.supervisor.intake.commission({
      title: card.title,
      intent: intentOf("choose how the export runs"),
    });
    await tick();
    await h.specs[0]?.onCard?.({
      id: "draft-card",
      title: card.title,
      body: card.body,
      actions: [],
    });
    const shown = h.supervisor.cards.snapshot().find((c) => c.taskId === taskId);
    if (!shown) throw new Error("no card");
    const words = "Unsent words about the north basin";
    const canary = (text: string) => text.includes(words) || text.includes("parquet-unsent");
    draftOf(
      new CardDrafts(h.db, () => {}).change(shown.id, {
        since: 0,
        ...(shown.lifecycleId ? { lifecycle: shown.lifecycleId } : {}),
        answers: [pick("format", "parquet-unsent")],
        words,
        notes: [
          { start: 0, key: "p0", kind: "paragraph", excerpt: "Format", comment: words, line: 1 },
        ],
      }),
    );
    const tables = h.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'card_drafts'",
      )
      .all()
      .map((row) => row.name);
    expect(
      tables.filter((name) =>
        canary(JSON.stringify(h.db.prepare(`SELECT * FROM "${name}"`).all())),
      ),
    ).toEqual([]);
    // The reads an agent, the card's evidence and the task export make.
    const task = h.tasks.get(taskId);
    if (!task) throw new Error("no task");
    const host = {
      tasks: h.tasks,
      ending: h.supervisor.askEnding,
      openCards: () => h.supervisor.cards.snapshot(),
      storedCard: (id: string) => h.cardStore.get(id),
      pastCard: (id: string) => h.supervisor.cards.past(id),
      owed: (id: string) => h.supervisor.cards.owed(id),
      thread: (id: string) => h.supervisor.cards.thread(id),
      served: h.supervisor.cards.threads,
    };
    // Each read with what it shows of this card - the card itself, or for
    // the export the card's task - so its silence about the draft means something.
    const reads: [unknown, string][] = [
      [readOpenWork(host, { card: shown.id }).text, shown.id],
      [readOpenWork(host, {}).text, shown.id],
      [h.supervisor.cards.cardRead(shown.id), shown.id],
      [new TaskTimeline({ tasks: h.tasks, cards: h.cardStore }).entries(taskId), shown.id],
      [h.cardStore.listOpen(), shown.id],
      [exportTaskRecords(h.tasks), taskId],
    ];
    expect(reads.map(([read, shows]) => JSON.stringify(read ?? null).includes(shows))).toEqual(
      reads.map(() => true),
    );
    expect(reads.filter(([read]) => canary(JSON.stringify(read ?? null)))).toEqual([]);
    // Once the captain answers the card, its evidence and the answer a
    // later task builds on hold no draft either.
    h.supervisor.cards.resolve(shown, "go", "go");
    // The card's record, and the card's body as the answer a later task builds on.
    const answered: [unknown, string][] = [
      [h.supervisor.cards.past(shown.id), shown.id],
      [
        sourceFacts(
          { tasks: h.tasks, cardStore: h.cardStore, paths: h.paths },
          h.supervisor.cards,
          task,
        ),
        card.body,
      ],
    ];
    expect(answered.map(([read, shows]) => JSON.stringify(read ?? null).includes(shows))).toEqual([
      true,
      true,
    ]);
    expect(answered.filter(([read]) => canary(JSON.stringify(read ?? null)))).toEqual([]);
  });

  it("refuses a change naming no opening once the card holds one, and one naming an opening the card lacks", () => {
    const { cards, drafts } = setup();
    // A card written before openings were kept takes only a change naming none.
    expect(drafts.change(card.id, { since: 0, lifecycle: "opening-1", words: "x" })).toEqual({
      refused: "closed",
    });
    draftOf(drafts.change(card.id, { since: 0, words: "from before" }));
    cards.resolve(card.id, "go");
    cards.reopen(card.id);
    cards.upsert({ ...card, lifecycleId: "opening-1" });
    expect(drafts.change(card.id, { since: 1, words: "late" })).toEqual({ refused: "closed" });
    expect(drafts.read()).toEqual([]);
  });

  it("refuses a change from an earlier opening of a card reopened under its id", () => {
    const { cards, drafts } = setup();
    cards.upsert({ ...card, lifecycleId: "opening-1" });
    draftOf(drafts.change(card.id, { since: 0, lifecycle: "opening-1", words: "first offer" }));
    cards.resolve(card.id, "go");
    cards.reopen(card.id);
    cards.upsert({ ...card, lifecycleId: "opening-2" });
    expect(drafts.change(card.id, { since: 1, lifecycle: "opening-1", words: "late" })).toEqual({
      refused: "closed",
    });
    expect(drafts.read()).toEqual([]);
    const fresh = draftOf(
      drafts.change(card.id, { since: 0, lifecycle: "opening-2", words: "new" }),
    );
    expect(fresh).toMatchObject({ lifecycle: "opening-2", revision: 1, words: "new" });
  });

  it("refuses a change that would hold more questions than a press may send", () => {
    const { drafts } = setup();
    const half = CARD_MAX_ANSWERS / 2 + 1;
    const some = (from: number) =>
      Array.from({ length: half }, (_, i) => pick(`q${from + i}`, "y"));
    draftOf(drafts.change(card.id, { since: 0, answers: some(0) }));
    expect(drafts.change(card.id, { since: 1, answers: some(half) })).toEqual({
      refused: "too-large",
    });
    expect(drafts.read()[0]?.answers).toHaveLength(half);
  });

  it("refuses answers past what a press may send and keeps nothing of that change", () => {
    const { drafts, pushed } = setup();
    const long = "x".repeat(3000);
    const answers = Array.from({ length: 30 }, (_, i) => pick(`q${i}`, long));
    expect(drafts.change(card.id, { since: 0, answers })).toEqual({ refused: "too-large" });
    expect(drafts.read()).toEqual([]);
    expect(pushed).toEqual([]);
  });
});
