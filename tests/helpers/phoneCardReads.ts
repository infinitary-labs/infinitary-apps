import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";

/** The title the live card shows on the phone. */
export const PHONE_LIVE_CARD_TITLE = "Tasks on the record, live";
/** The title of the second live card, whose body waits beside the first one's. */
export const PHONE_BESIDE_CARD_TITLE = "Tasks on the record, beside";

/**
 * INF-5531 piece 2's phone part (ios/Infinitary/InfinitaryUITests/PhoneJourney+CardsReads.swift): the computer's side.
 * A crewmate's open card declares the board and the record's tasks view, and its own script reads the record's task
 * count through the `sql` read, the board through `tasks.board`, and tries a read and a view it did not declare, each
 * line its script fills read on the phone as text. Data: the test home's real core and its record; a task added here
 * reaches the phone as the computer's own pushes. A second crewmate's card with the same body is ended while its body
 * waits beside the shown one, and the first card, once ended and put away, comes back as a past card. The captain's
 * answer on closed cards: "Only while the card is open. Past cards keep what the author wrote, but a closed card stops
 * updating."
 */
/** `queries`: builds the test home's query process, which the card's `sql` read and the count run in. */
export function phoneCardReadControls(core: Core, queries: () => Promise<void>) {
  const cards = core.services.supervisor.cards;
  /** Each live card's crewmate task and, once put up, its card. */
  const live = {
    first: {
      taskId: "phone-live-reads",
      title: PHONE_LIVE_CARD_TITLE,
      cardId: undefined as string | undefined,
    },
    beside: {
      taskId: "phone-live-reads-beside",
      title: PHONE_BESIDE_CARD_TITLE,
      cardId: undefined as string | undefined,
    },
  };
  let added = 0;

  /**
   * The body's lines, each filled by its script: `count:`, `board:`, `undeclared:`, `view:` and `stopped:`, which names
   * why the count read ended or was refused.
   */
  const body =
    "<p>The record's tasks, as this card's own script reads them.</p>" +
    "<p data-count>count: waiting</p><p data-board>board: waiting</p>" +
    "<p data-undeclared>undeclared: waiting</p><p data-view>view: waiting</p><p data-stopped>stopped: open</p>" +
    "<script>(function () {" +
    "function put(name, text) { document.querySelector('[data-' + name + ']').textContent = name + ': ' + text; }" +
    "inf.subscribe('sql', { sql: 'SELECT COUNT(*) AS n FROM v_tasks_v1' }, function (value) { put('count', value.rows[0].n); }," +
    " function (error) { put('stopped', error.code); })" +
    // A refusal at the start (a past card's) only rejects `ready`, so it fills the same line.
    ".ready.catch(function (error) { put('stopped', error.code); });" +
    "inf.subscribe('tasks.board', {}, function () { put('board', 'live'); });" +
    "inf.subscribe('quota.snapshot', {}, function () { put('undeclared', 'answered'); })" +
    ".ready.catch(function (error) { put('undeclared', error.code); });" +
    "inf.subscribe('sql', { sql: 'SELECT COUNT(*) AS n FROM v_usage_v1' }, function (value) {" +
    " put('view', value.refused || 'answered'); });" +
    "})();</script>";

  /** How many tasks the record holds, as the card's own read counts them. */
  const count = async () =>
    Number(
      (
        (await core.dispatch("inf:sql:query", [
          { sql: "SELECT COUNT(*) AS n FROM v_tasks_v1", views: ["v_tasks_v1"] },
        ])) as {
          rows?: { n?: unknown }[];
        }
      ).rows?.[0]?.n ?? 0,
    );

  /** Puts up one live card from its own crewmate, whose turn then ends, which brings the card to the stage. */
  async function putUp(which: keyof typeof live) {
    const card = live[which];
    seedTask(core.services.tasks, {
      id: card.taskId,
      title: `Count the record's tasks (${which})`,
      status: "idle",
    });
    card.cardId = cards.emitCrewmateCard(
      card.taskId,
      {
        id: `live-count-${which}`,
        title: card.title,
        body,
        actions: [],
        reads: ["tasks.board"],
        sql: ["v_tasks_v1"],
      },
      `Count the record's tasks (${which})`,
      "Sonnet 5.5",
      "on Mac mini",
    );
    cards.closeOut({ kind: "crewmate", taskId: card.taskId }, "idle");
    cards.flushBroadcast();
    return { title: card.title, count: await count() };
  }

  /** The card's crewmate ends it while it is on the stage, as its author's close does. */
  async function end(which: keyof typeof live) {
    const { cardId, taskId } = live[which];
    if (!cardId) throw new Error(`The ${which} live card was never put up`);
    cards.close(cardId, { kind: "crewmate", taskId }, "done");
    cards.flushBroadcast();
    const ended = (await core.dispatch("inf:cards:list", [])).find(
      (card) => card.id === cardId,
    )?.ended;
    if (!ended) throw new Error(`The ${which} live card did not stay on the stage as ended`);
    return { count: await count() };
  }

  return {
    /** Puts up the live card as the one card on the stage, with every other card put away. */
    async card() {
      await queries();
      for (const card of await core.dispatch("inf:cards:list", []))
        await core.dispatch(
          card.noteDone && !card.noteDone.closesTask ? "inf:cards:note-done" : "inf:cards:close",
          [card.id],
        );
      return putUp("first");
    },
    /** Puts up a second live card beside the first. */
    beside: () => putUp("beside"),
    /** Adds one task to the record, which the computer pushes to the phone as its own change. */
    async addTask() {
      added += 1;
      seedTask(core.services.tasks, {
        id: `phone-live-added-${added}`,
        title: `Added task ${added}`,
        status: "queued",
      });
      return { count: await count() };
    },
    end: () => end("first"),
    endBeside: () => end("beside"),
    /** Puts every ended card away, then brings the first live card back as a past card, as the Cards row does. */
    async past() {
      const cardId = live.first.cardId;
      if (!cardId) throw new Error("The live card was never put up");
      for (const card of await core.dispatch("inf:cards:list", []))
        await core.dispatch("inf:cards:close", [card.id]);
      await core.dispatch("inf:cards:show-past", [cardId]);
      return { title: live.first.title };
    },
  };
}
