import {
  type Card,
  isStoryNote,
  MERGE_CLOSES_WORDS,
  onStage,
  SETTLE_FACTS_OPEN,
  withMergeClosesLine,
} from "@shared/cards";
import { currentCheckSummary } from "@shared/checkSnapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import type { CardService } from "./cardService";

/** A crewmate's whole risk declaration, as a saved story carries it. */
const STORY_RISK: Card["risk"] = {
  declared: {
    blast: { level: "low", why: "Two files in the meter" },
    behavior: { level: "low", why: "Corrects the unit" },
    undo: { level: "low", why: "A revert restores the old meter" },
    evidence: { level: "medium", why: "The meter test" },
    sensitivity: { level: "low", why: "No sign-in, data or release code" },
    novelty: { level: "low", why: "Edits the existing reading" },
    deps: { level: "low", why: "Nothing added" },
  },
};

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
    tasks.capture.openAsk({ id: "reading-ask", text: "How could a reading-style feature work?" });
    tasks.capture.attachAsk("reading-ask", "reading", "tool:spawn_crewmate");
    let interrupt = true;
    const cards = make(undefined, (card, response, action) => {
      expect(db.inTransaction).toBe(true);
      expect({ response, action }).toEqual({ response: "choice", action: "start" });
      tasks.capture.acceptAnswer(["reading-ask"], card.id);
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
    expect(tasks.capture.getAsk("reading-ask")?.acceptedAt).toBeNull();
    expect(cardStore.chosenAction(id)).toBeUndefined();
    expect(cards.get(id)).toBeDefined();
    interrupt = false;
    cards.resolve(card, "start", "start", answers);
    expect(tasks.capture.getAsk("reading-ask")?.answerCardId).toBe(id);
    expect(cardStore.past(id)?.answers).toEqual(answers);
    expect(cardStore.chosenAction(id)).toBe("start");
    cards.dispose();
  });

  // INF-1879 sweep regression / INF-1677: reading a completed workspace
  // build's answer still acknowledges its message, without ending any task.
  it("acknowledges a completed panel build's read note without changing its task", () => {
    const { db, tasks, make } = setup();
    seedTask(tasks, {
      id: "panel",
      title: "Build the Tokyo clock panel",
      status: "running",
      shape: { kind: "implement", deliverable: "change" },
    });
    tasks.capture.openAsk({ id: "panel-ask", text: "Make me a Tokyo clock panel." });
    tasks.capture.attachAsk("panel-ask", "panel", "tool:spawn_crewmate");
    const cards = make(undefined, (card, response) => {
      expect(db.inTransaction).toBe(true);
      expect(response).toBe("close");
      tasks.capture.acceptAnswer(["panel-ask"], card.id);
    });
    try {
      const id = cards.emitCrewmateCard(
        "panel",
        {
          title: "The Tokyo clock panel is ready",
          body: "<p>The panel shows the time in Tokyo beside your activity.</p>",
          answering: true,
          actions: [],
        },
        "model",
      );
      cards.closeOut({ kind: "crewmate", taskId: "panel" }, "report");
      tasks.close("panel", { status: "done", reason: "finished", actor: "host" });
      const completed = tasks.get("panel");
      expect(tasks.capture.getAsk("panel-ask")?.acceptedAt).toBeNull();
      cards.dismiss(cards.get(id) as Card);
      expect(tasks.capture.getAsk("panel-ask")?.answerCardId).toBe(id);
      expect(tasks.get("panel")).toEqual(completed);
    } finally {
      cards.dispose();
    }
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
    const about = vi.spyOn(tasks.capture, "originAbout");
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
    tasks.capture.openAsk({
      id: "ask-footer",
      text: "the footer overlaps the composer\n\non small windows",
    });
    tasks.capture.attachAsk("ask-footer", "footer", "tool:spawn_crewmate");
    const crewCard = cards.emitCrewmateCard(
      "footer",
      { ...decision, id: "footer-choice", body: "<p>Why: you asked about something else.</p>" },
      "m",
    );
    // The first mate's answer is filed as a question the message attaches to.
    tasks.capture.openAsk({ id: "ask-port", text: "what does the port flag do?" });
    const answer = cards.addFirstmateCard({
      title: "It picks the port",
      body: "<p>It picks the port.</p>",
      actions: [],
      answering: true,
    });
    tasks.capture.fileQuestion({
      id: "q-port",
      title: "The port flag",
      outcome: "It picks the port.",
      cardId: answer,
    });
    tasks.capture.attachAsk("ask-port", "q-port", "tool:emit_card");
    const unasked = cards.addFirstmateCard({
      title: "The nightly check failed",
      body: "<p>It failed.</p>",
      actions: [],
    });
    const shown = new Map(cards.snapshot().map((card) => [card.id, card]));
    expect(shown.get(crewCard)?.asked).toEqual({
      at: tasks.capture.getAsk("ask-footer")?.at,
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
      tasks.delivery.recordChangeEvidence("builder", {
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
    const why = cards.addMessage(id, "captain", "Why Friday?");
    cards.replyFromCrewmate("launch", {
      cardId: id,
      text: "Friday keeps the review beside it.",
      answersMessage: why.id,
    });
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
    // The refreshed facts keep the app's closes-or-continues line (INF-2490).
    expect(cards.get(id)?.body).toBe(
      `<p>New author body.</p>${withMergeClosesLine(facts(), input.actions)}`,
    );
    expect(cardStore.get(id)?.body).toBe(cards.get(id)?.body);
    expect(cards.thread(id).messages.length).toBe(before);
    expect(cards.revisionChanges(id)).toEqual(changes);
    cards.dispose();
    seedDelivery(tasks, "t1", { ci: "green", ciAt: 2000 });
    // No card service was alive to hear the mutation; boot re-stamps it.
    expect(cardStore.get(id)?.body).toContain("red");
    expect(make(facts).snapshot()[0]?.body).toContain("green");
  });

  it("keeps a card the captain replied under off the stage across a restart, which closes every author out", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const before = make();
    const asked = before.emitCrewmateCard("t1", decision, "m");
    before.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const question = before.addMessage(asked, "captain", "why not left?");
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
    after.replyFromCrewmate("t1", {
      cardId: asked,
      text: "Left races the queue.",
      answersMessage: question.id,
    });
    expect(after.get(asked)?.awaiting).toBe("close-out");
    after.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(after.snapshot().find((card) => card.id === asked)?.awaiting).toBe("close-out");
    after.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(after.snapshot().find((card) => card.id === asked)?.awaiting).toBeUndefined();
  });

  // INF-2533, the captain's words: "we should probably not show the note
  // card and wait for the final update with "merged on its own" already
  // present". The story note of a task that merges on its own stays in its
  // close-out wait while its merge is still to come - through its author's
  // close-outs and a restart - and shows once, after the close wrote its
  // merged line on it.
  it("holds a self-merging task's story note until its merge, then shows it once with its merged line (INF-2533)", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    let merged = false;
    const holdsUntilMerge = (card: Card, merging?: boolean) =>
      isStoryNote(card) && (merging === true || !merged);
    const before = make(undefined, undefined, { holdsUntilMerge });
    const note = before.emitCrewmateCard(
      "t1",
      {
        title: "The meter reads on time",
        body: "<p>The story.</p>",
        actions: [],
        risk: STORY_RISK,
      },
      "m",
    );
    // A question of the same crewmate is not held.
    const asked = before.emitCrewmateCard("t1", decision, "m");
    before.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    before.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(before.get(note)?.awaiting).toBe("close-out");
    expect(before.get(asked)?.awaiting).toBeUndefined();

    const after = make(undefined, undefined, { holdsUntilMerge });
    expect(after.get(note)?.awaiting).toBe("close-out");
    expect(onStage(after.snapshot().find((card) => card.id === note) as Card)).toBe(false);

    // The merge closes the task: the close keeps the note, writes its line, then shows it.
    merged = true;
    after.retireTaskCards("t1", "merged", { keepNotes: true });
    expect(after.get(note)?.awaiting).toBe("close-out");
    after.reviseBody(note, "<p>Merged on its own at 2:03 PM</p><p>The story.</p>");
    after.releaseNotes("t1");
    const shown = after.snapshot().find((card) => card.id === note) as Card;
    expect(shown.awaiting).toBeUndefined();
    expect(shown.body).toContain("Merged on its own at 2:03 PM");
    expect(
      tasks.timeline("t1").filter((event) => event.kind === "card_raised" && event.ref === note),
    ).toHaveLength(1);
  });

  // INF-2533: a merge that keeps the task open has a result too, so the held
  // note shows then, revised first.
  it("shows a held story note when a merge keeps its task open (INF-2533)", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    const cards = make(undefined, undefined, {
      // The merge that keeps the task open is under way: it is still to come.
      holdsUntilMerge: (card) => isStoryNote(card),
    });
    const note = cards.emitCrewmateCard(
      "t1",
      {
        title: "The meter reads on time",
        body: "<p>The story.</p>",
        actions: [],
        risk: STORY_RISK,
      },
      "m",
    );
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.get(note)?.awaiting).toBe("close-out");
    cards.showHeld("t1", (body) => `<p>Merged · ${MERGE_CLOSES_WORDS.continues}.</p>${body}`);
    expect(cards.get(note)?.awaiting).toBeUndefined();
    expect(cards.get(note)?.body).toContain(MERGE_CLOSES_WORDS.continues);
  });

  // INF-2525, the captain's words: "if they both got raised, then we should
  // make sure the merge card doesn't close the task directly". The merge
  // card's line says the task continues while a question is open beside it,
  // and changes back when that question closes.
  it("says on a merge card that the task continues while a question on the task is open (INF-2525)", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    const cards = make();
    const merge = cards.emitCrewmateCard(
      "t1",
      {
        title: "Ready to merge",
        body: "<p>The change is ready.</p>",
        actions: [
          { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
        ],
      },
      "m",
    );
    expect(cards.get(merge)?.body).toContain(MERGE_CLOSES_WORDS.closes);
    const asked = cards.emitCrewmateCard("t1", decision, "m");
    expect(cards.get(merge)?.body).toContain(MERGE_CLOSES_WORDS.continues);
    expect(cards.get(merge)?.body).not.toContain(MERGE_CLOSES_WORDS.closes);
    cards.resolve(cards.get(asked) as Card, "left", "left");
    expect(cards.get(merge)?.body).toContain(MERGE_CLOSES_WORDS.closes);
  });

  it("pushes the captain's reply at once, so an answer inside the push window still ends a wait the window saw", () => {
    const { pushes, make } = setup();
    const cards = make();
    const id = cards.addFirstmateCard(decision);
    vi.runAllTimers();
    pushes.length = 0;
    const waits = () => pushes.map((push) => push.find((card) => card.id === id)?.awaiting);

    const fourth = cards.addMessage(id, "captain", "and the fourth?");
    // No timer has run: the window already has the card waiting on its answer.
    expect(waits()).toEqual(["answer"]);
    cards.addFirstmateCard({
      ...decision,
      id,
      reply: "There is no fourth.",
      answersMessage: fourth.id,
    });
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    vi.runAllTimers();
    expect(waits()).toEqual(["answer", undefined]);
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

    const question = cards.addMessage(asked, "captain", "why not left?");
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
    restored.replyFromCrewmate("t1", {
      cardId: asked,
      text: "Left races the queue.",
      answersMessage: question.id,
    });
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

  it("INF-1879: keeps a replied-under decision open while put away and returns its answer at close-out", () => {
    const { tasks, make, cardStore } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    const question = cards.addMessage(id, "captain", "why not left?");
    cards.dismiss(cards.shown(id) as Card);
    expect(cards.shown(id)?.minimized).toBe(true);
    expect(cardStore.chosenAction(id)).toBeUndefined();
    cards.emitCrewmateCard(
      "t1",
      { ...decision, id, body: "<p>Left races the queue.</p>", reply: "Left races the queue." },
      "m",
    );
    cards.replyFromCrewmate("t1", {
      cardId: id,
      text: "Left races the queue.",
      answersMessage: question.id,
    });
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.shown(id)).toMatchObject({ body: "<p>Left races the queue.</p>" });
    expect(cards.shown(id)?.minimized).toBeUndefined();
    expect(cardStore.listOpen().map((card) => card.id)).toEqual([id]);
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
});
