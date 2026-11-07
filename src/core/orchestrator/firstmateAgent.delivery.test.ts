import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import type { Card } from "@shared/cards";
import { parseServedInput } from "@shared/servedFrame";
import { describe, expect, it, vi } from "vitest";
import {
  crewCard,
  decodeContext,
  drained,
  fakeClockEachTest,
  notesBinding,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { jpegImage, pngImage } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { pageTaskField, readPagedTaskQuery } from "../../../tests/helpers/taskQueryText";
import { attachmentPath } from "../attachments";
import {
  FileIntegrationSecrets,
  IntegrationSettingsStore,
  IntegrationsService,
} from "../integrations";
import { initOverflowDir, type MessageFile, withPastedFiles } from "../overflow";
import { parseTasksQueryText } from "../pi/taskTools";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { taskResolutionBody } from "../tasks/taskQuery";
import { ANSWER_ONLY_REFUSAL } from "./answerDelivery";
import { ANSWER_MISSING_OPENING } from "./captainWakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: answer delivery (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

/**
 * The answer-delivery check (docs/task-capture.md "Answer delivery"): for
 * each captain message, did an action take effect after Firstmate read it?
 * The scripted model here is silent unless a test has it act, so each test
 * says what took effect and what the host did about the rest.
 */
describe("FirstmateAgent answer delivery", () => {
  type Fixture = ReturnType<typeof setup>;
  const finish = async (f: Fixture, text = "Noted.") => {
    f.session.emitTurnEnd(text);
    f.session.resolveNextPrompt();
    await tick();
  };
  const states = (f: Fixture) => f.tasks.capture.listAsks().map((ask) => ask.delivery);
  const note = (id: string, title: string) => ({
    id,
    title,
    body: "<p>Here is the answer.</p>",
  });
  const noticeOf = (f: Fixture) =>
    f.supervisor.cards.snapshot().find((card) => card.id.startsWith("card-ask-"));
  const retries = (f: Fixture) =>
    f.session.prompts.filter((prompt) => prompt.includes(ANSWER_MISSING_OPENING));

  it("covers a message a card was shown for, with no retry and no notice", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("what is two plus two?");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("four", "Four"));
    await finish(f);
    expect(states(f)).toEqual(["covered"]);
    expect(f.session.prompts).toHaveLength(1);
    expect(new InboxStore(f.db).allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    expect(noticeOf(f)).toBeUndefined();
  });

  // INF-1108: the first mate's held integration call raises the app's own
  // approval card, so the message it answered is covered by that card.
  it("covers a message the app raised an integration approval card for, on that card's row", async () => {
    const f = setup({
      silent: true,
      integrations: (supervisor) =>
        new IntegrationsService({
          bindings: [notesBinding()],
          store: new IntegrationSettingsStore(scratchDir("infinitary-agent-integrations-")),
          secrets: new FileIntegrationSecrets(scratchDir("infinitary-agent-integration-keys-")),
          asks: {
            keep: (taskId, ask) => f.tasks.delivery.keepWriteAsk(taskId, ask),
            keepForFirstmate: (ask) => supervisor.integrationAsks.askIntegrationForFirstmate(ask),
            take: (taskId, askId) => f.tasks.delivery.takeWriteAsk(taskId, askId),
            record: (taskId, askId, outcome) =>
              f.tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
          },
        }),
    });
    await f.agent.converse("add my library books reminder to Notes");
    const held = await toolsOf(f.specs)
      .get("use_integration")
      ?.execute("u1", {
        name: "Notes",
        action: "add_note",
        input: { text: "Return the library books by Friday" },
        reason: "The captain asked me to remember the library books.",
      });
    expect(held?.content[0]?.text).toContain("The app raised its approval card");
    await finish(f, "The app is asking you on its card.");
    expect(states(f)).toEqual(["covered"]);
    expect(retries(f)).toEqual([]);
    const card = f.supervisor.cards
      .snapshot()
      .find((shown) => shown.id.startsWith("integration-ask-"));
    expect(card).toBeDefined();
    expect(f.tasks.capture.listAsks()[0]?.taskId).toBe(
      f.tasks.capture.openCardTaskFor(card?.id ?? "")?.id,
    );
  });

  it("counts a steer the app only saved for a held account as an action", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    vi.spyOn(f.supervisor.steer, "steerCrewmate").mockResolvedValue("recorded-held");
    await f.agent.converse("tell the crew to use cursors");
    const steered = await toolsOf(f.specs)
      .get("steer_crewmate")
      ?.execute("s1", { task_id: "t1", message: "Use cursors." });
    expect(steered?.content[0]?.text).toBeDefined();
    await finish(f);
    expect(states(f)).toEqual(["covered"]);
    expect(f.session.prompts).toHaveLength(1);
  });

  it("does not count a lookup or closing words: one output-only retry, served alone, then covered by an answer", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    const steer = vi.spyOn(f.supervisor.steer, "steerCrewmate");
    await f.agent.converse("how is pagination going?");
    const tools = toolsOf(f.specs);
    await tools.get("tasks")?.execute("q1", {});
    // An operational wake that arrives meanwhile is not carried on the retry.
    notifyProse(f.db, f.agent, "[fm-op] a different thing happened", "agent");
    await finish(f, "It is going well.");
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain(ANSWER_MISSING_OPENING);
    expect(f.session.prompts[1]).toContain("how is pagination going?");
    expect(f.session.prompts[1]).not.toContain("a different thing happened");
    expect(states(f)).toEqual(["retrying"]);
    expect(f.session.thinkingLevels.at(-1)).toBe("medium");

    // Every tool that changes work or settings answers with a refusal.
    for (const [name, params] of [
      ["steer_crewmate", { task_id: "t1", message: "go" }],
      ["update_task", { task: "t1", title: "Renamed" }],
      [
        "record_knowledge",
        { action: "publish", request_id: "x", kind: "concept", title: "y", text: "told" },
      ],
    ] as const) {
      const refused = await tools.get(name)?.execute(`r-${name}`, params);
      expect(refused?.content[0]?.text).toBe(ANSWER_ONLY_REFUSAL);
    }
    expect(steer).not.toHaveBeenCalled();
    expect(f.tasks.get("t1")?.title).toBe("Add pagination");

    await tools.get("emit_card")?.execute("c1", {
      ...note("pagination-on-track", "Pagination is on track"),
      related: ["t1"],
    });
    await finish(f);
    expect(states(f)).toEqual(["covered"]);
    expect(noticeOf(f)).toBeUndefined();
    // The other wake is served next, on its own.
    await drained(f.session, 3);
    expect(f.session.prompts[2]).toContain("a different thing happened");
    expect(f.session.prompts[2]).not.toContain(ANSWER_MISSING_OPENING);
  });

  it("does not count a refused card or a reaction after it, names the card that owns the work, and raises one notice when the retry fails too", async () => {
    const f = setup({
      silent: true,
      seedTasks: [{ id: "t58", title: "Check if PR 58 merged", status: "idle" }],
      seedCards: [crewCard("card-t58-1", "t58", "PR 58 is merged", "Already shown.")],
    });
    await f.agent.converse({ text: "is PR 58 merged? <b>now</b>", taskId: "t58" });
    const tools = toolsOf(f.specs);
    await expect(
      tools.get("emit_card")?.execute("c1", {
        title: "PR 58 is merged",
        body: "<p>Restating.</p>",
        related: ["t58"],
      }),
    ).rejects.toThrow(/emit_card with id card-t58-1/);
    await tools.get("emote")?.execute("e1", { emote: "nod" });
    await finish(f, "SECRET closing words <script>alert(1)</script>");
    await drained(f.session, 2);
    expect(states(f)).toEqual(["retrying"]);
    // Shared cards (INF-2214): the retry names the card to write on.
    expect(f.session.prompts[1]).toContain(
      "the crewmate's card card-t58-1 is already on screen for that work: write on it with emit_card and its id",
    );

    // The retry shows nothing either: one notice, and no second retry.
    await finish(f, "Still nothing.");
    await vi.waitFor(() => expect(noticeOf(f)).toBeDefined());
    const ask = f.tasks.capture.listAsks()[0];
    const notice = noticeOf(f);
    expect(notice).toMatchObject({
      id: `card-ask-${ask?.id}`,
      author: "host",
      title: "Your first mate has not answered your message",
    });
    expect(notice?.actions.map((action) => action.id)).toEqual(["ask-again", "leave-it"]);
    expect(notice?.body).toContain("is PR 58 merged? &lt;b&gt;now&lt;/b&gt;");
    expect(notice?.body).not.toContain("SECRET");
    expect(JSON.stringify(f.supervisor.cards.snapshot())).not.toContain("SECRET");
    expect(ask).toMatchObject({ delivery: "unresolved", noticeCardId: `card-ask-${ask?.id}` });
    expect(retries(f)).toHaveLength(1);
    f.agent.pokeInbox();
    await tick();
    expect(f.session.prompts).toHaveLength(2);
  });

  // The refusal above sends the first mate to the crewmate's card,
  // shown before the message; its line in that card's thread is its answer.
  it("ends a message the first mate answered in the thread of a crewmate's card already up, with no retry and no notice", async () => {
    const f = setup({
      silent: true,
      seedTasks: [{ id: "t58", title: "Check if PR 58 merged", status: "idle" }],
      seedCards: [crewCard("card-t58-1", "t58", "PR 58 is merged", "Already shown.")],
    });
    vi.advanceTimersByTime(1_000);
    await f.agent.converse("is PR 58 merged?");
    const tools = toolsOf(f.specs);
    await expect(
      tools.get("emit_card")?.execute("c1", {
        title: "PR 58 is merged",
        body: "<p>Restating.</p>",
        related: ["t58"],
      }),
    ).rejects.toThrow(/emit_card with id card-t58-1/);
    const written = await tools.get("emit_card")?.execute("c2", {
      id: "card-t58-1",
      title: "PR 58 is merged",
      body: "<p>Already shown.</p>",
      reply: "Yes, PR 58 merged this morning.",
    });
    expect(written?.content[0]?.text).toContain('Wrote on the thread of card "PR 58 is merged"');
    await finish(f, "Answered on its card.");
    await tick();

    const ask = f.tasks.capture.listAsks()[0];
    expect(ask).toMatchObject({ delivery: "covered", answerCardId: "card-t58-1" });
    expect(ask?.answeredAt).not.toBeNull();
    expect(retries(f)).toEqual([]);
    expect(noticeOf(f)).toBeUndefined();
    expect(f.supervisor.cards.thread("card-t58-1").messages.map((line) => line.who)).toContain(
      "firstmate",
    );
  });

  it("sends the message again on Ask again as a fresh linked turn with the same hint, and Leave it runs nothing", async () => {
    const f = setup({
      silent: true,
      seedTasks: [{ id: "t58", title: "Check if PR 58 merged", status: "idle" }],
    });
    await f.agent.converse({ text: "is PR 58 merged?", taskId: "t58" });
    await finish(f);
    await drained(f.session, 2);
    await finish(f);
    await vi.waitFor(() => expect(noticeOf(f)).toBeDefined());
    const first = f.tasks.capture.listAsks()[0];
    const prompts = f.session.prompts.length;

    f.supervisor.cardActions.act(`card-ask-${first?.id}`, "leave-it");
    await tick();
    expect(f.session.prompts).toHaveLength(prompts);
    expect(noticeOf(f)).toBeUndefined();
    expect(f.tasks.capture.getAsk(first?.id ?? "")?.delivery).toBe("unresolved");

    // Ask again on a second notice (the first is gone): a fresh turn, linked.
    const g = setup({
      silent: true,
      seedTasks: [{ id: "t58", title: "Check if PR 58 merged", status: "idle" }],
    });
    initOverflowDir(scratchDir("infinitary-retry-files-"));
    const messageFiles: MessageFile[] = [];
    withPastedFiles("", [{ name: "notes.txt", text: "Check the attached result." }], messageFiles);
    await g.agent.converse({ text: "is PR 58 merged?", taskId: "t58", messageFiles });
    await finish(g);
    await drained(g.session, 2);
    await finish(g);
    await vi.waitFor(() => expect(noticeOf(g)).toBeDefined());
    const original = g.tasks.capture.listAsks()[0];
    g.supervisor.cardActions.act(`card-ask-${original?.id}`, "ask-again");
    await vi.waitFor(() => expect(g.session.prompts).toHaveLength(3));
    expect(g.session.prompts[2]).toContain("[user]\nis PR 58 merged?");
    const again = g.tasks.capture.listAsks().at(-1);
    expect(again?.id).not.toBe(original?.id);
    expect(again).toMatchObject({
      text: "is PR 58 merged?",
      messageFiles,
      hintTaskId: "t58",
      delivery: "pending",
      deliveryFacts: { retryOf: original?.id },
    });
    expect(noticeOf(g)).toBeUndefined();
    // The original stays unresolved, and is never retried or noticed again.
    expect(g.tasks.capture.getAsk(original?.id ?? "")?.delivery).toBe("unresolved");
  });

  // INF-2664, the captain's recorded case: they chose on the first mate's
  // card 0.4 seconds before its reply finished, the click's step started the
  // work, and that work's crewmate card answered them - yet the notice went up.
  it("counts a choice made before the reply finishes, and the card of work named for the message as its answer (INF-2664)", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("why is my mac mini having memory pressure warning?");
    const ask = f.tasks.capture.listAsks()[0];
    const shown = await toolsOf(f.specs)
      .get("emit_card")
      ?.execute("c1", {
        title: "Memory pressure on the Mac mini has two likely causes",
        body: "<p>A file indexer or a build is holding the most memory.</p>",
        actions: [
          { id: "find", label: "Find what's using the memory", default: true },
          { id: "wait", label: "Leave it for now" },
        ],
      });
    const cardId = shown?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    // The captain's choice lands while the reply that showed the card still runs.
    f.supervisor.cardActions.act(cardId, "find");
    expect(f.tasks.capture.getAsk(ask?.id ?? "")?.answerCardId).toBe(cardId);
    await finish(f, "Here is what I found.");
    await drained(f.session, 2);
    expect(retries(f)).toEqual([]);

    // The click's step names the message on the work it starts.
    const started = await toolsOf(f.specs).get("spawn_crewmate")?.execute("s1", {
      title: "Find what is using the Mac mini's memory",
      goal: "Name the process holding the memory and how to relieve it",
      user_words: "Find what's using the memory",
      ask_id: ask?.id,
    });
    expect(started?.content[0]?.text).toContain("Commissioned");
    await vi.waitFor(() => expect(f.crewSpecs).toHaveLength(1));
    await finish(f, "Started.");
    expect(retries(f)).toEqual([]);
    expect(noticeOf(f)).toBeUndefined();

    // Its crewmate's answering card is the answer the captain chooses on.
    const work = f.tasks.list().find((task) => task.title.startsWith("Find what is using"));
    await f.crewSpecs[0]?.callbacks?.onCard?.({
      title: "A file indexer holds most of the memory",
      body: "<p>Pausing it relieves the pressure.</p>",
      answering: true,
      actions: [
        { id: "pause", label: "Pause the indexer", default: true },
        { id: "keep", label: "Keep it running" },
      ],
    });
    // Its report puts the card on the stage.
    await f.crewSpecs[0]?.tools
      ?.find((tool) => tool.name === "report")
      ?.run({ text: "The indexer holds the memory.", summary: "Found the indexer." });
    const answer = f.supervisor.cards.openCardsFor(work?.id ?? "")[0]?.id ?? "";
    f.supervisor.cardActions.act(answer, "pause");
    expect(f.tasks.capture.getAsk(ask?.id ?? "")?.answerCardId).toBe(answer);
    expect(retries(f)).toEqual([]);
    expect(noticeOf(f)).toBeUndefined();
  });

  it("takes the notice back when an answering card of the message's work goes up, and raises the same notice if it goes unanswered again (INF-2664)", async () => {
    const f = setup({
      silent: true,
      seedTasks: [{ id: "t58", title: "Check if PR 58 merged", status: "idle" }],
    });
    await f.agent.converse({ text: "is PR 58 merged?", taskId: "t58" });
    await finish(f);
    await drained(f.session, 2);
    await finish(f);
    await vi.waitFor(() => expect(noticeOf(f)).toBeDefined());
    const ask = f.tasks.capture.listAsks()[0];
    const notice = `card-ask-${ask?.id}`;

    // A later step names the message, its notice up, on the work it starts.
    notifyProse(f.db, f.agent, "[fm-op] a crewmate reported on PR 58", "agent");
    await drained(f.session, 3);
    await toolsOf(f.specs).get("spawn_crewmate")?.execute("s1", {
      title: "Check whether PR 58 merged",
      goal: "Say whether PR 58 merged",
      user_words: "is PR 58 merged?",
      ask_id: ask?.id,
    });
    await vi.waitFor(() => expect(f.crewSpecs).toHaveLength(1));
    await finish(f);
    expect(noticeOf(f)?.id).toBe(notice);

    // Its crewmate's answering card takes the notice back once it reaches
    // the stage: while it is held for the crewmate's close-out, the captain
    // sees neither, so the notice stays up.
    const work = f.tasks.list().find((task) => task.title === "Check whether PR 58 merged");
    await f.crewSpecs[0]?.callbacks?.onCard?.({
      title: "PR 58 merged",
      body: "<p>It merged into main.</p>",
      answering: true,
      actions: [
        { id: "close-out", label: "Close it out", default: true },
        { id: "recheck", label: "Check again tomorrow" },
      ],
    });
    const crewCard = () =>
      f.supervisor.cards
        .snapshot()
        .find((card) => card.taskId === work?.id && card.title === "PR 58 merged");
    expect(crewCard()?.awaiting).toBe("close-out");
    expect(noticeOf(f)?.id).toBe(notice);
    await f.crewSpecs[0]?.tools
      ?.find((tool) => tool.name === "report")
      ?.run({ text: "PR 58 merged.", summary: "PR 58 merged." });
    expect(crewCard()?.awaiting).toBeUndefined();
    expect(noticeOf(f)).toBeUndefined();
    expect(f.tasks.capture.getAsk(ask?.id ?? "")?.delivery).toBe("covered");

    // The approved minus rule preserves this unanswered decision and its coverage.
    const answerId = f.supervisor.cards.openCardsFor(work?.id ?? "")[0]?.id ?? "";
    f.tasks.close(work?.id ?? "", { status: "done", reason: "answered", actor: "host" });
    f.supervisor.close(answerId);
    expect(f.supervisor.cards.snapshot().find((card) => card.id === answerId)).toMatchObject({
      minimized: true,
    });
    expect(f.tasks.capture.getAsk(ask?.id ?? "")?.delivery).toBe("covered");
    expect(noticeOf(f)).toBeUndefined();
    // Notice retraction requires a genuinely absent answering card. Its author
    // withdraws the unanswered offer; no captain choice or receipt is invented.
    f.supervisor.closeCard(
      answerId,
      { kind: "crewmate", taskId: work?.id ?? "" },
      "Withdraw the unanswered offer",
    );
    expect(f.supervisor.cards.snapshot().some((card) => card.id === answerId)).toBe(false);
    await vi.waitFor(() => expect(noticeOf(f)?.id).toBe(notice));
    expect(f.tasks.capture.getAsk(ask?.id ?? "")).toMatchObject({
      delivery: "unresolved",
      noticeCardId: notice,
    });
    expect(retries(f)).toHaveLength(1);

    // Leave it ends the message: naming it again is refused as ended.
    f.supervisor.cardActions.act(notice, "leave-it");
    notifyProse(f.db, f.agent, "[fm-op] another report on PR 58", "agent");
    await drained(f.session, 4);
    await expect(
      toolsOf(f.specs)
        .get("create_task")
        ?.execute("t1", { title: "Recheck PR 58", ask_id: ask?.id }),
    ).rejects.toThrow(/has ended/);
    await finish(f);
  });

  it("says in close_card's answer when the close leaves an open message with no answering card (INF-2664)", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("what is two plus two?");
    const ask = f.tasks.capture.listAsks()[0];
    const tools = toolsOf(f.specs);
    const idOf = (shown: { content: { text?: string }[] } | undefined) =>
      shown?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    const first = idOf(await tools.get("emit_card")?.execute("c1", note("four", "Four")));
    const second = idOf(await tools.get("emit_card")?.execute("c2", note("still-four", "Four")));
    const left = `The captain's message ${ask?.id} ("what is two plus two?") now has no answering card up`;
    // Another card that can answer it is still up: nothing to say.
    const kept = await tools.get("close_card")?.execute("x1", { card_id: first, reason: "twice" });
    expect(kept?.content[0]?.text).not.toContain(left);
    const closed = await tools.get("close_card")?.execute("x2", { card_id: second });
    expect(closed?.content[0]?.text).toContain(left);
    await finish(f);
  });

  // INF-2667 review of INF-2664: a newer message that joins the chain after
  // the notice was taken back has a retry of its own; the old notice, with the
  // old words, never stands in for it.
  it("gives a newer message that joins after a withdrawn notice its own retry (INF-2664)", async () => {
    const f = setup({
      silent: true,
      seedTasks: [{ id: "t58", title: "Check if PR 58 merged", status: "idle" }],
    });
    await f.agent.converse({ text: "is PR 58 merged?", taskId: "t58" });
    await finish(f);
    await drained(f.session, 2);
    await finish(f);
    await vi.waitFor(() => expect(noticeOf(f)).toBeDefined());
    const ask = f.tasks.capture.listAsks()[0];

    notifyProse(f.db, f.agent, "[fm-op] a crewmate reported on PR 58", "agent");
    await drained(f.session, 3);
    await toolsOf(f.specs).get("spawn_crewmate")?.execute("s1", {
      title: "Check whether PR 58 merged",
      goal: "Say whether PR 58 merged",
      user_words: "is PR 58 merged?",
      ask_id: ask?.id,
    });
    await vi.waitFor(() => expect(f.crewSpecs).toHaveLength(1));
    await finish(f);
    const work = f.tasks.list().find((task) => task.title === "Check whether PR 58 merged");
    await f.crewSpecs[0]?.callbacks?.onCard?.({
      title: "PR 58 merged",
      body: "<p>It merged into main.</p>",
      answering: true,
      actions: [
        { id: "close-out", label: "Close it out", default: true },
        { id: "recheck", label: "Check again tomorrow" },
      ],
    });
    await f.crewSpecs[0]?.tools
      ?.find((tool) => tool.name === "report")
      ?.run({ text: "PR 58 merged.", summary: "PR 58 merged." });
    expect(noticeOf(f)).toBeUndefined();

    // A newer message about that work joins the message's chain.
    await f.agent.converse({ text: "and did its checks pass?", taskId: work?.id ?? "" });
    await vi.waitFor(() => expect(f.tasks.capture.listAsks()).toHaveLength(2));
    const newer = f.tasks.capture.listAsks()[1];
    await finish(f);
    expect(f.tasks.capture.getAsk(newer?.id ?? "")?.continues).toBe(ask?.id);

    // The approved minus rule keeps this decision available to the newer message.
    const answerId = f.supervisor.cards.openCardsFor(work?.id ?? "")[0]?.id ?? "";
    f.tasks.close(work?.id ?? "", { status: "done", reason: "answered", actor: "host" });
    f.supervisor.close(answerId);
    expect(f.supervisor.cards.snapshot().find((card) => card.id === answerId)).toMatchObject({
      minimized: true,
    });
    expect(f.tasks.capture.getAsk(newer?.id ?? "")?.delivery).toBe("covered");
    expect(noticeOf(f)).toBeUndefined();
    // The author removes the unanswered offer, so the newer message now needs
    // its own retry, with its own words; the older notice is not substituted.
    f.supervisor.closeCard(
      answerId,
      { kind: "crewmate", taskId: work?.id ?? "" },
      "Withdraw the unanswered offer",
    );
    expect(f.supervisor.cards.snapshot().some((card) => card.id === answerId)).toBe(false);
    await vi.waitFor(() =>
      expect(f.tasks.capture.getAsk(newer?.id ?? "")?.delivery).toBe("retrying"),
    );
    const wakes = new InboxStore(f.db)
      .allFor(FIRSTMATE_RECIPIENT)
      .flatMap((row) => (row.facts?.kind === "answer-missing" ? [row.facts.askId] : []));
    expect(wakes).toEqual([newer?.id]);
    expect(noticeOf(f)).toBeUndefined();
    expect(f.tasks.capture.getAsk(ask?.id ?? "")?.delivery).toBe("covered");
  });

  // INF-2664, found running the app: a decision card files its own task, which
  // ends with the card, so closing it in the step that showed it still names
  // the message it leaves without an answer.
  it("says so in close_card's answer for a decision card closed in the step that showed it (INF-2664)", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("what is two plus two?");
    const ask = f.tasks.capture.listAsks()[0];
    const tools = toolsOf(f.specs);
    const shown = await tools.get("emit_card")?.execute("c1", {
      title: "Two plus two is four",
      body: "<p>2 + 2 = 4.</p>",
      answering: true,
      actions: [
        { id: "ok", label: "Thanks", default: true },
        { id: "more", label: "Explain more" },
      ],
    });
    const id = shown?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    const closed = await tools.get("close_card")?.execute("x1", { card_id: id });
    expect(closed?.content[0]?.text).toContain(
      `The captain's message ${ask?.id} ("what is two plus two?") now has no answering card up`,
    );
    await finish(f);
  });

  // INF-2667 review of INF-2664: close_card names only the messages that
  // waited on the card it closed, never a chain whose newer message the card
  // came before.
  it("names in close_card's answer only the messages waiting on that card (INF-2664)", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("is PR 58 merged?");
    const first = f.tasks.capture.listAsks()[0];
    const shown = await toolsOf(f.specs).get("emit_card")?.execute("c1", note("merged", "Merged"));
    const card = shown?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    await finish(f);
    // A newer message about the card's work joins the chain; the card came before it.
    const work = f.tasks.capture.getAsk(first?.id ?? "")?.taskId ?? "";
    await f.agent.converse({ text: "and did its checks pass?", taskId: work });
    await drained(f.session, 2);
    await finish(f);
    const newer = f.tasks.capture.listAsks()[1];
    expect(f.tasks.capture.getAsk(newer?.id ?? "")?.continues).toBe(first?.id);
    const chain = f.supervisor.askEnding.chain(first?.id ?? "");
    expect(chain && f.supervisor.askEnding.state(chain).kind).not.toBe("waiting");
    notifyProse(f.db, f.agent, "[fm-op] a crewmate reported on PR 58", "agent");
    await vi.waitFor(() => expect(f.session.prompts.length).toBeGreaterThanOrEqual(3));
    const closed = await toolsOf(f.specs).get("close_card")?.execute("x1", { card_id: card });
    expect(closed?.content[0]?.text).toContain("Closed card");
    expect(closed?.content[0]?.text).not.toContain("now has no answering card up");
    await finish(f);
  });

  // INF-1433: Ask again must send the retained pictures, even with no words.
  it.each(["What is in these pictures?", ""])(
    "resends the original pictures and their names with Ask again (%j)",
    async (text) => {
      const f = setup({ silent: true });
      const images = [
        { ...pngImage, name: "screenshot.png" },
        { ...jpegImage, name: "photo.jpg" },
      ];
      await f.agent.converse({ text, images });
      await finish(f);
      await drained(f.session, 2);
      await finish(f);
      await vi.waitFor(() => expect(noticeOf(f)).toBeDefined());
      const original = f.tasks.capture.listAsks()[0];
      expect(original?.attachments).toHaveLength(2);

      f.supervisor.cardActions.act(`card-ask-${original?.id}`, "ask-again");
      await vi.waitFor(() => expect(f.session.prompts).toHaveLength(3));
      expect(f.session.promptImages[2]).toEqual(images);
      const again = f.tasks.capture.listAsks().at(-1);
      expect(again).toMatchObject({ text, deliveryFacts: { retryOf: original?.id } });
      expect(
        again?.attachments?.map(({ name, mimeType, bytes, sha256 }) => ({
          name,
          mimeType,
          bytes,
          sha256,
        })),
      ).toEqual(
        original?.attachments?.map(({ name, mimeType, bytes, sha256 }) => ({
          name,
          mimeType,
          bytes,
          sha256,
        })),
      );
      for (const [index, attachment] of (again?.attachments ?? []).entries()) {
        expect(readFileSync(attachmentPath(attachment)).toString("base64")).toBe(
          images[index]?.data,
        );
      }
      expect(noticeOf(f)).toBeUndefined();
    },
  );

  // The same intent excludes a partial resend when one retained picture is unavailable.
  it.each(["missing", "changed"])(
    "does not resend words or a subset of pictures when a saved picture is %s",
    async (condition) => {
      const f = setup({ silent: true });
      await f.agent.converse({
        text: "Compare these pictures",
        images: [
          { ...pngImage, name: "first.png" },
          { ...jpegImage, name: "second.jpg" },
        ],
      });
      await finish(f);
      await drained(f.session, 2);
      await finish(f);
      await vi.waitFor(() => expect(noticeOf(f)).toBeDefined());
      const original = f.tasks.capture.listAsks()[0];
      const attachment = original?.attachments?.[1] as AttachmentRef;
      if (condition === "missing") rmSync(attachmentPath(attachment));
      else writeFileSync(attachmentPath(attachment), Buffer.from(pngImage.data, "base64"));

      f.supervisor.cardActions.act(`card-ask-${original?.id}`, "ask-again");
      await tick();
      expect(f.session.prompts).toHaveLength(2);
      expect(f.tasks.capture.listAsks()).toHaveLength(1);
      expect(f.events).toContainEqual({
        type: "firstmate_note",
        text: expect.stringContaining('The picture "second.jpg" is not available'),
      });
    },
  );

  it("judges each message by the actions after it: a card before a steered message does not cover it", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("first question");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("first", "First answer"));
    await f.agent.converse("second question");
    expect(f.session.steers).toHaveLength(1);
    await finish(f);
    await drained(f.session, 2);
    const [first, second] = f.tasks.capture.listAsks();
    expect(first?.delivery).toBe("covered");
    expect(second?.delivery).toBe("retrying");
    // The retry asks about the second message alone; the first, whose card is
    // up for the captain, is only among the open messages in the turn's facts.
    const retry = f.session.prompts[1]?.slice(f.session.prompts[1].indexOf(ANSWER_MISSING_OPENING));
    expect(retry).toContain("second question");
    expect(retry).not.toContain("first question");
  });

  // INF-1610 piece 2: the first mate reads every message of the captain's
  // still waiting for its answer in its turn facts, with how it stands.
  it("lists a message whose work runs on among the open messages, and drops it once its answer is accepted", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("build the personal panels in isolation");
    await toolsOf(f.specs).get("spawn_crewmate")?.execute("spawn", {
      title: "Build personal panels in isolation",
      goal: "Build the panels in isolation",
      user_words: "build the personal panels in isolation",
    });
    await finish(f, "Started the panels.");
    const task = f.tasks.list().find((row) => row.title === "Build personal panels in isolation");
    const open = () =>
      decodeContext(f.agent.buildContextBlock()).open_asks as
        | { asks: Record<string, unknown>[] }
        | undefined;
    expect(open()?.asks).toEqual([
      expect.objectContaining({
        ask_id: f.tasks.capture.listAsks()[0]?.id,
        state: "working",
        running: [`${task?.key}: Build personal panels in isolation`],
      }),
    ]);
    const ask = f.tasks.capture.listAsks()[0];
    f.tasks.close(task?.id ?? "", { status: "done", reason: "answered", actor: "host" });
    f.tasks.capture.markAnswered([ask?.id ?? ""], null);
    expect(open()).toBeUndefined();
  });

  it("covers both messages when the action came after both were read", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("first question");
    await f.agent.converse("second question");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("both", "Both answered"));
    await finish(f);
    expect(states(f)).toEqual(["covered", "covered"]);
    expect(f.session.prompts).toHaveLength(1);
  });

  it("leaves a steered message the turn never read to the turn that does, with none of this turn's actions", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("first question");
    f.session.holdSteers();
    await f.agent.converse("second question");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("first", "First answer"));
    await finish(f);
    const [first, second] = f.tasks.capture.listAsks();
    expect(first?.delivery).toBe("covered");
    // Not judged, and the card shown after it was steered in never counted for it.
    expect(second).toMatchObject({ delivery: "pending", deliveryFacts: { entries: [] } });
    // Its own turn serves it as the captain's words and judges it there.
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain("[user]\nsecond question");
    expect(retries(f)).toEqual([]);
    await toolsOf(f.specs).get("emote")?.execute("e1", { emote: "nod" });
    await finish(f);
    expect(states(f)).toEqual(["covered", "covered"]);
  });

  it("holds a message a failed turn read and judges it when a turn serves it again", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("hello");
    f.session.emitTurnFailed("Response incomplete: max_time_limit");
    f.session.resolveNextPrompt();
    await tick();
    // The failure keeps today's handling: its own card, and no answer-missing retry.
    expect(states(f)).toEqual(["held"]);
    expect(f.supervisor.cards.snapshot().map((card) => card.id)).toEqual(["card-fm-turn-failure"]);
    expect(retries(f)).toEqual([]);
    f.supervisor.cardActions.act("card-fm-turn-failure", "retry-firstmate");
    await tick();
    expect(f.session.prompts).toHaveLength(2);
    expect(f.session.prompts[1]).toContain("[user]\nhello");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("hi", "Hello"));
    await finish(f);
    expect(states(f)).toEqual(["covered"]);
    expect(f.session.prompts).toHaveLength(2);
  });

  it("covers a reply under its own card by the closing words written in that card's replies, and retries one that wrote none", async () => {
    const f = setup({ silent: true });
    const cardId = f.supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    f.supervisor.cardActions.replyToCard(cardId, "why A?");
    await drained(f.session, 1);
    await finish(f, "A keeps the queue in order.");
    expect(f.supervisor.cards.thread(cardId).messages.map((message) => message.who)).toContain(
      "firstmate",
    );
    expect(states(f)).toEqual(["covered"]);
    expect(f.session.prompts).toHaveLength(1);

    // A reply the turn answered with nothing is retried, under the same card.
    f.supervisor.cardActions.replyToCard(cardId, "and why not B?");
    await drained(f.session, 2);
    await finish(f, "");
    await drained(f.session, 3);
    expect(states(f)).toEqual(["covered", "retrying"]);
    expect(f.session.prompts[2]).toContain(`a reply under your card "Pick one" (${cardId})`);
    expect(decodeContext(f.session.prompts[2] as string).about).toContain(cardId);
    await finish(f, "B hides the retry.");
    expect(states(f)).toEqual(["covered", "covered"]);
    expect(f.session.prompts).toHaveLength(3);
  });

  it("serves a message sent during the retry as a turn of its own, where its work is not refused", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    vi.spyOn(f.supervisor.steer, "steerCrewmate").mockResolvedValue("mid-turn");
    await f.agent.converse("how is pagination going?");
    await finish(f);
    await drained(f.session, 2);
    expect(states(f)).toEqual(["retrying"]);

    // The retry is running and may only show an answer: the new message is not
    // steered into it, so it neither meets the refusals nor is judged by it.
    await f.agent.converse("tell the crew to use cursors");
    expect(f.session.steers).toEqual([]);
    expect(new InboxStore(f.db).allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    await toolsOf(f.specs).get("emote")?.execute("e1", { emote: "nod" });
    await finish(f);
    expect(states(f)).toEqual(["covered", "pending"]);
    // Still open: the turn that serves it attaches it to the work it acts on.
    expect(f.tasks.capture.listAsks().map((ask) => ask.turnState)).toEqual(["closed", "open"]);

    // Its own turn serves it as the captain's words, and the steer lands.
    await drained(f.session, 3);
    expect(f.session.prompts[2]).toContain("[user]\ntell the crew to use cursors");
    const steered = await toolsOf(f.specs)
      .get("steer_crewmate")
      ?.execute("s1", { task_id: "t1", message: "Use cursors." });
    expect(steered?.content[0]?.text).not.toBe(ANSWER_ONLY_REFUSAL);
    await finish(f);
    expect(states(f)).toEqual(["covered", "covered"]);
    expect(f.tasks.capture.listAsks().at(-1)).toMatchObject({
      turnState: "closed",
      taskId: "t1",
      attachedVia: "tool:steer_crewmate",
    });
  });

  it("checks no operational wake: nothing a person said, so nothing is retried", async () => {
    const f = setup({ silent: true });
    notifyProse(f.db, f.agent, "[fm-op] a schedule fired", "scheduled");
    await drained(f.session, 1);
    await finish(f);
    f.agent.pokeInbox();
    await tick();
    expect(f.session.prompts).toHaveLength(1);
    expect(f.tasks.capture.listAsks()).toEqual([]);
  });
});

// INF-87 / INF-86: the actual INF-64 offer and submitted answer, not a padded plan.
it("recovers the complete accepted plan through the answer-close wake's task read", async () => {
  const fixture = JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf64.json", "utf8"));
  const taskId = "accepted-plan";
  const cardId = `card-${taskId}-split`;
  const card: Card = {
    ...crewCard(cardId, taskId, fixture.title, fixture.body),
    width: "wide",
    actions: fixture.actions,
  };
  const { agent, session, supervisor, specs, tasks, db } = setup({
    seedTasks: [
      {
        id: taskId,
        title: fixture.taskTitle,
        status: "idle",
        outcome: fixture.report,
        shape: { kind: "plan", deliverable: "answer" },
        intent: {
          goal: fixture.taskTitle,
          userWords: fixture.userWords,
          constraints: [{ kind: "read-only" }],
        },
      },
    ],
    seedCards: [card],
  });
  try {
    supervisor.cardActions.act(cardId, "start-next", "chrome", { answers: fixture.answers });
    await tick();
    expect(session.prompts).toHaveLength(1);
    const served = session.prompts[0]!;
    const wake = parseServedInput(served)!.find((part) => part.kind === "wake")!;
    const handoff = JSON.parse(wake.body.replace("[fm-op] ", ""));
    // The receipt alone was insufficient: follow the read it actually supplies.
    expect(handoff.read).toEqual({ tool: "tasks", arguments: { key: tasks.get(taskId)!.key } });
    const query = specs[0]!.tools.find((tool) => tool.name === handoff.read.tool)!;
    const result = await query.run(handoff.read.arguments);
    const reads = [result.text!];
    for (const omitted of parseTasksQueryText(result.text!).omitted) {
      reads.push(
        ...(await pageTaskField(
          (args) => query.run(args),
          handoff.read.arguments.key,
          omitted.field,
        )),
      );
    }
    const row = readPagedTaskQuery(reads)[0]!;
    expect(row.outcome).toBe(fixture.report);
    expect(row.card).toBe(fixture.body);
    expect(row.resolution).toMatchObject({ action: "start-next", answers: fixture.answers });
    expect(taskResolutionBody(row, "offer")).toBe(fixture.body);
    expect(row.reports?.at(-1)?.text).toBe(fixture.report);
    expect(tasks.get(taskId)?.status).toBe("done");
    session.emitTurnEnd("Read the accepted specification.");
    session.resolveNextPrompt();
    await tick();
    // A second click cannot redeliver approval or start a second builder.
    expect(
      supervisor.cardActions.act(cardId, "start-next", "chrome", { answers: fixture.answers }),
    ).toEqual({});
    await tick();
    expect(session.prompts).toHaveLength(1);
  } finally {
    agent.dispose();
    db.close();
  }
});
