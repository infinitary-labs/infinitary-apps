import {
  calledTool,
  MOCK_CLOSING_SENTENCES,
  MOCK_STANDARD_CARD_BODY,
  type Scenario,
  THREAD_WORKING_SIBLING_MARKER,
} from "../mockProvider";

export const THREAD_SETTLE_PROMPT_MARKER = "hand the settle over";

export const THREAD_SETTLE_CARD_TITLE = "The queue flush is ready";

/** The captain's words under that card - a settle is not the crewmate's to run. */
export const THREAD_SETTLE_REPLY = "merge it";

/**
 * The phrase the crewmate's report carries so the mock Firstmate can find
 * the hand-off. In the product the Firstmate reads the captain's words; a
 * scripted model needs a needle, and this is it.
 */
export const THREAD_HANDOFF_PHRASE = "this one is yours to run";

export const MOCK_THREAD_HANDOFF_REPORT =
  `The captain replied under my card, verbatim: "${THREAD_SETTLE_REPLY}". ` +
  `Putting the change in is not mine to do, so I closed my card - ${THREAD_HANDOFF_PHRASE}.`;

/**
 * A thread the crewmate cannot answer itself: its completion card's reply
 * asks for the merge, so the crewmate closes its card and hands the words up,
 * and the first mate runs the settle. The working sibling keeps working.
 */
export const threadSettle: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate && wantsStream) {
      // Cards as threads, phase 1: the crewmate closed its card and
      // handed the captain's words up. The Firstmate runs the settle it
      // would have run had he typed them in the main input.
      if (!hasToolResults && latestUserTail.includes(THREAD_HANDOFF_PHRASE)) {
        const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
        return {
          calls: [
            {
              name: "settle_task",
              args: {
                task_id: taskId,
                mode: "land",
                closing_sentence: MOCK_CLOSING_SENTENCES.land,
              },
            },
          ],
        };
      }
    }
    if (!isFirstmate && body.includes(THREAD_WORKING_SIBLING_MARKER) && wantsStream) {
      return { held: true };
    }
    // The settle hand-off: a reply asking for the change to go in is
    // not the crewmate's to run, so it closes its card and reports the
    // captain's words verbatim. No classifier reads anything.
    if (!isFirstmate && body.includes(THREAD_SETTLE_PROMPT_MARKER) && wantsStream) {
      const shownCardId = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
      if (!hasToolResults && latestUserTail.includes(THREAD_SETTLE_REPLY)) {
        return {
          calls: [
            { name: "close_card", args: { card_id: shownCardId } },
            { name: "report", args: { text: MOCK_THREAD_HANDOFF_REPORT } },
          ],
        };
      }
      if (!hasToolResults && !calledTool(body, "emit_card")) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "thread-settle",
                title: THREAD_SETTLE_CARD_TITLE,
                body: MOCK_STANDARD_CARD_BODY,
                actions: [
                  {
                    id: "merge",
                    label: "Merge the branch",
                    default: true,
                    effect: { kind: "settle", mode: "merge" },
                  },
                ],
              },
            },
          ],
        };
      }
      return { text: "Holding for the captain's decision." };
    }
    return undefined;
  };
