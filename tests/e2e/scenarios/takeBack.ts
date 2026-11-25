import { TAKEN_BACK_OPENING } from "../../../src/core/orchestrator/captainWakes";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";

/**
 * Taking back a message (docs/task-capture.md, "Taking back a message"): a
 * scripted first mate whose turn for a marked message is held before it
 * files that task and an unrelated one with `ask_id` "", one that files a
 * task at once, and one that undoes what the
 * taken-back wake lists by discarding the task it names, with `ask_id` "".
 */
export const TAKE_BACK_HELD_MARKER = "take back while held:";
export const TAKE_BACK_FILED_MARKER = "take back after filing:";
export const TAKE_BACK_UNRELATED_TITLE = "tidy the build cache";

const fileTaskCall = (title: string, askId?: string): ScriptedCall => ({
  name: "create_task",
  args: { title, goal: `Complete ${title}`, ...(askId === undefined ? {} : { ask_id: askId }) },
});

/** The task id the taken-back wake names, read from the request body. */
function namedTaskId(latestUserTail: string): string | undefined {
  return latestUserTail.match(/create_task on task (\S+) \(/)?.[1];
}

export const takeBack: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (latestUserTail.includes(TAKEN_BACK_OPENING)) {
      const id = namedTaskId(latestUserTail);
      if (!id) return undefined;
      return {
        calls: [
          {
            name: "settle_task",
            args: {
              task_id: id,
              mode: "discard",
              closing_sentence: "You took back the message that asked for it, so I dropped it.",
              ask_id: "",
            },
          },
        ],
      };
    }
    const held = latestUserTail.match(/take back while held: ([^"\\]+)/)?.[1]?.trim();
    if (held)
      return { threadHeld: [fileTaskCall(held), fileTaskCall(TAKE_BACK_UNRELATED_TITLE, "")] };
    const filed = latestUserTail.match(/take back after filing: ([^"\\]+)/)?.[1]?.trim();
    if (filed) return { calls: [fileTaskCall(filed)] };
    return undefined;
  };
