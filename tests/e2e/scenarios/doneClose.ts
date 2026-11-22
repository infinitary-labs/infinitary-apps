import { type Scenario, settleNeedle } from "../mockProvider";
import { findCrewTaskId } from "../providerRequest";

export const CLOSE_ALONE_MARKER = "check and close if finished: ";
export const CLOSE_ON_WORDS_MARKER = "close it as done, the pull request can stay open: ";
export const DONE_EVIDENCE = "The meter reads on time on the bench.";
export const DONE_SENTENCE = "The meter task is done; its pull request stays open.";

export const doneClose: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    const marker = [CLOSE_ALONE_MARKER, CLOSE_ON_WORDS_MARKER].find((one) =>
      latestUserTail.includes(one),
    );
    if (!marker) return undefined;
    const needle = settleNeedle(latestUserTail, marker);
    const taskId =
      findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
    return {
      calls: [
        {
          name: "settle_task",
          args: {
            task_id: taskId,
            mode: "done",
            why: "finished",
            evidence: DONE_EVIDENCE,
            closing_sentence: DONE_SENTENCE,
            ...(marker === CLOSE_ON_WORDS_MARKER ? { captain_words: "turn" } : {}),
          },
        },
      ],
    };
  };
