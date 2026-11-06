import { NOTE_DONE_ACTION_ID } from "@shared/cardLeave";
import { type Card, SETTLE_FACTS_OPEN } from "@shared/cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import { CardStore } from "../storage/cardStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { FIRSTMATE_CARD_PREFIX } from "./cardEmit";
import { CardService } from "./cardService";

const decision = {
  title: "Which way?",
  body: "<p>Two ways to go.</p>",
  actions: [
    { id: "left", label: "Left" },
    { id: "right", label: "Right", default: true },
  ],
};

describe("CardService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // INF-63 accepted direction B: attribution comes from the linked review, not body wording.
  it("validates and persists review attribution, names the task, and refreshes its facts", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "builder", title: "Fix the footer", status: "idle" });
    seedTask(tasks, {
      id: "review",
      title: "Review the footer",
      status: "idle",
      parentId: "builder",
      shape: { kind: "review", kind_source: "host:review", basis: "builder" },
    });
    seedTask(tasks, { id: "other", title: "Other work", status: "idle" });
    let verdict = "findings abc1234 · risk low";
    const cards = make(() => `${SETTLE_FACTS_OPEN}${verdict}</div>`);
    for (const input of [
      { reviewTaskId: "missing", taskId: "builder" },
      { reviewTaskId: "review", taskId: "other" },
      { reviewTaskId: "review" },
      { reviewTaskId: "builder", taskId: "builder" },
    ]) {
      expect(() => cards.addFirstmateCard({ ...decision, ...input })).toThrow(
        "independent review of task_id",
      );
    }
    expect([...cards.values()]).toHaveLength(0);
    const id = cards.addFirstmateCard({ ...decision, taskId: "builder", reviewTaskId: "review" });
    expect(cardStore.get(id)).toMatchObject({ reviewTaskId: "review", meta: "Fix the footer" });
    expect(cards.get(id)?.body).toContain(verdict);
    verdict = "findings def5678 · risk medium";
    cards.refreshSettleFacts();
    expect(cards.get(id)?.body).toContain(verdict);
    expect(cards.get(id)?.body).not.toContain("abc1234");
    const restored = make();
    expect(restored.get(id)?.reviewTaskId).toBe("review");
    const ordinary = cards.addFirstmateCard({ ...decision, taskId: "builder" });
    expect(cards.get(ordinary)).toMatchObject({ meta: "Fix the footer" });
    expect(cards.get(ordinary)?.reviewTaskId).toBeUndefined();
    const standalone = cards.addFirstmateCard(decision);
    expect(cards.get(standalone)?.meta).toBe("firstmate");
  });

  it("puts a crewmate's card up once and revises it in place under its id", () => {
    const { tasks, gates, pushes, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "Build it", "GPT-6 Sol");
    expect(id).toBe("card-t1-1");
    expect(gates).toEqual(["t1"]);
    // The model rides as its own field, for the chrome's chip, and survives a restart.
    expect(cards.get(id)).toMatchObject({ meta: "Build it", model: "GPT-6 Sol" });
    expect(cards.stored(id)).toMatchObject({ meta: "Build it", model: "GPT-6 Sol" });

    const again = cards.emitCrewmateCard(
      "t1",
      { ...decision, id, body: "<p>Revised.</p>" },
      "m",
      "GPT-6 Sol",
    );
    expect(again).toBe(id);
    expect(cards.snapshot().map((card) => [card.id, card.body])).toEqual([[id, "<p>Revised.</p>"]]);
    // The default choice renders last, as the primary button.
    expect(cards.get(id)?.actions.map((action) => action.variant)).toEqual([
      "secondary",
      "primary",
    ]);
    vi.runAllTimers();
    expect(pushes.at(-1)?.map((card) => card.id)).toEqual([id]);
  });

  it("names where a crewmate card's task runs beside its meta line, through a revision, a restart and its offer", () => {
    const { db, tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "Build it", "GPT-6 Sol", "on Mac mini");
    // The place rides as its own field, never inside the meta line, so a
    // long title can give way while the place stays whole.
    expect(cards.get(id)).toMatchObject({
      meta: "Build it",
      model: "GPT-6 Sol",
      place: "on Mac mini",
    });
    cards.emitCrewmateCard(
      "t1",
      { ...decision, id, body: "<p>Revised.</p>" },
      "Build it",
      "GPT-6 Sol",
      "on Mac mini",
    );
    expect(new CardStore(db).get(id)).toMatchObject({ meta: "Build it", place: "on Mac mini" });
    // The offer the captain was shown keeps it too.
    const offers = cardStore.observations(id).filter((observation) => observation.kind === "offer");
    expect(offers.at(-1)?.payload).toMatchObject({ meta: "Build it", place: "on Mac mini" });
    // A card from a task that runs here names no place.
    seedTask(tasks, { id: "t2", title: "Stay here", status: "idle" });
    const here = cards.emitCrewmateCard("t2", decision, "Stay here", "GPT-6 Sol");
    expect(cards.get(here)).not.toHaveProperty("place");
  });

  it("decides a card's width at emit, again on every revision, and keeps it on the row", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const fiveColumns = `<table><tr>${"<td>c</td>".repeat(5)}</tr></table>`;
    const id = cards.emitCrewmateCard(
      "t1",
      { ...decision, body: `<p>The costs, side by side.</p>${fiveColumns}` },
      "m",
    );
    expect(cards.get(id)?.width).toBe("wide");

    // A revision is decided afresh: the table is gone, so the short note is narrow.
    cards.emitCrewmateCard("t1", { ...decision, id, body: "<p>One number now.</p>" }, "m");
    expect(cards.get(id)?.width).toBe("regular");
    cards.emitCrewmateCard("t1", { ...decision, id, body: `<p>${"x".repeat(600)}</p>` }, "m");
    expect(cards.get(id)?.width).toBeUndefined();

    // The author's hint widens a plain body; it cannot narrow a wide one.
    cards.emitCrewmateCard("t1", { ...decision, id, width: "full" }, "m");
    expect(cards.get(id)?.width).toBe("full");
    const narrowed = cards.emitCrewmateCard(
      "t1",
      {
        ...decision,
        body: `<p>Six columns.</p>${fiveColumns.replace("<tr>", "<tr><td>6</td>")}`,
        width: "wide",
      },
      "m",
    );
    expect(cards.get(narrowed)?.width).toBe("full");

    // The row holds it, so a restart shows the same widths.
    const restored = make();
    expect(restored.stored(id)?.width).toBe("full");
    expect(restored.stored(narrowed)?.width).toBe("full");
  });

  it("holds a new crewmate card for its close-out and a revision of a shown one on the old version", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    expect(cards.snapshot()[0]?.awaiting).toBe("close-out");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.snapshot()[0]?.awaiting).toBeUndefined();

    // A revision lands on the record; the stage keeps what it showed.
    cards.emitCrewmateCard("t1", { ...decision, id, body: "<p>Revised.</p>" }, "m");
    expect(cards.get(id)?.body).toBe("<p>Revised.</p>");
    expect(cards.snapshot()[0]).toMatchObject({ body: decision.body });
    expect(cards.snapshot()[0]?.awaiting).toBeUndefined();
    // Another task's close-out is not this author's, and a report is not
    // its turn's end: the card the captain already has redraws only then.
    cards.closeOut({ kind: "crewmate", taskId: "t2" }, "idle");
    expect(cards.snapshot()[0]?.body).toBe(decision.body);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(cards.snapshot()[0]?.body).toBe(decision.body);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.snapshot()[0]?.body).toBe("<p>Revised.</p>");
  });

  it("puts the Firstmate's own cards up at once and holds one only for the captain's reply", () => {
    const { make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard(decision);
    expect(cards.snapshot()[0]?.awaiting).toBeUndefined();
    cards.addFirstmateCard({ ...decision, id, body: "<p>Now three ways.</p>" });
    expect(cards.snapshot()[0]?.body).toBe("<p>Now three ways.</p>");

    const fourth = cards.addMessage(id, "captain", "and the fourth?");
    expect(cards.snapshot()[0]?.awaiting).toBe("answer");
    // A turn that ends without answering leaves it held.
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot()[0]?.awaiting).toBe("answer");
    cards.addFirstmateCard({
      ...decision,
      id,
      body: "<p>Now three ways.</p>",
      reply: "There is no fourth.",
      answersMessage: fourth.id,
    });
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot()[0]?.awaiting).toBeUndefined();
  });

  it("puts up no choice on a closed task, whose click would refuse it, but keeps its notes", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Prototype it", status: "idle" });
    tasks.close("t1", { status: "done", reason: "answered", actor: "captain" });
    const cards = make();
    expect(() => cards.addFirstmateCard({ ...decision, taskId: "t1" })).toThrow(
      /Task t1 is closed/,
    );
    expect(cards.snapshot()).toHaveLength(0);
    cards.addFirstmateCard({
      title: "It closed",
      body: "<p>Answered.</p>",
      actions: [],
      taskId: "t1",
    });
    expect(cards.snapshot()).toHaveLength(1);
  });

  it("lets a crewmate revise a card the captain closed when no reply of his waited on it", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.dismiss(cards.shown(id) as Card);
    cards.emitCrewmateCard("t1", { ...decision, id, body: "<p>Again.</p>" }, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(cards.snapshot().map((card) => card.id)).toEqual([id]);
  });

  // INF-1389 friction 1, the captain's "Start now": a card the captain answered came back as a new question.
  describe("a card the captain answered", () => {
    function answered() {
      const { db, tasks, cardStore } = setup();
      const inbox = new InboxStore(db, { now: () => 1000 });
      const cards = new CardService({
        now: () => 1000,
        tasks,
        cardStore,
        syncCaptainGate: () => {},
        closeAnsweredTask: () => false,
        settleFacts: () => undefined,
        followupNotice: () => undefined,
        choiceUnheard: (card) =>
          inbox.holdsUndeliveredChoice(
            card.id.startsWith(FIRSTMATE_CARD_PREFIX) ? FIRSTMATE_RECIPIENT : (card.taskId ?? ""),
            card.id,
          ),
        broadcastCrewCounts: () => {},
        broadcastEvent: () => {},
        broadcastCards: () => {},
      });
      // The 1:48 PM card: the first mate asked, the captain chose, and the
      // choice went on the first mate's lane while its turn still ran.
      const question = {
        id: "inf-1320-next",
        title: "INF-1320 closed: what next?",
        body: "<p>The fix merged, but the bug it names may still be there.</p>",
        actions: [
          { id: "investigate", label: "Investigate the bug", default: true },
          { id: "leave", label: "Leave it" },
        ],
      };
      const id = cards.addFirstmateCard(question);
      const answers = [
        { name: "scope", values: ["cards"], labels: ["Only the cards"], changed: true },
      ];
      cards.resolve(cards.shown(id) as Card, "investigate", "investigate", answers);
      const row = inbox.enqueue(
        FIRSTMATE_RECIPIENT,
        {
          facts: {
            kind: "card-choice",
            to: "firstmate",
            source: "chrome",
            card: { id, title: question.title },
            choice: { id: "investigate", label: "Investigate the bug", answers },
          },
        },
        undefined,
        "captain",
      );
      return { cards, cardStore, inbox, question, id, row };
    }

    it("refuses any revision written before the choice reached its author, carrying the choice", () => {
      const { cards, cardStore, question, id } = answered();
      for (const revision of [question, { ...question, actions: [] }]) {
        expect(() => cards.addFirstmateCard(revision)).toThrow(
          /already answered card .* by choosing "Investigate the bug", and that answer has not reached you yet[\s\S]*scope: "Only the cards" \(cards\)/,
        );
      }
      expect(cards.get(id)).toBeUndefined();
      expect(cardStore.chosenAction(id)).toBe("investigate");
    });

    it("once heard, refuses a revision that still asks and shows one that only tells as a note", () => {
      const { cards, cardStore, inbox, question, id, row } = answered();
      inbox.markDelivered([row]);
      expect(() => cards.addFirstmateCard(question)).toThrow(
        /would ask them that question again\. Ask a new question on a new card/,
      );
      expect(cardStore.chosenAction(id)).toBe("investigate");
      const told = cards.addFirstmateCard({
        ...question,
        title: "Investigating the bug INF-1320 names",
        actions: [],
      });
      expect(told).toBe(id);
      expect(cards.get(id)).toMatchObject({ actions: [] });
    });

    it("refuses a crewmate's revision while its choice waits on the task's lane", () => {
      const { tasks, cardStore, db } = setup();
      seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
      const inbox = new InboxStore(db, { now: () => 1000 });
      const cards = new CardService({
        now: () => 1000,
        tasks,
        cardStore,
        syncCaptainGate: () => {},
        closeAnsweredTask: () => false,
        settleFacts: () => undefined,
        followupNotice: () => undefined,
        choiceUnheard: (card) => inbox.holdsUndeliveredChoice(card.taskId ?? "", card.id),
        broadcastCrewCounts: () => {},
        broadcastEvent: () => {},
        broadcastCards: () => {},
      });
      const id = cards.emitCrewmateCard("t1", decision, "m");
      cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
      cards.resolve(cards.shown(id) as Card, "left", "left");
      const row = inbox.enqueue("t1", {
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "chrome",
          card: { id, title: decision.title },
          choice: { id: "left", label: "Left" },
        },
      });
      const note = { ...decision, id, actions: [] };
      expect(() => cards.emitCrewmateCard("t1", note, "m")).toThrow(/by choosing "Left"/);
      inbox.markDelivered([row]);
      expect(cards.emitCrewmateCard("t1", note, "m")).toBe(id);
    });
  });

  // INF-2718, from the captain's pick "Refuse re-showing a closed note":
  // after an update, INF-2662's crewmate woke in a fresh conversation and
  // raised the answer note the captain had just closed under its same id.
  it("refuses every emit under the id of a note the captain closed, and shows nothing", () => {
    const { tasks, cardStore, db } = setup();
    seedTask(tasks, { id: "t1", title: "Find the orange crewmate", status: "idle" });
    const cards = new CardService({
      now: () => 1000,
      tasks,
      cardStore,
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      choiceUnheard: (card) =>
        new InboxStore(db, { now: () => 1000 }).holdsUndeliveredChoice(card.taskId ?? "", card.id),
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: () => {},
    });
    const answer = {
      title: "The orange crewmate is a stale drawing",
      body: "<p>The glyph points at a task the app cannot read.</p>",
      actions: [],
      answering: true,
    };
    const id = cards.emitCrewmateCard("t1", answer, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(cards.pressNote(cards.shown(id) as Card)).toBe("got-it");
    expect(cards.shown(id)).toBeUndefined();
    for (const again of [
      { ...answer, id },
      { ...decision, id },
    ]) {
      expect(() => cards.emitCrewmateCard("t1", again, "m")).toThrow(
        /the captain closed your note .* so it stays closed and nothing was shown/,
      );
    }
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(cards.snapshot().filter((card) => card.taskId === "t1")).toEqual([]);
    expect(cardStore.past(id)?.ending).toMatchObject({
      how: "chose",
      actionId: NOTE_DONE_ACTION_ID,
      by: "captain",
    });
  });

  it("keeps a recorded note that takes no reply that way across a restart, and every other card as it was", () => {
    const { make } = setup();
    const cards = make();
    const quiet = cards.addRecordedFirstmateNote(
      { title: "Welcome aboard", body: "<p>A.</p>" },
      () => {},
      {
        replies: false,
      },
    );
    const plain = cards.addRecordedFirstmateNote(
      { title: "Plain note", body: "<p>B.</p>" },
      () => {},
    );
    const restored = make().snapshot();
    expect(restored.find((card) => card.id === quiet)?.replies).toBe(false);
    expect(restored.find((card) => card.id === plain)).not.toHaveProperty("replies");
  });

  it("places a recorded note on top of the stack when asked, above every card already there, across a restart", () => {
    let clock = 1000;
    const { make } = setup(openInMemoryDatabase(), () => (clock += 1));
    const cards = make();
    cards.addRecordedFirstmateNote({ title: "Plain note", body: "<p>A.</p>" }, () => {});
    cards.addFirstmateCard({ ...decision, title: "A decision" });
    cards.raiseHostCard({
      id: "card-host-attention",
      title: "Host attention",
      meta: "host",
      body: "<p>Look.</p>",
      actions: [{ id: "ok", label: "OK", variant: "primary", default: true }],
    });
    const order = () => cards.snapshot().map((card) => card.title);
    // An ordinary note sorts behind every decision and older note.
    expect(order()).toEqual(["Host attention", "A decision", "Plain note"]);
    cards.addRecordedFirstmateNote({ title: "First on top", body: "<p>B.</p>" }, () => {}, {
      onTop: true,
    });
    cards.addRecordedFirstmateNote({ title: "Second on top", body: "<p>C.</p>" }, () => {}, {
      onTop: true,
    });
    expect(order()).toEqual([
      "Second on top",
      "First on top",
      "Host attention",
      "A decision",
      "Plain note",
    ]);
    // Placement is where it goes now: a card arriving later sorts as it always does.
    cards.addFirstmateCard({ ...decision, title: "A later decision" });
    expect(order().slice(0, 2)).toEqual(["Second on top", "First on top"]);
    expect(
      make()
        .snapshot()
        .map((card) => card.title),
    ).toEqual(order());
  });
});
