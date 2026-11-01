import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POSSIBLE_REPETITION_OPENING } from "../../../src/core/orchestrator/wakes";
import { type Scenario, writeFilesCalls } from "../mockProvider";

export const REPETITION_MARKER = "compare this picture with four prescribed reads";
export const REPETITION_TITLE = "Prescribed picture rereads";
export const REPETITION_REPLY =
  "These are prescribed rereads. The observation does not require stopping the task.";

/** INF-1996: real read calls continue actively while the first mate receives a possible-loop fact. */
export const toolRepetition: Scenario = () => {
  let spawned = false;
  let call = 0;
  return ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      if (latestUserTail.includes(POSSIBLE_REPETITION_OPENING)) return { text: REPETITION_REPLY };
      if (!spawned && !hasToolResults && latestUserTail.includes(REPETITION_MARKER)) {
        spawned = true;
        return {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title: REPETITION_TITLE,
                goal: REPETITION_MARKER,
                user_words: REPETITION_MARKER,
                constraints: [{ kind: "read-only" }],
              },
            },
          ],
        };
      }
      return undefined;
    }
    if (!body.includes(REPETITION_MARKER)) return undefined;
    call += 1;
    if (call === 1)
      return {
        calls: writeFilesCalls([
          {
            path: "comparison.png",
            bytes: readFileSync(
              resolve("release-notes/pictures/activity-settles-setting-runs-light.png"),
            ),
          },
        ]),
      };
    if (call <= 5) return { calls: [{ name: "read", args: { path: "comparison.png" } }] };
    return { held: true };
  };
};
