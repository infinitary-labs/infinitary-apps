import { findCrewTaskId, type Scenario, settleNeedle, sinceLastUser } from "../mockProvider";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * INF-2546 R11, under the captain's "include first-mate-merge" answer (q8:
 * the first mate may offer the merge on any change card): a crewmate
 * publishes its pull request with its saved story and puts its completion
 * card up. The captain asks under that card (`FIRSTMATE_MERGE_ASK`): putting
 * a decision aside keeps it open (INF-1879), so the crewmate withdraws its
 * card and hands the captain's words to the first mate, as a thread reply's
 * steer tells it to, and the first mate puts up a merge card of its own.
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

/** The card a thread reply's steer names (`Card "title" (id).`). */
function repliedCard(steer: string): string {
  return steer.match(/\((card-[\w-]+)\)/)?.[1] ?? "missing";
}

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
    // The captain's ask under the completion card: the crewmate withdraws
    // it and reports the words verbatim for the first mate to run.
    if (latestUserTail.includes(FIRSTMATE_MERGE_ASK)) {
      if (hasToolResults) return { text: "The merge is the first mate's to offer." };
      const asked = `${FIRSTMATE_MERGE_ASK}${settleNeedle(latestUserTail, FIRSTMATE_MERGE_ASK)}`;
      return {
        calls: [
          { name: "close_card", args: { card_id: repliedCard(latestUserTail) } },
          {
            name: "report",
            args: {
              text: "The captain asked under my completion card for the first mate's merge card, so I withdrew mine.",
              needs_firstmate: `The captain's words, verbatim: "${asked}"`,
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
