import { MOCK_CLOSING_SENTENCES, type Scenario, settleNeedle } from "../mockProvider";
import { findCrewTaskId } from "../providerRequest";

export const RELEASE_PROMPT_MARKER = "verified external release for the task ";

export const externalRelease: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(RELEASE_PROMPT_MARKER)) {
      const needle = settleNeedle(latestUserTail, RELEASE_PROMPT_MARKER);
      const taskId =
        findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
      return {
        calls: [
          {
            name: "settle_task",
            args: {
              task_id: taskId,
              mode: "done",
              why: "released",
              evidence: "Release v1.2.3 verified in the release manifest and published artifact",
              closing_sentence: MOCK_CLOSING_SENTENCES.released,
            },
          },
        ],
      };
    }
    return undefined;
  };
