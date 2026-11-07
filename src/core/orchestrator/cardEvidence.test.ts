import { NOTE_DONE_ACTION_ID, NOTE_GOT_IT_LABEL } from "@shared/cardLeave";
import { type Card, type CardObservation, withMergeClosesLine } from "@shared/cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { CardStore } from "../storage/cardStore";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { revisionNotice } from "./cardChanges";
import type { CardService } from "./cardService";
import { idleTurn, type ReportSortFacts, sortReport } from "./reportSort";

const decision = {
  title: "Which way?",
  body: "<p>Two ways to go.</p>",
  actions: [
    { id: "left", label: "Left" },
    { id: "right", label: "Right", default: true },
  ],
};

/**
 * The card evidence (docs/card-evidence.md): every card write lands its
 * observation beside it, read back through the store's typed reader.
 */
describe("CardService evidence", () => {
  // INF-1879: only the question's explicit Dismiss ends it; retain that captain action in its history.
  it("records the explicit question Dismiss, not its presentation-only corner, as an exit", () => {
    const { tasks, cardStore, make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard({ ...decision, id: "card-fm-launch-review" });
    const question = tasks.capture.fileDecision({
      id: "launch-review",
      title: decision.title,
      cardId: id,
    });
    try {
      cards.dismiss(cards.shown(id) as Card);
      expect(tasks.get(question.id)?.status).toBe("open");
      expect(cardStore.observations(id).filter((entry) => entry.kind === "exit")).toEqual([]);
      expect(cards.dismissQuestion(question.id)).toBeUndefined();
      expect(tasks.get(question.id)).toMatchObject({
        status: "dropped",
        closedReason: "cancelled",
      });
      expect(cardStore.observations(id).filter((entry) => entry.kind === "exit")).toEqual([
        expect.objectContaining({
          actor: "captain",
          source: "host",
          payload: { reason: "dismissed" },
        }),
      ]);
      expect(cards.shown(id)).toBeUndefined();
    } finally {
      cards.dispose();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const kinds = (cardStore: CardStore, id: string) =>
    cardStore.observations(id).map((observation) => observation.kind);
  const only = <K extends CardObservation["kind"]>(
    cardStore: CardStore,
    id: string,
    kind: K,
  ): Extract<CardObservation, { kind: K }>[] =>
    cardStore
      .observations(id)
      .filter((observation): observation is Extract<CardObservation, { kind: K }> => {
        return observation.kind === kind;
      });

  it("records the offer the stage showed, not the newer head its author wrote meanwhile", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const first = cards.shown(id) as Card;

    // The author revises while its old version is still on the stage.
    cards.emitCrewmateCard("t1", { ...decision, id, title: "Which way now?" }, "m");
    const head = cards.get(id) as Card;
    expect(head.offerId).not.toBe(first.offerId);
    expect(head.lifecycleId).toBe(first.lifecycleId);
    expect(cards.shown(id)?.offerId).toBe(first.offerId);

    // The captain chooses from what he sees.
    cards.resolve(first, "right", "right", undefined, "captain", {
      source: "chrome",
      submission: { id: "gesture-0001", offerId: first.offerId, lifecycleId: first.lifecycleId },
    });
    const [action] = only(cardStore, id, "action");
    expect(action).toMatchObject({
      actor: "captain",
      source: "chrome",
      offerId: first.offerId,
      interactionId: "gesture-0001",
      payload: {
        actionId: "right",
        recognized: true,
        label: "Right",
        closes: true,
        keepsOpen: false,
        display: { fidelity: "matched", reportedOfferId: first.offerId },
        interactionSource: "shell",
      },
    });
    // The row holds the newer head; the evidence keeps both offers whole.
    expect(cards.stored(id)?.title).toBe("Which way now?");
    const offers = only(cardStore, id, "offer");
    expect(offers.map((offer) => [offer.id, offer.payload.title])).toEqual([
      [first.offerId, "Which way?"],
      [head.offerId, "Which way now?"],
    ]);
    // What the stage did: waiting on the close-out, shown, then the newer
    // head waiting while the old one stayed up.
    expect(
      only(cardStore, id, "availability").map((entry) => [
        entry.offerId,
        entry.payload.state,
        entry.payload.waitingOn ?? null,
      ]),
    ).toEqual([
      [first.offerId, "waiting", "close-out"],
      [first.offerId, "available", null],
      [head.offerId, "waiting", "close-out"],
    ]);
  });

  it("marks a mismatched, missing or unreadable display honestly, never repaired with the head", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const ids = ["a", "b", "c", "d"].map((suffix) =>
      cards.addFirstmateCard({ ...decision, id: `fm-${suffix}`, taskId: "t1" }),
    );
    const [mismatched, legacy, malformed, blank] = ids as [string, string, string, string];
    const resolve = (id: string, submission?: unknown) =>
      cards.resolve(cards.shown(id) as Card, "left", "left", undefined, "captain", {
        source: "chrome",
        ...(submission !== undefined ? { submission } : {}),
      });
    resolve(mismatched, { id: "gesture-0002", offerId: "some-other-offer" });
    resolve(legacy);
    resolve(malformed, { id: 7 });
    resolve(blank, { id: "gesture-0003" });
    const display = (id: string) => only(cardStore, id, "action")[0]?.payload.display;
    expect(display(mismatched)).toEqual({
      fidelity: "mismatched",
      reportedOfferId: "some-other-offer",
    });
    expect(display(legacy)).toEqual({ fidelity: "legacy-missing" });
    expect(display(malformed)).toEqual({ fidelity: "unavailable" });
    expect(display(blank)).toEqual({ fidelity: "unavailable" });
    // A click that sent no id of its own is given one by the host, and says so.
    expect(only(cardStore, legacy, "action")[0]?.payload.interactionSource).toBe("host");
  });

  it("uses the current answer hold across reopen and restart without erasing historical messages or choices", () => {
    const directory = scratchDir("infinitary-thread-witness-");
    let { db, tasks, cardStore, make } = setup(openDatabase(directory));
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    let cards = make();
    const restart = () => {
      db.close();
      ({ db, tasks, cardStore, make } = setup(openDatabase(directory)));
      cards = make();
    };
    const emit = (title: string, actions = decision.actions) =>
      cards.emitCrewmateCard("t1", { ...decision, id: "preview", title, actions }, "Build it");
    const turn = () => {
      const facts: ReportSortFacts = {
        threadAwaitingAuthor: cards.threadAwaitingAuthor("t1"),
        decisionCardOpen: false,
        captainGateOwed: false,
        filedFollowups: false,
        jobsRunning: false,
        deliverable: false,
        pendingSettle: false,
        timedWait: false,
        checksWatched: false,
        accountHeld: false,
        waitsOnUnstarted: false,
        workObservable: true,
      };
      return { report: sortReport(facts), idle: idleTurn(facts) };
    };
    const id = emit("Preview");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.addMessage(id, "captain", "build it");
    expect(cards.threadAwaitingAuthor("t1")).toBe(true);
    cards.close(id, { kind: "crewmate", taskId: "t1" }, "recover settings");
    expect(cardStore.awaitingAuthor(id)).toBe(false);
    emit("Recovered settings");
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    restart();
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    const shown = cards.shown(id) as Card;
    const answers = [{ name: "capacity", values: ["8/12/20"], changed: true }];
    cards.resolve(shown, "right", "right", answers, "captain", { source: "chrome" });
    emit("Captured", []);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    restart();
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    expect(turn()).toMatchObject({ report: { rule: "stopped", wake: true }, idle: "nobody" });
    expect(cardStore.messages(id).map((message) => message.text)).toEqual(["build it"]);
    expect(only(cardStore, id, "action")[0]?.payload).toMatchObject({ answers });

    // A genuine new reply survives restart. An unrelated note is no answer.
    const change = cards.addMessage(id, "captain", "change the capacity");
    cards.emitCrewmateCard(
      "t1",
      { title: "Other note", body: "Unrelated.", actions: [] },
      "Build it",
    );
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    restart();
    expect(cards.get(id)?.awaiting).toBe("answer");
    expect(cards.threadAwaitingAuthor("t1")).toBe(true);
    expect(turn()).toMatchObject({
      report: { rule: "thread-unanswered", wake: false },
      idle: "thread",
    });
    cards.replyFromCrewmate("t1", {
      cardId: id,
      text: "Capacity corrected.",
      answersMessage: change.id,
    });
    expect(cards.get(id)?.awaiting).toBe("close-out");
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.shown(id)?.awaiting).toBeUndefined();
    db.close();
  });

  it("does not manufacture a Firstmate thread answer for a reopened lifecycle", () => {
    const { make, cardStore } = setup();
    const cards = make();
    const id = cards.addFirstmateCard({ ...decision, id: "fm-preview" });
    cards.addMessage(id, "captain", "build it");
    cards.close(id, { kind: "firstmate" }, "withdraw");
    cards.addFirstmateCard({ ...decision, id: "fm-preview" });
    // Nothing was written, so it reports none (answer delivery reads this).
    expect(cards.recordFirstmateThreadAnswer(id, "Unrelated close-out.")).toBe(false);
    expect(cardStore.messages(id).map((message) => message.text)).toEqual(["build it"]);
    cards.addMessage(id, "captain", "new question");
    expect(cards.recordFirstmateThreadAnswer(id, "Current line.")).toBe(true);
    expect(cardStore.messages(id).at(-1)?.text).toBe("Current line.");
    // The closing words name no message, so the question still waits.
    expect(cardStore.awaitingAuthor(id)).toBe(true);
  });

  it("says who owes each thread an answer from the current lifecycle, across reopen, close and restart (FI3-359)", () => {
    const directory = scratchDir("infinitary-thread-owed-");
    let { db, tasks, make } = setup(openDatabase(directory));
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Ship it", status: "idle" });
    let cards = make();
    const restart = () => {
      db.close();
      ({ db, tasks, make } = setup(openDatabase(directory)));
      cards = make();
    };
    const owed = () =>
      Object.fromEntries(
        cards.threadActivitySince(0).map((entry) => [entry.card.id, [entry.last.who, entry.owed]]),
      );
    const preview = cards.emitCrewmateCard("t1", { ...decision, id: "preview" }, "Build it");
    cards.addMessage(preview, "captain", "build it");
    expect(owed()).toEqual({ [preview]: ["captain", "author"] });
    // Withdrawn and raised again under its id: the captain still wrote last,
    // and the new lifecycle owes him nothing, before a restart and after it.
    cards.close(preview, { kind: "crewmate", taskId: "t1" }, "recover settings");
    expect(owed()).toEqual({ [preview]: ["captain", "closed"] });
    cards.emitCrewmateCard("t1", { ...decision, id: "preview", title: "Kept" }, "Build it");
    expect(owed()).toEqual({ [preview]: ["captain", "none"] });
    restart();
    expect(owed()).toEqual({ [preview]: ["captain", "none"] });

    // A genuine reply is owed across a restart, until the author answers.
    const question = cards.emitCrewmateCard(
      "t1",
      { title: "Which retry?", body: "<p>Keep it?</p>", actions: [] },
      "Build it",
    );
    const keep = cards.addMessage(question, "captain", "keep it?");
    restart();
    expect(owed()[question]).toEqual(["captain", "author"]);
    cards.replyFromCrewmate("t1", { cardId: question, text: "Kept it.", answersMessage: keep.id });
    expect(owed()[question]).toEqual(["crewmate", "none"]);

    // The Firstmate answers its own card, and a note its done task kept.
    const note = cards.emitCrewmateCard(
      "t2",
      { title: "Shipped", body: "<p>It is out.</p>", actions: [] },
      "Ship it",
    );
    tasks.close("t2", { status: "done", reason: "merged", actor: "host" });
    cards.addMessage(note, "captain", "which version?");
    const own = cards.addFirstmateCard({ ...decision, id: "fm-pick" });
    cards.addMessage(own, "captain", "why right?");
    expect(owed()).toMatchObject({
      [note]: ["captain", "firstmate"],
      [own]: ["captain", "firstmate"],
    });
    cards.resolve(cards.shown(own) as Card, "right", "right", undefined, "captain", {
      source: "chrome",
    });
    expect(owed()[own]).toEqual(["captain", "closed"]);
    restart();
    expect(owed()).toEqual({
      [preview]: ["captain", "none"],
      [question]: ["crewmate", "none"],
      [note]: ["captain", "firstmate"],
      [own]: ["captain", "closed"],
    });
    db.close();
  });

  it("keeps every earlier response through a reopen, a restart and a long timeline", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    let cards = make();
    const id = cards.addFirstmateCard({ ...decision, id: "fm-pick", taskId: "t1" });
    const answers = [{ name: "scope", values: ["all"], changed: true }];
    const first = cards.shown(id) as Card;
    cards.resolve(first, "right", "right", answers, "captain", {
      source: "chrome",
      submission: { id: "gesture-0006", offerId: first.offerId },
    });

    // The same id comes back, as a note after the choice (INF-1389
    // friction 1): a new lifecycle linked to the one before.
    cards.addFirstmateCard({ ...decision, actions: [], id: "fm-pick", taskId: "t1" });
    const second = cards.shown(id) as Card;
    expect(second.lifecycleId).not.toBe(first.lifecycleId);
    const opened = only(cardStore, id, "availability").find(
      (entry) => entry.lifecycleId === second.lifecycleId,
    );
    expect(opened?.payload).toMatchObject({
      lifecycle: "reopened",
      predecessor: first.lifecycleId,
    });

    // A restart resumes the open lifecycle and offer; nothing new is minted.
    const before = cardStore.observations(id).length;
    cards = make();
    expect(cards.get(id)).toMatchObject({
      lifecycleId: second.lifecycleId,
      offerId: second.offerId,
    });
    expect(cardStore.observations(id)).toHaveLength(before);

    // Ordinary task history compacts; the card's evidence does not.
    for (let index = 0; index < 520; index += 1) tasks.noteProgress("t1", `step ${index}`);
    expect(only(cardStore, id, "action")[0]).toMatchObject({
      lifecycleId: first.lifecycleId,
      payload: { actionId: "right", answers },
    });
  });

  // INF-2794: a note leaves on the captain's Got it, a recorded choice, never an exit.
  it("tells a Got it, a withdrawal, a take-down, a retirement and a duplicate apart", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Other", status: "idle" });
    const cards = make();
    const dismissed = cards.addFirstmateCard({
      ...decision,
      actions: [],
      id: "fm-d",
      taskId: "t1",
    });
    const withdrawn = cards.addFirstmateCard({ ...decision, id: "fm-w", taskId: "t1" });
    const duplicate = cards.addFirstmateCard({ ...decision, id: "fm-dup", taskId: "t1" });
    cards.addAuthDecisionCard("card-auth-x", "Codex", "Sign in again.");
    const retired = cards.emitCrewmateCard("t2", decision, "m");

    cards.pressNote(cards.shown(dismissed) as Card, { id: "gesture-0007" });
    cards.close(withdrawn, { kind: "firstmate" }, "obsolete now");
    cards.clearAuthDecisionCard("card-auth-x");
    cards.flagDuplicate({ cardId: duplicate, duplicateOf: dismissed, note: "same ask" });
    cards.retireTaskCards("t2", "merged");

    const exit = (id: string) => {
      const [only_] = only(cardStore, id, "exit");
      return [only_?.actor, only_?.source, only_?.payload.reason, only_?.payload.note ?? null];
    };
    expect(only(cardStore, dismissed, "exit")).toEqual([]);
    expect(only(cardStore, dismissed, "action")[0]).toMatchObject({
      actor: "captain",
      source: "chrome",
      interactionId: "gesture-0007",
      payload: { actionId: NOTE_DONE_ACTION_ID, label: NOTE_GOT_IT_LABEL, closes: true },
    });
    expect(exit(withdrawn)).toEqual(["firstmate", "tool", "author-withdrawal", "obsolete now"]);
    expect(exit("card-auth-x")).toEqual(["host", "host", "host-withdrawal", "recovered"]);
    expect(exit(duplicate)).toEqual(["firstmate", "tool", "duplicate", "same ask"]);
    expect(exit(retired)).toEqual(["host", "host", "task-retired", "merged"]);
    // None of them is a choice.
    for (const id of [withdrawn, "card-auth-x", duplicate, retired]) {
      expect(kinds(cardStore, id)).not.toContain("action");
    }
  });

  it("lists every card a task showed newest first, each ending in words", () => {
    let clock = 1000;
    const { tasks, cardStore, make } = setup(undefined, () => clock);
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const chosen = cards.addFirstmateCard({ ...decision, id: "fm-c", taskId: "t1" });
    clock += 10;
    const dismissed = cards.addFirstmateCard({
      ...decision,
      actions: [],
      id: "fm-d",
      taskId: "t1",
    });
    clock += 10;
    const withdrawn = cards.addFirstmateCard({ ...decision, id: "fm-w", taskId: "t1" });
    clock += 10;
    const open = cards.addFirstmateCard({ ...decision, id: "fm-o", taskId: "t1" });
    clock += 10;
    // INF-500: what CardActions.act hands over when the body's own script chose.
    const scripted = cards.addFirstmateCard({ ...decision, id: "fm-s", taskId: "t1" });
    cards.resolve(cards.shown(chosen) as Card, "right", "right");
    cards.pressNote(cards.shown(dismissed) as Card);
    cards.close(withdrawn, { kind: "firstmate" }, "obsolete now");
    cards.resolve(cards.shown(scripted) as Card, "left", "left", undefined, "firstmate", {
      source: "frame",
    });

    // The receipt keeps the script's channel; the row credits the card's author.
    expect(cardStore.past(scripted)?.ending).toMatchObject({ how: "chose", by: "frame" });
    expect(
      cardStore.forTask("t1").map((row) => [row.id, row.state, row.kind, row.ending ?? null]),
    ).toEqual([
      [scripted, "closed", "decision", "Your first mate chose Left"],
      [open, "open", "decision", null],
      [withdrawn, "closed", "decision", "Withdrawn by its author"],
      [dismissed, "closed", "note", "You chose Got it"],
      [chosen, "closed", "decision", "You chose Right"],
    ]);
  });

  it("names a card a timeline raised for a task that filed none of its own", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.addFirstmateCard({ ...decision, id: "fm-x" });
    expect(cardStore.forTask("t1")).toEqual([]);
    expect(cardStore.forTask("t1", [id, "purged-card"]).map((row) => row.id)).toEqual([id]);
  });

  it("mints a new offer only when what a card shows changes", () => {
    const { cardStore, make } = setup();
    const cards = make();
    const quiet = (body: string) => cards.addFirstmateQuietCard(body);
    quiet("<p>Nothing for a while.</p>");
    quiet("<p>Nothing for a while.</p>");
    quiet("<p>Still nothing.</p>");
    const offers = only(cardStore, "card-fm-quiet", "offer");
    expect(offers.map((offer) => [offer.payload.basis, offer.payload.body])).toEqual([
      ["put", "<p>Nothing for a while.</p>"],
      ["put", "<p>Still nothing.</p>"],
    ]);
    // One lifecycle throughout: a re-raise over an open card revises it.
    expect(new Set(cardStore.observations("card-fm-quiet").map((o) => o.lifecycleId)).size).toBe(1);
  });

  it("reopens the row of a host card raised again, so the stack and the row agree", () => {
    const { cardStore, make } = setup();
    let cards = make();
    cards.addAuthDecisionCard("card-auth-y", "Codex", "Sign in again.");
    cards.clearAuthDecisionCard("card-auth-y");
    cards.addAuthDecisionCard("card-auth-y", "Codex", "Sign in again.");
    // A restart finds it open, as the stack showed it.
    cards = make();
    expect(cards.has("card-auth-y")).toBe(true);
    expect(cardStore.chosenAction("card-auth-y")).toBeUndefined();
  });

  it("records a thread line against the offer on the stage and the card leaving it", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.addFirstmateCard({ ...decision, taskId: "t1" });
    const shown = cards.shown(id) as Card;
    const message = cards.addMessage(id, "captain", "Why left?", {
      id: "gesture-0008",
      offerId: shown.offerId,
    });
    const [ref] = only(cardStore, id, "message_ref");
    expect(ref).toMatchObject({
      actor: "captain",
      source: "thread",
      offerId: shown.offerId,
      messageId: message.id,
      payload: { messageId: message.id, who: "captain", display: { fidelity: "matched" } },
    });
    // The words stay in the thread, never copied into the evidence.
    expect(JSON.stringify(ref)).not.toContain("Why left?");
    expect(only(cardStore, id, "availability").at(-1)?.payload).toMatchObject({
      state: "waiting",
      waitingOn: "answer",
      cause: "reply",
    });
  });

  it("commits nothing and moves nothing when the record cannot be written", () => {
    const { cardStore, make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard(decision);
    const spy = vi.spyOn(cardStore, "observe").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() =>
      cards.resolve(cards.shown(id) as Card, "left", "left", undefined, "captain"),
    ).toThrow("disk full");
    spy.mockRestore();
    // No phantom resolution: the card is still up, and its row still open.
    expect(cards.has(id)).toBe(true);
    expect(cardStore.chosenAction(id)).toBeUndefined();
    expect(cardStore.listOpen().map((card) => card.id)).toContain(id);
  });

  it("seeds a card written before the capture as a snapshot whose start is unknown", () => {
    const { cardStore, make } = setup();
    cardStore.upsert({
      id: "card-fm-old",
      author: "firstmate",
      priority: 30,
      title: "From before",
      meta: "firstmate",
      body: "<p>Old.</p>",
      actions: [{ id: "go", label: "Go", default: true }],
      status: "ready",
      createdAt: 1,
    });
    make();
    const [offer] = only(cardStore, "card-fm-old", "offer");
    expect(offer).toMatchObject({ actor: "host", source: "restore" });
    expect(offer?.payload.basis).toBe("legacy-initial-snapshot");
    expect(only(cardStore, "card-fm-old", "availability")[0]?.payload).toMatchObject({
      state: "available",
      cause: "restore",
      lifecycle: "legacy-initial-snapshot",
    });
    // A second boot resumes it.
    make();
    expect(cardStore.observations("card-fm-old")).toHaveLength(2);
  });

  it("keeps the evidence when a task completes and removes it only with an explicit purge", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    cards.retireTaskCards("t1", "merged");
    expect(cardStore.observations(id).length).toBeGreaterThan(0);

    const taskless = cards.addFirstmateCard({ ...decision, actions: [], id: "fm-free" });
    cards.pressNote(cards.shown(taskless) as Card);
    const open = cards.addFirstmateCard({ ...decision, id: "fm-open" });
    cards.purgeTask("t1");
    cards.purgeEvidence([taskless, open]);
    expect(cardStore.observations(id)).toEqual([]);
    expect(cardStore.observations(taskless)).toEqual([]);
    // A card still on the stack keeps the evidence of what it shows.
    expect(cardStore.observations(open).length).toBeGreaterThan(0);
  });
});

describe("CardService what changed since the captain looked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const v1 =
    "<p>The upload test fails when the queue drains late.</p>" +
    "<ul><li>Mock the clock</li><li>Rewrite the uploader</li></ul><p>Evidence is in the log.</p>";
  const v2 = v1.replace("Rewrite the uploader", "Await the queue");
  const v3 = v2.replace(
    "<p>Evidence is in the log.</p>",
    "<p>Evidence is in the log.</p><p>Mocking the clock also fixes the retry.</p>",
  );
  const note = (body: string) => ({ id: "flaky", title: "The flaky test", body, actions: [] });
  const shown = (cards: CardService, id: string) =>
    cards.snapshot().find((card) => card.id === id) as Card;

  it("compares with the version last seen, so unseen revisions accumulate", () => {
    let clock = 1000;
    const { cardStore, make } = setup(openInMemoryDatabase(), () => clock);
    const cards = make();
    const id = cards.addFirstmateCard(note(v1));
    // Never seen: a card revised before the captain saw it is simply new.
    clock = 2000;
    cards.addFirstmateCard(note(v2));
    expect(shown(cards, id).changes).toBeUndefined();

    cards.seen(id, shown(cards, id).offerId as string);
    clock = 3000;
    cards.addFirstmateCard(note(v3));
    expect(shown(cards, id).changes).toMatchObject({ at: 3000, added: 1, removed: 0 });

    // A second revision while the captain is away is marked from the same
    // version: both changes, one line.
    clock = 4000;
    const v4 = v3.replace("Await the queue", "Await the job queue");
    cards.addFirstmateCard(note(v4));
    const accumulated = shown(cards, id);
    expect(accumulated.changes).toMatchObject({ at: 4000, added: 2, removed: 1 });
    expect(
      accumulated.changes?.marks.map((start) => accumulated.body.slice(start, start + 15)),
    ).toEqual(["<li>Await the j", "<p>Mocking the "]);

    // Seeing it keeps the marks until the next revision...
    cards.seen(id, accumulated.offerId as string);
    expect(shown(cards, id).changes).toEqual(accumulated.changes);
    expect(cardStore.observations(id).filter((o) => o.kind === "seen")).toHaveLength(2);
    // ...which is compared with what was seen last.
    clock = 5000;
    cards.addFirstmateCard(note(v4.replace("<p>Mocking the clock also fixes the retry.</p>", "")));
    expect(shown(cards, id).changes).toMatchObject({ at: 5000, added: 0, removed: 1, marks: [] });
  });

  it("records a look once per version and ignores one about a version no longer shown", () => {
    const { cardStore, make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard(note(v1));
    const first = shown(cards, id).offerId as string;
    cards.seen(id, first);
    cards.seen(id, first);
    cards.addFirstmateCard(note(v2));
    // A late report about the replaced version is stale.
    cards.seen(id, first);
    cards.seen("card-gone", first);
    const looks = cardStore.observations(id).filter((o) => o.kind === "seen");
    expect(looks.map((look) => [look.offerId, look.actor, look.source])).toEqual([
      [first, "captain", "stage"],
    ]);
    expect(shown(cards, id).changes).toMatchObject({ added: 1, removed: 1 });
  });

  it("marks a crewmate's revision only when it reaches the stage at the close-out", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", { ...note(v1), id: undefined }, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.seen(id, shown(cards, id).offerId as string);
    cards.emitCrewmateCard("t1", { ...note(v3), id }, "m");
    // The stage still shows the version seen: nothing has changed on it.
    expect(shown(cards, id).body).toBe(v1);
    expect(shown(cards, id).changes).toBeUndefined();
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(shown(cards, id).changes).toMatchObject({ added: 2, removed: 1, rewritten: false });
  });

  it("tells a crewmate author what its revision did, the same count the stage later shows", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", { ...note(v1), id: undefined }, "m");
    // Never seen: nothing to compare with.
    expect(cards.revisionChanges(id)).toBeUndefined();
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.seen(id, shown(cards, id).offerId as string);

    cards.emitCrewmateCard("t1", { ...note(v3), id }, "m");
    const told = cards.revisionChanges(id);
    expect(told).toMatchObject({ added: 2, removed: 1, rewritten: false, preview: false });
    expect(revisionNotice(told)).toContain("2 parts new and 1 removed");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(shown(cards, id).changes).toMatchObject({ added: told?.added, removed: told?.removed });

    // A rewrite is accepted, and named as one.
    cards.seen(id, shown(cards, id).offerId as string);
    cards.emitCrewmateCard("t1", { ...note("<p>One.</p><p>Two.</p><p>Three.</p>"), id }, "m");
    expect(revisionNotice(cards.revisionChanges(id))).toContain('"Rewritten" with no change bars');
  });

  it("forgets the marks when the card leaves, and keeps them across a restart", () => {
    const db = openInMemoryDatabase();
    const { make } = setup(db);
    const cards = make();
    const id = cards.addFirstmateCard(note(v1));
    cards.seen(id, shown(cards, id).offerId as string);
    cards.addFirstmateCard(note(v2));
    const changes = shown(cards, id).changes;
    expect(changes).toBeDefined();
    expect(shown(make(), id).changes).toEqual(changes);

    // Its author withdraws it: a note the captain closed never comes back
    // under its id (INF-2718), one its author closed may.
    cards.close(id, { kind: "firstmate" });
    // The same id up again is a new card: nothing seen on it yet.
    const again = cards.addFirstmateCard(note(v3));
    expect(again).toBe(id);
    expect(shown(cards, id).changes).toBeUndefined();
  });
});

// INF-2022: the owner persists exact released-update sightings, independently of historical offers.
describe("CardService current-update sightings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("shares, deduplicates and restores sightings without letting a legacy or stale report clear an answer", () => {
    const { make, tasks, cardStore, pushes } = setup();
    seedTask(tasks, { id: "findings", title: "Check latency", status: "idle" });
    let cards = make();
    const id = cards.emitCrewmateCard(
      "findings",
      { title: "Latency findings", body: "<p>The sampler has finished.</p>", actions: [] },
      "m",
    );
    const head = () => cards.snapshot().find((card) => card.id === id)!;
    const see = (card: Card) => cards.seenUpdate(id, card.lifecycleId!, card.currentUpdateId!);
    expect(head().currentUpdateId).toBeUndefined(); // Never publish unfinished cards.
    cards.closeOut({ kind: "crewmate", taskId: "findings" }, "report");
    const first = head();
    expect(first.currentUpdateSeen).toBe(false);
    cards.seen(id, first.offerId!); // The unchanged legacy request still records offer history.
    expect(head().seen).toBe(true);
    expect(head().currentUpdateSeen).toBe(false);
    see(first);
    see(first);
    expect(head().currentUpdateSeen).toBe(true);
    expect(
      cardStore
        .observations(id)
        .filter((o) => o.kind === "seen" && o.payload.updateId === first.currentUpdateId),
    ).toHaveLength(1);
    vi.runOnlyPendingTimers();
    expect(pushes.at(-1)?.find((card) => card.id === id)?.currentUpdateSeen).toBe(true);
    const confirm = cards.addMessage(id, "captain", "Can you confirm the findings?");
    cards.addMessage(
      id,
      "crewmate",
      "The findings are unchanged.",
      undefined,
      undefined,
      undefined,
      false,
      { answersMessage: confirm.id },
    );
    cards.closeOut({ kind: "crewmate", taskId: "findings" }, "idle");
    const answer = head();
    expect(answer.offerId).toBe(first.offerId);
    expect(answer.body).toBe(first.body);
    expect(answer.currentUpdateId).not.toBe(first.currentUpdateId);
    expect(answer.currentUpdateSeen).toBe(false);
    see(first);
    cards.seenUpdate(id, "earlier-lifecycle", answer.currentUpdateId!);
    cards.seen(id, answer.offerId!);
    expect(head().currentUpdateSeen).toBe(false);
    see(answer);
    const answerId = answer.currentUpdateId;
    cards.closeOut({ kind: "crewmate", taskId: "findings" }, "idle");
    expect(head().currentUpdateId).toBe(answerId);
    expect(head().currentUpdateSeen).toBe(true);
    cards.dispose();
    cards = make();
    expect(head().currentUpdateId).toBe(answerId);
    expect(head().currentUpdateSeen).toBe(true);
    cards.setMinimized(id, true);
    expect(head().minimized).toBe(true);
    cards.setMinimized(id, false);
    expect(head().currentUpdateSeen).toBe(true);
    cards.emitCrewmateCard(
      "findings",
      { id, title: first.title, body: "<p>The findings now include the queue.</p>", actions: [] },
      "m",
    );
    expect(head().currentUpdateId).toBe(answerId);
    cards.closeOut({ kind: "crewmate", taskId: "findings" }, "idle");
    expect(head().currentUpdateId).not.toBe(answerId);
    expect(head().currentUpdateSeen).toBe(false);
    cards.dismiss(cards.shown(id)!);
    cards.dispose();
  });

  it("releases a final author answer without an outstanding reply, not interim lines or repeated close-outs", () => {
    const { make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard({
      id: "findings",
      title: "Latency findings",
      body: "<p>The sampler has finished.</p>",
      actions: [],
    });
    const initial = cards.snapshot()[0]!;
    cards.seenUpdate(id, initial.lifecycleId!, initial.currentUpdateId!);
    cards.addMessage(id, "firstmate", "The same findings also apply on iPad.");
    expect(cards.snapshot()[0]!.currentUpdateId).toBe(initial.currentUpdateId);
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    const answer = cards.snapshot()[0]!;
    expect(answer.currentUpdateId).not.toBe(initial.currentUpdateId);
    expect(answer.currentUpdateSeen).toBe(false);
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot()[0]!.currentUpdateId).toBe(answer.currentUpdateId);
    cards.addMessage(id, "captain", "Please check the remaining samples.");
    cards.addMessage(
      id,
      "firstmate",
      "I am checking the samples.",
      undefined,
      undefined,
      undefined,
      true,
    );
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot()[0]!.awaiting).toBe("answer");
    expect(cards.snapshot()[0]!.currentUpdateId).toBe(answer.currentUpdateId);
    cards.dispose();
  });
});

describe("CardService past cards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const questions =
    '<p>Plan</p><form><fieldset><legend>1. Which?</legend><label><input type="radio" name="q1" value="a"> A</label></fieldset></form>';
  const plan = {
    title: "How to bring cards back",
    body: questions,
    actions: [
      { id: "not-now", label: "Not now" },
      {
        id: "build",
        label: "Approve and build",
        default: true,
        effect: { kind: "merge" as const, after: "close" as const },
      },
    ],
  };
  const answers = [{ name: "q1", values: ["a"], labels: ["A"], changed: true }];

  it("reads the version the captain last saw, what he chose, his answers and the thread", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", plan, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const first = cards.shown(id) as Card;
    cards.seen(id, first.offerId as string);
    // The author revises while the captain still has the first version up.
    cards.emitCrewmateCard("t1", { ...plan, id, title: "A newer title" }, "m");
    cards.addMessage(id, "captain", "yes, build it");
    cards.resolve(first, "build", "build", answers, "captain");

    const past = cards.past(id);
    expect(past).toMatchObject({
      id,
      taskId: "t1",
      title: "How to bring cards back",
      body: `${questions}${withMergeClosesLine(undefined, plan.actions)}`,
      ending: { how: "chose", actionId: "build", label: "Approve and build", by: "captain" },
      answers,
    });
    expect(past?.messages.map((message) => [message.who, message.text])).toEqual([
      ["captain", "yes, build it"],
    ]);
    // Nothing a past card offers can run: the effect is gone from the wire.
    expect(past?.actions.map((action) => action.id)).toEqual(["not-now", "build"]);
    expect(past?.actions.some((action) => "effect" in action)).toBe(false);
    // The row keeps the newer head the captain never saw.
    expect(cards.stored(id)?.title).toBe("A newer title");
  });

  it("keeps a merge card's risk with the version the captain saw, and a revision replaces it (FI3-1128)", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const rating = { level: "low", why: "One file" } as const;
    const declared = {
      blast: rating,
      behavior: rating,
      undo: rating,
      evidence: rating,
      sensitivity: rating,
      novelty: rating,
      deps: rating,
    };
    const first = { declared };
    const id = cards.emitCrewmateCard("t1", { ...plan, risk: first }, "m");
    expect(cards.stored(id)?.risk).toEqual(first);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const shownCard = cards.shown(id) as Card;
    cards.seen(id, shownCard.offerId as string);
    // A revision with a new assessment is a change the card shows, so it
    // takes the place of the first on the row; the captain saw the first.
    const second = {
      declared: { ...declared, deps: { level: "high" as const, why: "Adds a parser" } },
    };
    expect(cards.emitCrewmateCard("t1", { ...plan, id, risk: second }, "m")).toBe(id);
    expect(cards.stored(id)?.risk).toEqual(second);
    cards.resolve(shownCard, "build", "build", answers, "captain");
    expect(cards.past(id)?.risk).toEqual(first);
  });

  it("says how each card ended, and has nothing for one that is open or unknown", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const emit = (title: string) => {
      const id = cards.emitCrewmateCard("t1", { ...decision, title }, "m");
      cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
      return id;
    };

    const dismissed = cards.emitCrewmateCard(
      "t1",
      { ...decision, actions: [], title: "Read note" },
      "m",
    );
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.past(dismissed)).toBeUndefined();
    cards.pressNote(cards.shown(dismissed) as Card);
    expect(cards.past(dismissed)?.ending).toMatchObject({
      how: "chose",
      label: NOTE_GOT_IT_LABEL,
      by: "captain",
    });

    const withdrawn = emit("withdrawn");
    cards.close(withdrawn, { kind: "crewmate", taskId: "t1" }, "superseded");
    expect(cards.past(withdrawn)?.ending).toMatchObject({
      how: "author-withdrawal",
      by: "crewmate",
    });

    const retired = emit("retired");
    cards.takeDown(retired, "the question is gone");
    expect(cards.past(retired)?.ending).toMatchObject({ how: "host-withdrawal", by: "host" });

    expect(cards.past("card-never-saved")).toBeUndefined();
  });

  it("reads without writing: no row, no evidence, no thread line, no push", () => {
    const { tasks, cardStore, pushes, threads, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", plan, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.resolve(cards.shown(id) as Card, "build", "build", answers, "captain");

    const before = JSON.stringify([
      cardStore.get(id),
      cardStore.observations(id).length,
      cardStore.messages(id),
      pushes.length,
      threads.length,
    ]);
    for (let read = 0; read < 3; read++) cards.past(id);
    expect(
      JSON.stringify([
        cardStore.get(id),
        cardStore.observations(id).length,
        cardStore.messages(id),
        pushes.length,
        threads.length,
      ]),
    ).toBe(before);
  });
});
