import {
  type Card,
  type CardObservation,
  type CardThread,
  onStage,
  SETTLE_FACTS_OPEN,
} from "@shared/cards";
import { currentCheckSummary } from "@shared/checkSnapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { CardStore } from "../storage/cardStore";
import { openDatabase, openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { revisionNotice } from "./cardChanges";
import { CardService, type CardServiceHost, FIRSTMATE_CARD_PREFIX } from "./cardService";
import { idleTurn, type ReportSortFacts, sortReport } from "./reportSort";

function setup(db = openInMemoryDatabase(), now = () => 1000) {
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const gates: string[] = [];
  const pushes: Card[][] = [];
  const threads: CardThread[] = [];
  const make = (
    settleFacts: (taskId: string) => string | undefined = () => undefined,
    captainResponded?: CardServiceHost["captainResponded"],
  ) =>
    new CardService({
      now,
      tasks,
      cardStore,
      syncCaptainGate: (taskId) => gates.push(taskId),
      noteCapAnswered: () => {},
      closeAnsweredTask: () => false,
      captainResponded,
      settleFacts,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: (cards) => pushes.push(cards),
      broadcastThread: (thread) => threads.push(thread),
    });
  return { db, tasks, cardStore, gates, pushes, threads, make };
}

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

  // INF-2242: acceptance and the admitted choice must survive or roll back together.
  it("commits the chosen plan and ask acceptance in one transaction", () => {
    const { db, tasks, cardStore, make } = setup();
    seedTask(tasks, {
      id: "reading",
      title: "Plan a reading-style feature",
      status: "running",
      shape: { kind: "plan", deliverable: "answer" },
    });
    tasks.openAsk({ id: "reading-ask", text: "How could a reading-style feature work?" });
    tasks.attachAsk("reading-ask", "reading", "tool:spawn_crewmate");
    let interrupt = true;
    const cards = make(undefined, (card, response, action) => {
      expect(db.inTransaction).toBe(true);
      expect({ response, action }).toEqual({ response: "choice", action: "start" });
      tasks.acceptAnswer(["reading-ask"], card.id);
      if (interrupt) throw new Error("Interrupted while admitting choice");
    });
    const id = cards.emitCrewmateCard(
      "reading",
      {
        title: "Ready reading-style plan",
        body: "<p>The plan separates style from rights assessment.</p>",
        answering: true,
        asking: true,
        actions: [{ id: "start", label: "Start the next step", default: true }],
      },
      "model",
    );
    const card = cards.get(id) as Card;
    const answers = [{ name: "rights", values: ["separate"], changed: true }];
    expect(() => cards.resolve(card, "start", "start", answers)).toThrow(
      "Interrupted while admitting choice",
    );
    expect(tasks.getAsk("reading-ask")?.acceptedAt).toBeNull();
    expect(cardStore.chosenAction(id)).toBeUndefined();
    expect(cards.get(id)).toBeDefined();
    interrupt = false;
    cards.resolve(card, "start", "start", answers);
    expect(tasks.getAsk("reading-ask")?.answerCardId).toBe(id);
    expect(cardStore.past(id)?.answers).toEqual(answers);
    expect(cardStore.chosenAction(id)).toBe("start");
    cards.dispose();
  });

  // INF-2242: a script firing a declared action is not the captain accepting an answer.
  it("does not send script actions to ask acceptance", () => {
    const { make, tasks } = setup();
    const responded = vi.fn();
    const cards = make(undefined, responded);
    seedTask(tasks, {
      id: "reading",
      title: "Plan a reading-style feature",
      status: "running",
      shape: { kind: "plan", deliverable: "answer" },
    });
    const id = cards.emitCrewmateCard(
      "reading",
      {
        title: "Ready reading-style plan",
        body: "<p>The plan separates style from rights assessment.</p>",
        answering: true,
        asking: true,
        actions: [{ id: "start", label: "Start", default: true }],
      },
      "model",
    );
    cards.resolve(cards.get(id) as Card, "start", "start", undefined, "crewmate");
    expect(responded).not.toHaveBeenCalled();
    cards.dispose();
  });

  // INF-2186: graphFor needs staged actions, not a full message-graph rebuild per card.
  it("serves task flags from the shown card versions without reading their task or message graphs", () => {
    const { tasks, make } = setup();
    const cards = make();
    seedTask(tasks, { id: "board", title: "Keep Tasks responsive", status: "running" });
    cards.emitCrewmateCard("board", { ...decision, id: "board-choice" }, "m");
    const get = vi.spyOn(tasks, "get");
    const about = vi.spyOn(tasks, "askAbout");
    try {
      const full = cards.snapshot();
      expect(get).toHaveBeenCalled();
      expect(about).toHaveBeenCalled();
      get.mockClear();
      about.mockClear();
      const lean = cards.taskSnapshot();
      const flags = (rows: Card[]) =>
        rows.map(({ id, taskId, actions, awaiting, minimized, priority, createdAt }) => ({
          id,
          taskId,
          actions,
          awaiting,
          minimized,
          priority,
          createdAt,
        }));
      expect(flags(lean)).toEqual(flags(full));
      expect(get).not.toHaveBeenCalled();
      expect(about).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      about.mockRestore();
      cards.dispose();
    }
  });

  // INF-1404: the stack must restore unread cards after a reload/restart.
  it("derives seen snapshots from the lifecycle observation, not from arrival or revision", () => {
    const { make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard({ ...decision, id: "launch-review" });
    const offer = cards.snapshot()[0]?.offerId as string;
    expect(cards.snapshot()[0]?.seen).toBe(false);
    cards.seen(id, "stale-offer");
    expect(cards.snapshot()[0]?.seen).toBe(false);
    cards.seen(id, offer);
    expect(cards.snapshot()[0]?.seen).toBe(true);
    // A revision does not erase a look in this lifecycle.
    cards.addFirstmateCard({ ...decision, id, body: "<p>The revised launch review.</p>" });
    expect(cards.snapshot()[0]?.seen).toBe(true);
    const restored = make();
    expect(restored.snapshot()[0]?.seen).toBe(true);
    restored.close(id, { kind: "firstmate" });
    restored.addFirstmateCard({ ...decision, id });
    expect(restored.snapshot()[0]?.seen).toBe(false);
    cards.dispose();
    restored.dispose();
  });

  // INF-1610: every card about one of the captain's messages carries that
  // message, read from the saved message and never from the card's words.
  it("puts the captain's message on each card about it, from the saved message", () => {
    const { tasks, make } = setup();
    const cards = make();
    seedTask(tasks, { id: "footer", title: "Fix the footer", status: "running" });
    tasks.openAsk({
      id: "ask-footer",
      text: "the footer overlaps the composer\n\non small windows",
    });
    tasks.attachAsk("ask-footer", "footer", "tool:spawn_crewmate");
    const crewCard = cards.emitCrewmateCard(
      "footer",
      { ...decision, id: "footer-choice", body: "<p>Why: you asked about something else.</p>" },
      "m",
    );
    // The first mate's answer is filed as a question the message attaches to.
    tasks.openAsk({ id: "ask-port", text: "what does the port flag do?" });
    const answer = cards.addFirstmateCard({
      title: "It picks the port",
      body: "<p>It picks the port.</p>",
      actions: [],
      answering: true,
    });
    tasks.fileQuestion({
      id: "q-port",
      title: "The port flag",
      outcome: "It picks the port.",
      cardId: answer,
    });
    tasks.attachAsk("ask-port", "q-port", "tool:emit_card");
    const unasked = cards.addFirstmateCard({
      title: "The nightly check failed",
      body: "<p>It failed.</p>",
      actions: [],
    });
    const shown = new Map(cards.snapshot().map((card) => [card.id, card]));
    expect(shown.get(crewCard)?.asked).toEqual({
      at: tasks.getAsk("ask-footer")?.at,
      text: "the footer overlaps the composer\n\non small windows",
    });
    expect(shown.get(answer)).toMatchObject({
      answering: true,
      asked: { text: "what does the port flag do?" },
    });
    expect(shown.get(unasked)).not.toHaveProperty("asked");
    // The line is the host's reading, never saved on the card.
    expect(cards.stored(crewCard)).not.toHaveProperty("asked");
    cards.dispose();
  });

  // INF-2255: a check-watch refresh must derive one current strip per task,
  // not repeat its recorded checks for both the saved and shown revisions.
  it("shares settle facts across saved and shown revisions, then sees new checks and time", () => {
    let now = 1000;
    const { tasks, make, db } = setup(undefined, () => now);
    seedTask(tasks, { id: "builder", title: "Keep Tasks responsive", status: "idle" });
    const headSha = "93355db9d04e964513879db74d068a7789cb4c16";
    const checks = {
      headSha,
      complete: true,
      absenceDeclared: false,
      items: [{ name: "unit-tests", state: "failure" as const }],
    };
    seedDelivery(tasks, "builder", { headSha, ci: "red", ciAt: now, checks });
    const facts = vi.fn((taskId: string) => {
      const delivery = tasks.get(taskId)?.delivery;
      return `${SETTLE_FACTS_OPEN}${delivery ? currentCheckSummary(delivery)?.words : "unknown"} · observed at ${now}</div>`;
    });
    const cards = make(facts);
    const input = {
      ...decision,
      id: "completion",
      actions: [
        {
          id: "merge",
          label: "Merge",
          effect: { kind: "settle" as const, mode: "merge" as const },
        },
      ],
    };
    try {
      const id = cards.emitCrewmateCard(
        "builder",
        { ...input, body: "<p>The shown result.</p>" },
        "m",
      );
      cards.closeOut({ kind: "crewmate", taskId: "builder" }, "idle");
      cards.emitCrewmateCard("builder", { ...input, body: "<p>The later draft.</p>" }, "m");
      const savedAndShown = () => [cards.get(id), cards.snapshot().find((card) => card.id === id)];
      expect(savedAndShown().map((card) => card?.body)).toEqual([
        expect.stringContaining("The later draft."),
        expect.stringContaining("The shown result."),
      ]);
      facts.mockClear();
      cards.refreshSettleFacts();
      console.info(
        JSON.stringify({
          intent: "INF-2255 settle refresh",
          tasks: 1,
          revisions: 2,
          factReads: facts.mock.calls.length,
        }),
      );
      expect(facts).toHaveBeenCalledTimes(1);
      now += 60_000;
      facts.mockClear();
      tasks.recordChangeEvidence("builder", {
        ci: "green",
        checks: { ...checks, items: [{ name: "unit-tests", state: "success" }] },
      });
      expect(facts).toHaveBeenCalledTimes(1);
      const words = currentCheckSummary(tasks.get("builder")!.delivery!)!.words;
      for (const card of savedAndShown()) {
        expect(card?.body).toContain(words);
        expect(card?.body).toContain(`observed at ${now}`);
      }
      now += 60_000;
      facts.mockClear();
      cards.refreshSettleFacts();
      expect(facts).toHaveBeenCalledTimes(1);
      for (const card of savedAndShown()) expect(card?.body).toContain(`observed at ${now}`);
      expect(savedAndShown().map((card) => card?.body)).toEqual([
        expect.stringContaining("The later draft."),
        expect.stringContaining("The shown result."),
      ]);
    } finally {
      cards.dispose();
      db.close();
    }
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

  // INF-1364: older first-mate merge cards survive an upgrade, but only a
  // crewmate's completion offer may replace the captain's kept approval.
  it("finds only a crewmate completion offer among restored merge cards", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "build", title: "Ship the meter", status: "idle" });
    const mergeCard: Card = {
      id: "card-fm-old-merge",
      taskId: "build",
      author: "firstmate",
      title: "Merge with the phone check red",
      body: "<p>The change waits for its merge.</p>",
      meta: "firstmate",
      priority: 30,
      status: "ready",
      createdAt: 1,
      actions: [{ id: "merge", label: "Merge", effect: { kind: "settle", mode: "merge" } }],
    };
    cardStore.upsert(mergeCard);
    cardStore.upsert({ ...mergeCard, id: "card-host-merge", author: "host" });
    const restored = make();
    expect(restored.get(mergeCard.id)?.author).toBe("firstmate");
    expect(restored.openMergeAction("build")).toBeUndefined();
    cardStore.upsert({ ...mergeCard, id: "card-build-completion", author: "crewmate" });
    expect(make().openMergeAction("build")).toEqual({
      cardId: "card-build-completion",
      cardTitle: mergeCard.title,
      actionId: "merge",
      label: "Merge",
    });
  });

  it("INF-476 minimizes only presentation, persists through restart, and author answers and revisions restore it at the author's turn end", () => {
    const { db, tasks, cardStore, gates, make } = setup();
    seedTask(tasks, { id: "launch", title: "Prepare the launch checklist", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("launch", { ...decision, id: "launch-choice" }, "m");
    cards.closeOut({ kind: "crewmate", taskId: "launch" }, "report");
    cards.flushBroadcast();
    const taskBefore = tasks.get("launch");
    const gateCount = gates.length;
    const threadBefore = cardStore.messages(id);
    cards.setMinimized(id, true);
    expect(cards.shown(id)).toMatchObject({ minimized: true, status: "ready" });
    expect(onStage(cards.shown(id) as Card)).toBe(true);
    expect(tasks.get("launch")).toEqual(taskBefore);
    expect(gates).toHaveLength(gateCount);
    expect(cardStore.messages(id)).toEqual(threadBefore);
    expect(cardStore.forTask("launch")[0]).toMatchObject({ state: "open", minimized: true });
    const restored = make();
    expect(restored.snapshot().find((card) => card.id === id)?.minimized).toBe(true);
    restored.showOpenCard(id);
    expect(restored.get(id)?.minimized).toBeUndefined();
    // INF-926: the author's answer brings the card back when its turn ends,
    // not at a report while it still works.
    const aside = (service: CardService) =>
      service.snapshot().find((card) => card.id === id)?.minimized;
    restored.setMinimized(id, true);
    restored.replyFromCrewmate("launch", {
      cardId: id,
      text: "Friday keeps the review beside the launch.",
    });
    expect(restored.get(id)?.minimized).toBeUndefined();
    expect(aside(restored)).toBe(true);
    restored.closeOut({ kind: "crewmate", taskId: "launch" }, "report");
    expect(aside(restored)).toBe(true);
    restored.closeOut({ kind: "crewmate", taskId: "launch" }, "idle");
    expect(aside(restored)).toBeUndefined();
    // So does a revision; the captain's own restore needs no turn end.
    restored.setMinimized(id, true);
    restored.emitCrewmateCard(
      "launch",
      { ...decision, id, body: "<p>Keep Friday for the review.</p>" },
      "m",
    );
    restored.closeOut({ kind: "crewmate", taskId: "launch" }, "report");
    expect(aside(restored)).toBe(true);
    restored.setMinimized(id, false);
    expect(aside(restored)).toBeUndefined();
    restored.setMinimized(id, true);
    restored.emitCrewmateCard(
      "launch",
      { ...decision, id, body: "<p>Keep Friday for the launch review.</p>" },
      "m",
    );
    restored.closeOut({ kind: "crewmate", taskId: "launch" }, "idle");
    expect(restored.snapshot().find((card) => card.id === id)).toMatchObject({
      body: "<p>Keep Friday for the launch review.</p>",
    });
    expect(aside(restored)).toBeUndefined();
    // A restart closes every author out: an answer written before it brings the card back.
    restored.setMinimized(id, true);
    restored.replyFromCrewmate("launch", { cardId: id, text: "The launch review stays." });
    expect(aside(restored)).toBe(true);
    expect(aside(make())).toBeUndefined();
    db.close();
  });

  // INF-1472 (the captain: "i minimized INF-1177's card earlier when it was
  // working ... but it never popped itself back up"): a card put aside after
  // its crewmate wrote on it, before that crewmate's turn ends, still comes
  // back at the turn end with the newer write.
  it("INF-1472 brings back a card put aside while its crewmate's write waits on its turn end", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "launch", title: "Prepare the launch checklist", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("launch", { ...decision, id: "launch-choice" }, "m");
    cards.closeOut({ kind: "crewmate", taskId: "launch" }, "idle");
    const shown = () => cards.snapshot().find((card) => card.id === id);
    // A revision written, then put aside while the stage still holds the earlier version.
    cards.emitCrewmateCard(
      "launch",
      { ...decision, id, body: "<p>Keep Friday for the review.</p>" },
      "m",
    );
    expect(shown()?.body).toBe(decision.body);
    cards.setMinimized(id, true);
    expect(shown()?.minimized).toBe(true);
    cards.closeOut({ kind: "crewmate", taskId: "launch" }, "report");
    expect(shown()?.minimized).toBe(true);
    cards.closeOut({ kind: "crewmate", taskId: "launch" }, "idle");
    expect(shown()).toMatchObject({ body: "<p>Keep Friday for the review.</p>" });
    expect(shown()?.minimized).toBeUndefined();
    // A thread answer written, then put aside before the turn ends.
    cards.addMessage(id, "captain", "Why Friday?");
    cards.replyFromCrewmate("launch", { cardId: id, text: "Friday keeps the review beside it." });
    cards.setMinimized(id, true);
    cards.closeOut({ kind: "crewmate", taskId: "launch" }, "idle");
    expect(shown()?.minimized).toBeUndefined();
    // Put aside with nothing new written, it stays aside at the turn end.
    cards.setMinimized(id, true);
    cards.closeOut({ kind: "crewmate", taskId: "launch" }, "idle");
    expect(shown()?.minimized).toBe(true);
  });

  it("keeps marked replies available through restart and still closes every choice", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", { ...decision, id: "round", holdsPlace: true }, "m");
    expect(onStage(cards.get(id) as Card)).toBe(false);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.addMessage(id, "captain", "why this answer?");
    expect(cards.get(id)).toMatchObject({ holdsPlace: true, awaiting: "answer" });
    expect(onStage(cards.get(id) as Card)).toBe(true);
    const restored = make();
    expect(restored.get(id)).toMatchObject({ holdsPlace: true, awaiting: "answer" });
    expect(onStage(restored.get(id) as Card)).toBe(true);
    restored.replyFromCrewmate("t1", { cardId: id, text: "Here is why." });
    restored.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const shown = restored.shown(id) as Card;
    expect(restored.resolve(shown, "right", "right")).toBe(false);
    expect(restored.get(id)).toBeUndefined();
    // After the captain's choice its id comes back only as a note (INF-1389 friction 1).
    const again = restored.emitCrewmateCard(
      "t1",
      { ...decision, actions: [], id: "round", holdsPlace: true },
      "m",
    );
    expect(again).toBe(id);
    restored.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(restored.get(id)?.holdsPlace).toBe(true);
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

  it("refreshes shown and staged settle facts without an author revision, including at boot", () => {
    const { tasks, make, cardStore } = setup();
    seedTask(tasks, { id: "t1", title: "Ship it", status: "idle" });
    const facts = () =>
      `${SETTLE_FACTS_OPEN}<span>${tasks.get("t1")?.delivery?.ci ?? "pending"}</span></div>`;
    const cards = make(facts);
    const input = {
      ...decision,
      actions: [
        {
          id: "merge",
          label: "Merge",
          default: true,
          effect: { kind: "settle" as const, mode: "merge" as const },
        },
      ],
    };
    const id = cards.emitCrewmateCard("t1", input, "Ship it", "model");
    cards.emitCrewmateCard(
      "t1",
      { ...input, id, body: "<p>New author body.</p>" },
      "Ship it",
      "model",
    );
    const shownBody = cards.snapshot()[0]?.body;
    const before = cards.thread(id).messages.length;
    const changes = cards.revisionChanges(id);
    seedDelivery(tasks, "t1", { ci: "red", ciAt: 1000 });
    expect(cards.snapshot()[0]?.body).toBe(shownBody?.replace("pending", "red"));
    expect(cards.get(id)?.body).toBe(`<p>New author body.</p>${facts()}`);
    expect(cardStore.get(id)?.body).toBe(cards.get(id)?.body);
    expect(cards.thread(id).messages.length).toBe(before);
    expect(cards.revisionChanges(id)).toEqual(changes);
    cards.dispose();
    seedDelivery(tasks, "t1", { ci: "green", ciAt: 2000 });
    // No card service was alive to hear the mutation; boot re-stamps it.
    expect(cardStore.get(id)?.body).toContain("red");
    expect(make(facts).snapshot()[0]?.body).toContain("green");
  });

  it("applies the same short-note rule to host cards and their revisions", () => {
    const { make } = setup();
    const cards = make();
    const hostCard: Card = {
      id: "card-host-width",
      author: "host",
      priority: 0,
      title: "A short notice",
      meta: "",
      body: "<p>All set.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
    };
    cards.put(hostCard);
    expect(cards.get(hostCard.id)?.width).toBe("regular");
    cards.put({ ...hostCard, body: `<p>${"x".repeat(600)}</p>` });
    expect(cards.get(hostCard.id)?.width).toBeUndefined();
    cards.put({ ...hostCard, body: '<svg viewBox="0 0 750 40"></svg>' });
    expect(cards.get(hostCard.id)?.width).toBeUndefined();
    cards.put(hostCard);
    expect(cards.get(hostCard.id)?.width).toBe("regular");
    expect(make().stored(hostCard.id)?.width).toBe("regular");
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

  it("keeps a card the captain replied under off the stage across a restart, which closes every author out", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const before = make();
    const asked = before.emitCrewmateCard("t1", decision, "m");
    before.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    before.addMessage(asked, "captain", "why not left?");
    // Written, not yet reported, when the app quits.
    const unsaid = before.emitCrewmateCard(
      "t1",
      { ...decision, id: "second", title: "A second question" },
      "m",
    );
    expect(before.get(unsaid)?.awaiting).toBe("close-out");

    const after = make();
    const stage = new Map(after.snapshot().map((card) => [card.id, card]));
    // The captain's reply still holds its card: the hide lives in the core.
    expect(stage.get(asked)?.awaiting).toBe("answer");
    // The dead process ended the author's turn, which is its close-out.
    expect(stage.get(unsaid)?.awaiting).toBeUndefined();
    expect(
      tasks
        .timeline("t1")
        .filter((event) => event.kind === "card_raised" && event.ref === unsaid)
        .map((event) => event.data),
    ).toEqual([expect.objectContaining({ closeOut: "restart" })]);

    // The held card comes back when its author answers and its turn ends.
    after.replyFromCrewmate("t1", { cardId: asked, text: "Left races the queue." });
    expect(after.get(asked)?.awaiting).toBe("close-out");
    after.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(after.snapshot().find((card) => card.id === asked)?.awaiting).toBe("close-out");
    after.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(after.snapshot().find((card) => card.id === asked)?.awaiting).toBeUndefined();
  });

  it("records an author's thread answer as a row on the card's task, and never the captain's words", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    cards.addMessage(id, "captain", "which way is faster?");
    cards.replyFromCrewmate("t1", { cardId: id, text: "Left is faster. It skips the queue." });
    const replies = tasks.timeline("t1").filter((event) => event.kind === "replied");
    expect(replies).toEqual([
      expect.objectContaining({
        actor: "crewmate",
        text: "Left is faster. It skips the queue.",
        data: { cardId: id, title: "Which way?" },
      }),
    ]);
    expect(tasks.timeline("t1").some((event) => event.text.includes("which way is faster?"))).toBe(
      false,
    );
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

    cards.addMessage(id, "captain", "and the fourth?");
    expect(cards.snapshot()[0]?.awaiting).toBe("answer");
    // A turn that ends without answering leaves it held.
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot()[0]?.awaiting).toBe("answer");
    cards.recordFirstmateThreadAnswer(id, "There is no fourth.");
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

  it("pushes the captain's reply at once, so an answer inside the push window still ends a wait the window saw", () => {
    const { pushes, make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard(decision);
    vi.runAllTimers();
    pushes.length = 0;
    const waits = () => pushes.map((push) => push.find((card) => card.id === id)?.awaiting);

    cards.addMessage(id, "captain", "and the fourth?");
    // No timer has run: the window already has the card waiting on its answer.
    expect(waits()).toEqual(["answer"]);
    cards.recordFirstmateThreadAnswer(id, "There is no fourth.");
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    vi.runAllTimers();
    expect(waits()).toEqual(["answer", undefined]);
  });

  it("takes the Firstmate's closing words under a note its closed task kept, and clears the wait", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Ship it", status: "idle" });
    const cards = make();
    const note = cards.emitCrewmateCard(
      "t1",
      { title: "Released", body: "<p>Shipped.</p>", actions: [] },
      "m",
    );
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");

    // While its crewmate lives, the Firstmate has no business in its thread.
    cards.addMessage(note, "captain", "what changed?");
    expect(cards.recordFirstmateThreadAnswer(note, "Not yours to answer.")).toBe(false);
    expect(cards.thread(note).messages.map((message) => message.who)).toEqual(["captain"]);

    tasks.close("t1", { status: "done", reason: "merged", actor: "host" });
    cards.addMessage(note, "captain", "and the version?");
    expect(cards.snapshot().find((card) => card.id === note)?.awaiting).toBe("answer");
    expect(cards.recordFirstmateThreadAnswer(note, "It is in 0.2.")).toBe(true);
    expect(cards.thread(note).messages.map((message) => message.who)).toEqual([
      "captain",
      "captain",
      "firstmate",
    ]);
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot().find((card) => card.id === note)?.awaiting).toBeUndefined();
  });

  // INF-770 direction A: a reply never moves a card, whatever waits behind it.
  it("keeps a replied-under card shown in its place across a restart until the answer", () => {
    const { tasks, make, cardStore } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const asked = cards.emitCrewmateCard("t1", decision, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const other = cards.addFirstmateCard({ ...decision, id: "other", title: "Other" });
    const staged = () =>
      cards
        .snapshot()
        .filter(onStage)
        .map((card) => card.id);
    expect(staged()).toEqual([asked, other]);

    cards.addMessage(asked, "captain", "why not left?");
    // On the stage, in its place, carrying what it waits on.
    expect(staged()).toEqual([asked, other]);
    const waiting = cards.snapshot().find((card) => card.id === asked);
    expect(waiting).toMatchObject({ awaiting: "answer", title: decision.title });
    expect(waiting?.sentBackAt).toBeDefined();
    expect(cardStore.awaitingAuthor(asked)).toBe(true);

    // A later card and a restart leave it where it is.
    const later = cards.addFirstmateCard({ ...decision, id: "later", title: "Later" });
    expect(staged()).toEqual([asked, other, later]);
    const restored = make();
    expect(
      restored
        .snapshot()
        .filter(onStage)
        .map((card) => card.id),
    ).toEqual([asked, other, later]);
    expect(restored.get(asked)?.awaiting).toBe("answer");

    // A revision during the wait leaves the version on the stage in its
    // place until its author's turn ends (INF-926).
    restored.emitCrewmateCard(
      "t1",
      { ...decision, id: asked, body: "<p>Revised.</p>", reply: "Revised." },
      "m",
    );
    expect(restored.get(asked)?.body).toBe("<p>Revised.</p>");
    expect(restored.snapshot().find((card) => card.id === asked)?.body).toBe(decision.body);

    // The author answers: its report leaves the card in its place, waiting
    // on its turn end, which redraws the newest version there.
    restored.replyFromCrewmate("t1", { cardId: asked, text: "Left races the queue." });
    restored.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(restored.snapshot().find((card) => card.id === asked)?.awaiting).toBe("close-out");
    expect(restored.snapshot().map((card) => card.id)).toEqual([asked, other, later]);
    restored.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    const answered = restored.snapshot().find((card) => card.id === asked);
    expect(answered?.body).toBe("<p>Revised.</p>");
    expect(answered?.awaiting).toBeUndefined();
    expect(answered?.sentBackAt).toBeUndefined();
    expect(restored.snapshot().map((card) => card.id)).toEqual([asked, other, later]);
    expect(cardStore.awaitingAuthor(asked)).toBe(false);
  });

  it("keeps a replied-under card the captain closed closed through its crewmate's answer, until that crewmate closes out", () => {
    const { tasks, make, cardStore } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Other work", status: "idle" });
    const cards = make();
    const asked = cards.emitCrewmateCard("t1", decision, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const ids = () => cards.snapshot().map((card) => card.id);
    cards.addMessage(asked, "captain", "why not left?");
    expect(ids()).toEqual([asked]);

    // The captain closes the lone card while its crewmate works on the answer.
    cards.dismiss(cards.shown(asked) as Card);
    expect(ids()).toEqual([]);
    // The answer it was writing - a revision under the same id - opens nothing.
    const answer = { ...decision, id: asked, body: "<p>Left races the queue.</p>" };
    expect(() => cards.emitCrewmateCard("t1", answer, "m")).toThrow(/captain closed card/);
    // Another crewmate's close-out leaves the refusal standing.
    cards.closeOut({ kind: "crewmate", taskId: "t2" }, "report");
    expect(() => cards.emitCrewmateCard("t1", answer, "m")).toThrow(/captain closed card/);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(ids()).toEqual([]);
    expect(cardStore.listOpen().map((card) => card.id)).toEqual([]);

    // After its close-out the crewmate may raise the id again, a new card, as for any closed card.
    cards.emitCrewmateCard("t1", answer, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(ids()).toContain(asked);
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
        noteCapAnswered: () => {},
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
        noteCapAnswered: () => {},
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

  it("takes an answered card down, puts the answer on its task, and releases the gate", () => {
    const { tasks, gates, pushes, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    const card = cards.get(id) as Card;

    expect(cards.resolve(card, "left", "left")).toBe(false);
    expect(cards.has(id)).toBe(false);
    expect(tasks.timeline("t1").map((event) => event.kind)).toContain("card_resolved");
    expect(gates).toEqual(["t1", "t1"]);
    vi.runAllTimers();
    expect(pushes.at(-1)).toEqual([]);
  });

  it("records the answers a choice carried on the row and the task's card_resolved event (contract 4.22)", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    const card = cards.get(id) as Card;
    const answers = [
      {
        name: "read-scope",
        values: ["all-visible"],
        labels: ["Every project your sign-in can see"],
        changed: true,
      },
      { name: "notes", values: [], changed: false },
    ];

    cards.resolve(card, "right", "right", answers);
    const resolved = tasks.timeline("t1").find((event) => event.kind === "card_resolved");
    // INF-1296: the event names the card evidence's record of the same choice.
    const choice = cardStore.observations(id).find((entry) => entry.kind === "action");
    expect(resolved?.data).toEqual({
      cardId: id,
      action: "right",
      answers,
      observation: choice?.id,
    });
    // The Firstmate's resolutions line reads them back off the row.
    expect(cards.captainResolutionsSince(0, 5)).toEqual([
      expect.objectContaining({ action: "right", answers }),
    ]);
  });

  it("records no answers for a choice that carried none", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    cards.resolve(cards.get(id) as Card, "left", "left");
    const resolved = tasks.timeline("t1").find((event) => event.kind === "card_resolved");
    const choice = cardStore.observations(id).find((entry) => entry.kind === "action");
    expect(resolved?.data).toEqual({ cardId: id, action: "left", observation: choice?.id });
    expect(cards.captainResolutionsSince(0, 5)[0]).not.toHaveProperty("answers");
  });

  it("files an operation row for a host decision with no task, and drops it when the card goes", () => {
    const { tasks, make } = setup();
    const cards = make();
    cards.raiseHostCard({
      id: "card-consent",
      title: "Add the plugin?",
      meta: "firstmate",
      body: "<p>It asks to read your tasks.</p>",
      actions: [{ id: "add", label: "Add it", variant: "primary" }],
    });
    expect(tasks.openCardTaskFor("card-consent")?.kind).toBe("operation");

    cards.withdrawHostCard("card-consent", "gone");
    expect(cards.has("card-consent")).toBe(false);
    expect(tasks.openCardTaskFor("card-consent")).toBeUndefined();
  });

  it("files each paused-seat card's operation row, gated on the card, and drops it when the card leaves (W1 S9)", () => {
    const { tasks, make } = setup();
    const cards = make();
    const gatedOn = (id: string) => {
      const row = tasks.openCardTaskFor(id);
      expect(row?.kind).toBe("operation");
      expect(row?.gate).toEqual({ kind: "captain", ref: id });
    };
    cards.addFirstmatePauseCard({
      pause: "refused",
      body: "Claude is not answering your first mate right now.",
      accountId: "acct_claude",
      providerName: "Claude",
    });
    cards.addFirstmatePauseCard({
      pause: "signed_out",
      body: "Claude needs you to sign in again.",
      accountId: "acct_claude",
      providerName: "Claude",
    });
    cards.addFirstmatePauseCard({
      pause: "no_headroom",
      body: "Move?",
      providerName: "Claude",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    cards.addFirstmateMoveBackCard({
      providerId: "anthropic-claude",
      providerName: "Claude",
      body: "Claude can serve your first mate again.",
    });
    const ids = [
      "card-fm-refused",
      "card-fm-no-headroom",
      "card-fm-flagship-move",
      "card-fm-move-back",
    ];
    for (const id of ids) gatedOn(id);
    expect(cards.get("card-fm-no-headroom")?.title).toBe(
      "Your first mate needs you to sign in again",
    );

    // The pause is over: its three cards and their rows go; the way back's card stays.
    cards.withdrawFirstmatePauseCards("serves again");
    for (const id of ids.slice(0, 3)) {
      expect(cards.has(id)).toBe(false);
      expect(tasks.openCardTaskFor(id)).toBeUndefined();
    }
    gatedOn("card-fm-move-back");
    cards.withdrawHostCard("card-fm-move-back", "moved");
    expect(tasks.openCardTaskFor("card-fm-move-back")).toBeUndefined();
  });

  // The design skill's footer rule: the card's one primary is its default,
  // drawn at the right edge, so ⌘1 finds it (INF-404).
  it("marks each paused-seat card's one primary as its default", () => {
    const { make } = setup();
    const cards = make();
    cards.addFirstmatePauseCard({
      pause: "refused",
      body: "Claude is not answering your first mate right now.",
      accountId: "acct_claude",
      providerName: "Claude",
    });
    cards.addFirstmatePauseCard({
      pause: "signed_out",
      body: "Move?",
      accountId: "acct_claude",
      providerName: "Claude",
      move: { providerId: "openai-codex", providerName: "Codex" },
    });
    cards.addFirstmatePauseCard({ pause: "no_headroom", body: "Out.", providerName: "Codex" });
    const defaults = (id: string) =>
      cards
        .get(id)
        ?.actions.filter((action) => action.default)
        .map((action) => [action.id, action.variant]);
    expect(defaults("card-fm-refused")).toEqual([["try-again", "primary"]]);
    expect(defaults("card-fm-flagship-move")).toEqual([["move-flagship", "primary"]]);
    expect(defaults("card-fm-no-headroom")).toEqual([["open-settings", "primary"]]);
  });

  it("revises a paused-seat card in place when its words change, and never re-raises a dismissed one on revise (review S3)", () => {
    const { tasks, make } = setup();
    const cards = make();
    cards.addFirstmatePauseCard({ pause: "no_headroom", body: "Out.", providerName: "Codex" });
    const row = tasks.openCardTaskFor("card-fm-no-headroom");
    cards.addFirstmatePauseCard({
      pause: "signed_out",
      body: "Personal needs you to sign in again.",
      accountId: "acct",
      providerName: "Codex",
    });
    const revised = cards.get("card-fm-no-headroom");
    expect(revised?.title).toBe("Your first mate needs you to sign in again");
    expect(revised?.actions.map((action) => action.id)).toEqual(["sign-in"]);
    // One question, revised: its row is the same row.
    expect(tasks.openCardTaskFor("card-fm-no-headroom")?.id).toBe(row?.id);

    cards.withdrawFirstmatePauseCards("dismissed");
    cards.addFirstmatePauseCard(
      { pause: "no_headroom", body: "Out.", providerName: "Codex" },
      { reviseOnly: true },
    );
    expect(cards.has("card-fm-no-headroom")).toBe(false);
  });

  // INF-990 friction 4, replayed from INF-908: the crewmate answered the
  // captain's reply with a card under a new id, the reply on it was lost,
  // and the first card waited on an answer while it closed the second.
  it("keeps a reply on the card the captain wrote under, and names that card while it waits", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Why the chips differ", status: "idle" });
    const cards = make();
    const first = cards.emitCrewmateCard(
      "t1",
      {
        title: "The chip colors distinguish prefixes",
        body: "<p>Prefixes are muted.</p>",
        actions: [],
      },
      "m",
    );
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    cards.addMessage(first, "captain", "that seems inconsistent");
    const answer = {
      id: "models-chip-color",
      title: "The chip uses separate colors",
      body: "<p>Prefixes are muted; labels are bright.</p>",
      actions: [],
      reply: "Yes, the same name is bright in a label and muted as a prefix.",
    };
    expect(() => cards.emitCrewmateCard("t1", answer, "m")).toThrow(
      `Card refused: reply answers the captain's reply under card "The chip colors distinguish prefixes" (${first}), and id "models-chip-color" names a new card, so that answer would be lost.`,
    );
    expect(cards.threadsAwaitingAuthor("t1")).toEqual([
      { id: first, title: "The chip colors distinguish prefixes" },
    ]);

    // A new card without the reply goes up; an answer under it says the
    // first card still waits, and closing it leaves that card named.
    const second = cards.emitCrewmateCard("t1", { ...answer, reply: undefined }, "m");
    expect(cards.replyFromCrewmate("t1", { cardId: second, text: "Muted means a prefix." })).toBe(
      `Replied in the thread on "The chip uses separate colors" (${second}). The captain's reply under card "The chip colors distinguish prefixes" (${first}) still waits on your answer: answer it there with reply, or in that card's emit_card revision.`,
    );
    cards.close(second, { kind: "crewmate", taskId: "t1" }, "relayed");
    expect(cards.threadsAwaitingAuthor("t1").map((card) => card.id)).toEqual([first]);

    // The revision of the card the captain wrote under answers them.
    cards.emitCrewmateCard("t1", { ...answer, id: first }, "m");
    expect(cardStore.awaitingAuthor(first)).toBe(false);
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    expect(cardStore.messages(first).map((message) => message.who)).toEqual([
      "captain",
      "host",
      "crewmate",
    ]);
  });

  // INF-2255: batching the captain's roster threadStat path keeps each task's
  // open-card counts, the last written message per card, ties and card-only changes.
  it("groups current open thread metadata without mixing tasks or retaining closed cards", () => {
    const { tasks, cardStore, make } = setup();
    for (const id of ["t1", "t2", "other", "empty"])
      seedTask(tasks, { id, title: `Review ${id}`, status: "idle" });
    const cards = make();
    const add = (taskId: string, id: string) =>
      cards.emitCrewmateCard(taskId, { ...decision, id, title: `Review ${id}` }, "model");
    const first = add("t1", "first");
    const second = add("t1", "second");
    const otherTask = add("t2", "other-task");
    const unrelated = add("other", "unrelated");
    const closed = add("t1", "closed");
    add("empty", "empty");
    cardStore.appendMessage({
      cardId: first,
      who: "crewmate",
      text: "The checks passed.",
      at: 1001,
    });
    cardStore.appendMessage({ cardId: second, who: "captain", text: "Which checks?", at: 1001 });
    cardStore.appendMessage({
      cardId: otherTask,
      who: "host",
      text: "The task resumed.",
      at: 1100,
    });
    cardStore.appendMessage({
      cardId: unrelated,
      who: "captain",
      text: "Keep this separate.",
      at: 1200,
    });
    cardStore.appendMessage({
      cardId: closed,
      who: "captain",
      text: "This is answered.",
      at: 1300,
    });
    cards.close(closed, { kind: "crewmate", taskId: "t1" }, "answered elsewhere");
    tasks.readProjection(() => {
      expect(cards.threadFacts(["t1", "t2", "empty"])).toEqual(
        new Map([
          ["t1", "thread: 2 messages, last from captain"],
          ["t2", "thread: 1 message, last from host"],
        ]),
      );
      // A later-written message with an older clock still replaces this card's
      // newest message; another card can then have the latest timestamp.
      cardStore.appendMessage({
        cardId: second,
        who: "host",
        text: "A saved answer arrived.",
        at: 1000,
      });
      expect(cards.threadFact("t1")).toBe("thread: 3 messages, last from crewmate");
      cards.close(first, { kind: "crewmate", taskId: "t1" }, "answered elsewhere");
      expect(cards.threadFact("t1")).toBe("thread: 2 messages, last from host");
    });
    expect(cards.threadFacts([]).size).toBe(0);
  });

  it("writes a crewmate's thread answer only on its own card, and pushes the thread whole", () => {
    const { tasks, threads, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Other", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");

    expect(cards.replyFromCrewmate("t2", { cardId: id, text: "mine now" })).toMatch(/not yours/);
    expect(cards.replyFromCrewmate("t1", { cardId: id, text: "Left is safer." })).toMatch(
      /^Replied in the thread/,
    );
    expect(threads.at(-1)?.messages.map((message) => [message.who, message.text])).toEqual([
      ["crewmate", "Left is safer."],
    ]);
    expect(cards.threadFact("t1")).toBe("thread: 1 message, last from crewmate");
  });

  // INF-1273: an answer the first mate asks its task's crewmate for lands in
  // the thread the captain asked under, at once, not on a card of its own.
  it("takes a crewmate's answer under a first mate card on its task while the crewmate works on", () => {
    const { tasks, cardStore, threads, make } = setup();
    seedTask(tasks, { id: "build", title: "Build the Linux AppImage", status: "running" });
    seedTask(tasks, { id: "other", title: "Fix the footer", status: "running" });
    const cards = make();
    const id = cards.addFirstmateCard({
      title: "Review the AppImage before release",
      body: "<p>The AppImage builds on the Linux lane; review it before the alpha.</p>",
      actions: [
        { id: "ship", label: "Ship it", default: true },
        { id: "hold", label: "Hold" },
      ],
      taskId: "build",
    });
    cards.addMessage(id, "captain", "Does it start on a machine without FUSE?");
    cards.addMessage(id, "firstmate", "I asked crewmate 3 to answer here.");
    const pushed = threads.length;
    const before = cards.get(id);
    const taskBefore = tasks.get("build");

    expect(cards.replyFromCrewmate("other", { cardId: id, text: "Yes." })).toMatch(/not yours/);
    expect(
      cards.replyFromCrewmate("build", {
        cardId: id,
        text: "Yes: without FUSE it extracts itself and starts, which I checked in a clean container.",
      }),
    ).toMatch(/^Replied in the thread/);

    expect(threads.length).toBe(pushed + 1);
    expect(threads.at(-1)?.messages.map((message) => message.who)).toEqual([
      "captain",
      "firstmate",
      "crewmate",
    ]);
    expect(cardStore.messages(id).at(-1)?.text).toMatch(/^Yes: without FUSE/);
    expect([...cards.values()].map((card) => [card.id, card.author])).toEqual([[id, "firstmate"]]);
    expect(cards.get(id)?.actions).toEqual(before?.actions);
    expect(tasks.get("build")).toEqual(taskBefore);
    expect(taskBefore?.status).toBe("active");
  });
});

/**
 * The card evidence (docs/card-evidence.md): every card write lands its
 * observation beside it, read back through the store's typed reader.
 */
describe("CardService evidence", () => {
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
    cards.addMessage(id, "captain", "change the capacity");
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
    cards.replyFromCrewmate("t1", { cardId: id, text: "Capacity corrected." });
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
    expect(cards.recordFirstmateThreadAnswer(id, "Current answer.")).toBe(true);
    expect(cardStore.messages(id).at(-1)?.text).toBe("Current answer.");
    expect(cardStore.awaitingAuthor(id)).toBe(false);
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
    cards.addMessage(question, "captain", "keep it?");
    restart();
    expect(owed()[question]).toEqual(["captain", "author"]);
    cards.replyFromCrewmate("t1", { cardId: question, text: "Kept it." });
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

  it("tells a dismissal, a withdrawal, a take-down, a retirement and a duplicate apart", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Other", status: "idle" });
    const cards = make();
    const dismissed = cards.addFirstmateCard({ ...decision, id: "fm-d", taskId: "t1" });
    const withdrawn = cards.addFirstmateCard({ ...decision, id: "fm-w", taskId: "t1" });
    const duplicate = cards.addFirstmateCard({ ...decision, id: "fm-dup", taskId: "t1" });
    cards.addAuthDecisionCard("card-auth-x", "Codex", "Sign in again.");
    const retired = cards.emitCrewmateCard("t2", decision, "m");

    cards.dismiss(cards.shown(dismissed) as Card, { id: "gesture-0007" });
    cards.close(withdrawn, { kind: "firstmate" }, "obsolete now");
    cards.clearAuthDecisionCard("card-auth-x");
    cards.flagDuplicate({ cardId: duplicate, duplicateOf: dismissed, note: "same ask" });
    cards.retireTaskCards("t2", "merged");

    const exit = (id: string) => {
      const [only_] = only(cardStore, id, "exit");
      return [only_?.actor, only_?.source, only_?.payload.reason, only_?.payload.note ?? null];
    };
    expect(exit(dismissed)).toEqual(["captain", "close-control", "dismissed", null]);
    expect(exit(withdrawn)).toEqual(["firstmate", "tool", "author-withdrawal", "obsolete now"]);
    expect(exit("card-auth-x")).toEqual(["host", "host", "host-withdrawal", "recovered"]);
    expect(exit(duplicate)).toEqual(["firstmate", "tool", "duplicate", "same ask"]);
    expect(exit(retired)).toEqual(["host", "host", "task-retired", "merged"]);
    // None of them is a choice.
    for (const id of [dismissed, withdrawn, "card-auth-x", duplicate, retired]) {
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
    const dismissed = cards.addFirstmateCard({ ...decision, id: "fm-d", taskId: "t1" });
    clock += 10;
    const withdrawn = cards.addFirstmateCard({ ...decision, id: "fm-w", taskId: "t1" });
    clock += 10;
    const open = cards.addFirstmateCard({ ...decision, id: "fm-o", taskId: "t1" });
    clock += 10;
    // INF-500: what CrewSupervisor.act hands over when the body's own script chose.
    const scripted = cards.addFirstmateCard({ ...decision, id: "fm-s", taskId: "t1" });
    cards.resolve(cards.shown(chosen) as Card, "right", "right");
    cards.dismiss(cards.shown(dismissed) as Card);
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
      [dismissed, "closed", "decision", "Closed without choosing"],
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

    const taskless = cards.addFirstmateCard({ ...decision, id: "fm-free" });
    cards.dismiss(cards.shown(taskless) as Card);
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

    cards.dismiss(cards.shown(id) as Card);
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
    cards.addMessage(id, "captain", "Can you confirm the findings?");
    cards.addMessage(id, "crewmate", "The findings are unchanged.");
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
        effect: { kind: "settle" as const, mode: "merge" as const },
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
      body: questions,
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

    const dismissed = emit("dismissed");
    expect(cards.past(dismissed)).toBeUndefined();
    cards.dismiss(cards.shown(dismissed) as Card);
    expect(cards.past(dismissed)?.ending).toMatchObject({ how: "dismissed", by: "captain" });

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

describe("revision link publication", () => {
  it("keeps each immediate-predecessor list through batching, close-out and restart", () => {
    const { tasks, make, cardStore } = setup();
    seedTask(tasks, { id: "revisions", title: "Review", status: "idle" });
    const cards = make();
    const base =
      "<h2>Context</h2><p>A</p><p>B</p><p>C</p><h2>Sign-in</h2><p>Old account</p><h2>Checks</h2><p>Old checks</p>";
    const id = cards.emitCrewmateCard("revisions", { ...decision, body: base }, "Review", "model");
    cards.closeOut({ kind: "crewmate", taskId: "revisions" }, "report");
    const first = cards.get(id)?.offerId;
    cards.addMessage(id, "captain", "Check these");
    cards.emitCrewmateCard(
      "revisions",
      { ...decision, id, body: base.replace("Old account", "Connected"), reply: "Done." },
      "Review",
      "model",
    );
    const second = cards.get(id)?.offerId;
    cards.emitCrewmateCard(
      "revisions",
      {
        ...decision,
        id,
        body: base.replace("Old account", "Connected").replace("Old checks", "Passed"),
      },
      "Review",
      "model",
    );
    const pending = cards.thread(id).messages.filter((m) => m.revision);
    expect(pending.map((m) => m.revision?.released)).toEqual([false, false]);
    expect(pending.map((m) => m.revision?.previousOfferId)).toEqual([first, second]);
    expect(pending.map((m) => m.revision?.targets.map((t) => t.label))).toEqual([
      ["Sign-in"],
      ["Checks"],
    ]);
    cards.closeOut({ kind: "crewmate", taskId: "revisions" }, "idle");
    const released = cards.thread(id).messages.filter((m) => m.revision);
    expect(released.map((m) => m.revision?.released)).toEqual([true, true]);
    expect(released.every((m) => m.revisionShown?.offerId === cards.get(id)?.offerId)).toBe(true);
    const savedThread = cards.thread(id);
    cards.dispose();
    const restored = make();
    expect(restored.thread(id)).toEqual(savedThread);
    expect(
      cardStore
        .messages(id)
        .filter((m) => m.revision)
        .map((m) => m.revision?.targets),
    ).toEqual(released.map((m) => m.revision?.targets));
    restored.dispose();
  });
  it("releases lists at a restart close-out and never invents links for legacy messages", () => {
    const { make, cardStore } = setup();
    const cards = make();
    const id = cards.addFirstmateCard({ ...decision, id: "revision-restart" });
    cards.addMessage(id, "host", "Legacy line");
    cards.addFirstmateCard({ ...decision, id, body: "<p>Changed</p>" });
    expect(cards.thread(id).messages.at(-1)?.revision?.released).toBe(false);
    cards.dispose();
    const restarted = make();
    expect(restarted.thread(id).messages.at(-1)?.revision?.released).toBe(true);
    expect(cardStore.messages(id)[0]?.revision).toBeUndefined();
    restarted.dispose();
  });
});
