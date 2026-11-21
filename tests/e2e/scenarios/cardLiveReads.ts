import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";

/**
 * Marker prompt (INF-5531 piece 1, `tests/e2e/card-live-reads.spec.ts`): the
 * mock crewmate emits one card whose own script reads live app data through
 * the panels' interface - the count of tasks on the record through the
 * `sql` read over `v_tasks_v1`, the task board through `tasks.board` - and
 * tries one read it did not declare.
 */
export const LIVE_READS_PROMPT_MARKER = "show the live task count";

/** What the captain replies under the card to have its crewmate end it. */
export const LIVE_READS_END_MARKER = "end the live card";

export const LIVE_READS_CARD_TITLE = "Tasks on the record, live";

/** The reads and views the card declares: a subset of a custom panel's own. */
export const LIVE_READS_DECLARED = { reads: ["tasks.board"], sql: ["v_tasks_v1"] } as const;

/** A read a custom panel may name that this card did not declare. */
export const LIVE_READS_UNDECLARED = "quota.snapshot";

/** A published view this card did not declare. */
export const LIVE_READS_OTHER_VIEW = "v_usage_v1";

/**
 * The body: four lines its script fills. `data-count` is the record's task
 * count, `data-updates` how many answers the count read has delivered,
 * `data-board` turns `live` on the board's first value, `data-undeclared`
 * the undeclared read's refusal code, `data-other-view` the `sql` read's
 * answer for a view it did not declare, and `data-stopped` the code that ends
 * the count's subscription, if one does.
 */
function liveReadsBody(): string {
  const [view] = LIVE_READS_DECLARED.sql;
  return (
    "<p>Tasks on the record: <b data-count>-</b></p>" +
    "<figure aria-label='Live reads'>" +
    "<p>Answers: <span data-updates>0</span></p>" +
    "<p>Board: <span data-board>waiting</span></p>" +
    "<p>Undeclared read: <span data-undeclared>pending</span></p>" +
    "<p>Undeclared view: <span data-other-view>pending</span></p>" +
    "<p>Count read: <span data-stopped>open</span></p>" +
    "<script>(function () {" +
    "function put(name, text) { document.querySelector('[data-' + name + ']').textContent = String(text); }" +
    "var answers = 0;" +
    `inf.subscribe("sql", { sql: "SELECT COUNT(*) AS n FROM ${view}" }, function (value) {` +
    "answers += 1; put('count', value.rows[0].n); put('updates', answers);" +
    "}, function (error) { put('stopped', error.code); });" +
    `inf.subscribe("${LIVE_READS_DECLARED.reads[0]}", {}, function () { put('board', 'live'); });` +
    `inf.subscribe("${LIVE_READS_UNDECLARED}", {}, function () { put('undeclared', 'answered'); })` +
    ".ready.catch(function (error) { put('undeclared', error.code); });" +
    `inf.subscribe("sql", { sql: "SELECT COUNT(*) AS n FROM ${LIVE_READS_OTHER_VIEW}" }, function (value) {` +
    "put('other-view', value.refused || 'answered'); });" +
    "})();</script></figure>"
  );
}

function liveReadsCardCall(): ScriptedCall {
  return {
    name: "emit_card",
    args: {
      title: LIVE_READS_CARD_TITLE,
      body: liveReadsBody(),
      reads: [...LIVE_READS_DECLARED.reads],
      sql: [...LIVE_READS_DECLARED.sql],
    },
  };
}

/**
 * The live-reads crewmate: emit the card, then end it when the captain's
 * reply under it asks, as an author ends a card the captain has seen.
 */
export const cardLiveReads: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (latestUserTail.includes(LIVE_READS_END_MARKER)) {
      if (hasToolResults) return { text: "The live card is ended." };
      const message =
        providerMessages(body).findLast((message) => message.role === "user")?.text ?? "";
      const cardId = message.match(/\((card-[\w-]+)\)/)?.[1];
      if (!cardId) throw new Error("The reply did not name its live card");
      return { calls: [{ name: "close_card", args: { card_id: cardId } }] };
    }
    if (latestUserTail.includes(LIVE_READS_PROMPT_MARKER) && !hasToolResults) {
      return { calls: [liveReadsCardCall()] };
    }
    return undefined;
  };
