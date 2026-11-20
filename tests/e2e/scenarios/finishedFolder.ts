import { type Scenario, settleNeedle } from "../mockProvider";
import { findCrewTaskId } from "../providerRequest";

export const FINISH_FOLDER_PROMPT = "record the verified folder check for ";
export const MISSING_FOLDER_PROOF_PROMPT = "try closing without folder proof for ";
export const FOLDER_CHECK_EVIDENCE =
  "Read the project draft, index, refs and stash; the existing edits and unpushed commit remain intact.";
export const FOLDER_CHECK_SENTENCE =
  "The project folder was checked and your existing work remains intact.";

/** INF-1279: scripted first mate judgment, through the real settle tool and owner. */
export const finishedFolder: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    const marker = latestUserTail.includes(MISSING_FOLDER_PROOF_PROMPT)
      ? MISSING_FOLDER_PROOF_PROMPT
      : FINISH_FOLDER_PROMPT;
    if (!latestUserTail.includes(marker)) return undefined;
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
            ...(marker === FINISH_FOLDER_PROMPT ? { evidence: FOLDER_CHECK_EVIDENCE } : {}),
            closing_sentence: FOLDER_CHECK_SENTENCE,
          },
        },
      ],
    };
  };
