import type { Core } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";

/** The title the live card shows on the phone. */
export const PHONE_LIVE_CARD_TITLE = "Tasks on the record, live";

/**
 * INF-5531 piece 2's phone part (ios/Infinitary/InfinitaryUITests/PhoneJourney+CardsReads.swift): the computer's side.
 * A crewmate's open card declares the board and the record's tasks view, and its own script reads the record's task
 * count through the `sql` read, the board through `tasks.board`, and tries a read and a view it did not declare, each
 * line its script fills read on the phone as text. Data: the test home's real core and its record; a task added here
 * reaches the phone as the computer's own pushes. The captain's answer on closed cards: "Only while the card is open.
 * Past cards keep what the author wrote, but a closed card stops updating."
 */
export function phoneCardReadControls(core: Core) {
  const cards = core.services.supervisor.cards;
  const taskId = "phone-live-reads";
  let cardId: string | undefined;
  let added = 0;

  /** The body's lines, each filled by its script: `count:`, `board:`, `undeclared:`, `view:` and `stopped:`. */
  const body =
    "<p>The record's tasks, as this card's own script reads them.</p>" +
    "<p data-count>count: waiting</p><p data-board>board: waiting</p>" +
    "<p data-undeclared>undeclared: waiting</p><p data-view>view: waiting</p><p data-stopped>stopped: open</p>" +
    "<script>(function () {" +
    "function put(name, text) { document.querySelector('[data-' + name + ']').textContent = name + ': ' + text; }" +
    "inf.subscribe('sql', { sql: 'SELECT COUNT(*) AS n FROM v_tasks_v1' }, function (value) { put('count', value.rows[0].n); }," +
    " function (error) { put('stopped', error.code); });" +
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

  return {
    /** Puts up the live card as the one card on the stage, with every other card put away. */
    async card() {
      for (const card of await core.dispatch("inf:cards:list", []))
        await core.dispatch(
          card.noteDone && !card.noteDone.closesTask ? "inf:cards:note-done" : "inf:cards:close",
          [card.id],
        );
      seedTask(core.services.tasks, {
        id: taskId,
        title: "Count the record's tasks",
        status: "idle",
      });
      cardId = cards.emitCrewmateCard(
        taskId,
        {
          id: "live-count",
          title: PHONE_LIVE_CARD_TITLE,
          body,
          actions: [],
          reads: ["tasks.board"],
          sql: ["v_tasks_v1"],
        },
        "Count the record's tasks",
        "Sonnet 5.5",
        "on Mac mini",
      );
      // The crewmate's turn ends, which brings its card to the stage.
      cards.closeOut({ kind: "crewmate", taskId }, "idle");
      cards.flushBroadcast();
      return { title: PHONE_LIVE_CARD_TITLE, count: await count() };
    },
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
    /** The card's crewmate ends it while it shows, as its author's close does. */
    async end() {
      if (!cardId) throw new Error("The live card was never put up");
      cards.close(cardId, { kind: "crewmate", taskId }, "done");
      cards.flushBroadcast();
      const ended = (await core.dispatch("inf:cards:list", [])).find(
        (card) => card.id === cardId,
      )?.ended;
      if (!ended) throw new Error("The live card did not stay on the stage as ended");
      return { count: await count() };
    },
  };
}
