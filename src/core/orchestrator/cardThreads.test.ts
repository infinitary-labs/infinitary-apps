import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { seedTask } from "../tasks/seedTask";

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

  // The captain's choice on handoff-ends-question: "Only a line that says it
  // answers it; a handoff stays open".
  it("takes the Firstmate's closing words under a note its closed task kept as a line that leaves the wait, and its named reply clears it", () => {
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
    const version = cards.addMessage(note, "captain", "and the version?");
    expect(cards.snapshot().find((card) => card.id === note)?.awaiting).toBe("answer");
    expect(cards.recordFirstmateThreadAnswer(note, "I asked a crewmate to check.")).toBe(true);
    expect(cards.thread(note).messages.map((message) => message.who)).toEqual([
      "captain",
      "captain",
      "firstmate",
    ]);
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot().find((card) => card.id === note)?.awaiting).toBe("answer");
    // Its next turn's closing words add nothing beside its own line.
    expect(cards.recordFirstmateThreadAnswer(note, "Still checking.")).toBe(false);
    cards.replyAs(
      { actor: "firstmate" },
      { cardId: note, text: "It is in 0.2.", answersMessage: version.id },
    );
    cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(cards.snapshot().find((card) => card.id === note)?.awaiting).toBeUndefined();
    expect(cards.thread(note).messages.at(-1)).toMatchObject({
      who: "firstmate",
      answersMessage: version.id,
    });
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
    const inconsistent = cards.addMessage(first, "captain", "that seems inconsistent");
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
      `Replied in the thread on "The chip uses separate colors" (${second}). The captain's reply under card "The chip colors distinguish prefixes" (${first}) still waits on your answer: answer it there with reply, or in that card's emit_card revision, naming their message in answers_message.`,
    );
    cards.close(second, { kind: "crewmate", taskId: "t1" }, "relayed");
    expect(cards.threadsAwaitingAuthor("t1").map((card) => card.id)).toEqual([first]);

    // The revision of the card the captain wrote under answers them.
    cards.emitCrewmateCard("t1", { ...answer, id: first, answersMessage: inconsistent.id }, "m");
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

  // INF-2214's approved shared cards: another task's crewmate writes on the
  // card with no grant, recorded as itself; the card's own answerer is unchanged.
  it("takes another task's crewmate's line with its true writer, and pushes the thread whole", () => {
    const { tasks, threads, make } = setup();
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Other", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", decision, "m");
    const other = tasks.get("t2")?.key;

    expect(cards.replyFromCrewmate("t2", { cardId: id, text: "Right is cheaper." })).toBe(
      `Wrote on the thread of card "${decision.title}" (${id}) as the crewmate on ${other}. Your line is message 1, a comment; it ends no question. The card itself is unchanged (title, body, choices).`,
    );
    expect(cards.replyFromCrewmate("t1", { cardId: id, text: "Left is safer." })).toMatch(
      /^Replied in the thread/,
    );
    expect(
      threads.at(-1)?.messages.map((message) => [message.who, message.text, message.contributor]),
    ).toEqual([
      [
        "crewmate",
        "Right is cheaper.",
        { actor: "crewmate", taskId: "t2", label: `the crewmate on ${other}` },
      ],
      ["crewmate", "Left is safer.", undefined],
    ]);
    expect(cards.get(id)?.taskId).toBe("t1");
    expect(cards.threadFact("t1")).toBe("thread: 2 messages, last from crewmate");
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

    // INF-2214: another task's crewmate may write here too, as itself, and
    // ends no question it does not name.
    expect(cards.replyFromCrewmate("other", { cardId: id, text: "I have not tried it." })).toMatch(
      /^Wrote on the thread of card .* as the crewmate on .*a comment; it ends no question\./,
    );
    expect(
      cards.replyFromCrewmate("build", {
        cardId: id,
        text: "Yes: without FUSE it extracts itself and starts, which I checked in a clean container.",
      }),
    ).toMatch(/^Replied in the thread/);

    expect(threads.length).toBe(pushed + 2);
    expect(
      threads.at(-1)?.messages.map((message) => [message.who, message.contributor?.taskId]),
    ).toEqual([
      ["captain", undefined],
      ["firstmate", undefined],
      ["crewmate", "other"],
      ["crewmate", undefined],
    ]);
    expect(cardStore.messages(id).at(-1)?.text).toMatch(/^Yes: without FUSE/);
    expect([...cards.values()].map((card) => [card.id, card.author])).toEqual([[id, "firstmate"]]);
    expect(cards.get(id)?.actions).toEqual(before?.actions);
    expect(tasks.get("build")).toEqual(taskBefore);
    expect(taskBefore?.status).toBe("active");
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
    const check = cards.addMessage(id, "captain", "Check these");
    cards.emitCrewmateCard(
      "revisions",
      {
        ...decision,
        id,
        body: base.replace("Old account", "Connected"),
        reply: "Done.",
        answersMessage: check.id,
      },
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
        reply: "Checks passed.",
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
