import { findCrewTaskId, type Scenario, settleNeedle, sinceLastUser } from "../mockProvider";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * INF-2546 R11, under the captain's "include first-mate-merge" answer (q8:
 * the first mate may offer the merge on any change card): a crewmate
 * publishes its pull request with its saved story and puts its completion
 * card up; once the captain closes that card and asks (`FIRSTMATE_MERGE_ASK`),
 * the first mate puts up a merge card of its own on the task.
 */
export const STORY_MERGE_MARKER = "publish the meter story for the first mate";
/** The captain's ask the first mate answers with its own merge card. */
export const FIRSTMATE_MERGE_ASK = "put your merge card up for ";
/** The story, pull request and completion card's one title. */
export const STORY_MERGE_TITLE = "fix: read the meter on the first paint";
export const STORY_MERGE_STORY = {
  ...MOCK_GITHUB_STORY,
  whatChanged: ["The meter reads on the first paint."],
};
export const FIRSTMATE_MERGE_CARD = "Merge the meter fix";

/** One git reading: main's version, then the committed one. */
const READ_VERSIONS = "git rev-parse main HEAD";

export const firstmateStoryMerge: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      if (!latestUserTail.includes(FIRSTMATE_MERGE_ASK)) return undefined;
      if (hasToolResults) return { text: "My merge card for the meter fix is up." };
      const needle = settleNeedle(latestUserTail, FIRSTMATE_MERGE_ASK);
      const taskId =
        findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              task_id: taskId,
              title: FIRSTMATE_MERGE_CARD,
              body: "<p>The meter fix has its story published and its checks passed.</p>",
              actions: [
                {
                  id: "merge",
                  label: "Merge",
                  default: true,
                  effect: { kind: "settle", mode: "merge" },
                },
                { id: "wait", label: "Wait" },
              ],
            },
          },
        ],
      };
    }
    if (!latestUserTail.includes(STORY_MERGE_MARKER)) return undefined;
    const { results } = sinceLastUser(body);
    const said = results.join("\n");
    switch (results.length) {
      case 0:
        return {
          calls: [
            {
              name: "bash",
              args: {
                command: `printf 'first paint\\n' > meter.txt && git add meter.txt && git commit -m "${STORY_MERGE_TITLE}" && ${READ_VERSIONS}`,
              },
            },
          ],
        };
      case 1:
        return { calls: [prepareMockStory(STORY_MERGE_TITLE, results[0], STORY_MERGE_STORY)] };
      case 2:
        return {
          calls: [
            {
              name: "open_change",
              args: { title: STORY_MERGE_TITLE, presentation: preparedRevision(said) },
            },
          ],
        };
      case 3:
        return { calls: [{ name: "check_change", args: {} }] };
      case 4:
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: STORY_MERGE_TITLE,
                presentation: preparedRevision(said),
                actions: [
                  { id: "merge", default: true, effect: { kind: "settle", mode: "merge" } },
                ],
              },
            },
            { name: "report", args: { text: "The meter fix is published and ready to merge." } },
          ],
        };
      default:
        return { text: "The meter fix is ready for the captain." };
    }
  };
