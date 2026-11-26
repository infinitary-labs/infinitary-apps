import {
  ANSWER_MISSING_OPENING,
  TAKEN_BACK_OPENING,
} from "../../../src/core/orchestrator/captainWakes";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario, ScenarioRequest } from "../mockProvider";

/**
 * Taking back a message (docs/task-capture.md, "Taking back a message"): a
 * scripted first mate whose turn for a marked message is held before it
 * files that task and an unrelated one with `ask_id` "", one that files a
 * task at once, one whose answer retry for a marked message is held so a
 * new message waits unread on the lane, and one that undoes what the
 * taken-back wake lists by discarding the task it names, with `ask_id` "",
 * and closes that turn with its own line.
 */
export const TAKE_BACK_HELD_MARKER = "take back while held:";
export const TAKE_BACK_FILED_MARKER = "take back after filing:";
export const TAKE_BACK_UNRELATED_TITLE = "tidy the build cache";
/** The undo turn's closing words, which the strip shows beside the message taken back. */
export const TAKE_BACK_UNDO_LINE = "Took it back: dropped its task.";
/** Rides a message the stock stand-in answers silently, so its one answer retry is served alone. */
export const TAKE_BACK_ALONE_MARKER = "take back while answering alone:";

const fileTaskCall = (title: string, askId?: string): ScriptedCall => ({
  name: "create_task",
  args: { title, goal: `Complete ${title}`, ...(askId === undefined ? {} : { ask_id: askId }) },
});

/** The task id the taken-back wake names, read from the request body. */
function namedTaskId(latestUserTail: string): string | undefined {
  return latestUserTail.match(/create_task on task (\S+) \(/)?.[1];
}

export const takeBack: Scenario = () => {
  let undoing = false;
  return ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (hasToolResults) {
      if (!undoing) return undefined;
      undoing = false;
      return { text: TAKE_BACK_UNDO_LINE };
    }
    if (latestUserTail.includes(TAKEN_BACK_OPENING)) {
      const id = namedTaskId(latestUserTail);
      if (!id) return undefined;
      undoing = true;
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
};

/**
 * Holds the answer retry for a message carrying `TAKE_BACK_ALONE_MARKER`.
 * It answers the first mate's own wake, so it is asked before the stand-in's
 * handling of the retry (`answersFirst`).
 */
export const takeBackAlone: Scenario = Object.assign(
  () =>
    ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }: ScenarioRequest) =>
      isFirstmate &&
      wantsStream &&
      !hasToolResults &&
      latestUserTail.includes(ANSWER_MISSING_OPENING) &&
      latestUserTail.includes(TAKE_BACK_ALONE_MARKER)
        ? { threadHeld: [] }
        : undefined,
  { answersFirst: true as const },
);
