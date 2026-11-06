import { FINISHED_REPORT_WORDS } from "../../../src/core/orchestrator/wakes";
import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/** FI3-1581: a finished wake whose task title contains this puts a note up, then settles. */
export const OWN_RENT_TITLE = "own vs rent";

export const OWN_RENT_CARD_TITLE = "Own vs rent: owning Macs wins for steady use";

const OWN_RENT_SETTLE_DELAY_MS = 2_500;

/**
 * Woken by the own-vs-rent task's finished report, the first mate puts the
 * answer on a card of its own and then closes the task answered, a while
 * later in the same turn.
 */
export const ownRentAnswer: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    // FI3-1581: woken by a finished report, Firstmate puts the answer on
    // a card of its own and, in the same turn, closes the task answered.
    // The gap is the reproduction's: the note is on the stack before the close.
    if (latestUserTail.includes(FINISHED_REPORT_WORDS) && latestUserTail.includes(OWN_RENT_TITLE)) {
      const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
      if (!hasToolResults) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                task_id: taskId,
                title: OWN_RENT_CARD_TITLE,
                body:
                  "<p>Owning Macs costs far less than renting for steady Mac CI use.</p>" +
                  "<p>Renting only wins when extra demand comes in rare bursts.</p>",
              },
            },
          ],
        };
      }
      if (calledTool(latestUserTail, "emit_card") && !calledTool(latestUserTail, "settle_task")) {
        return {
          calls: [{ name: "settle_task", args: { task_id: taskId, mode: "answered" } }],
          afterMs: OWN_RENT_SETTLE_DELAY_MS,
        };
      }
    }
    return undefined;
  };
