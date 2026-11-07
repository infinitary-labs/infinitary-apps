import type { ScriptedArgs } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * INF-2546 (R2, R9), under the captain's "a new list of every pull request
 * on the task": a crewmate opens its own pull request with its saved story,
 * then checks out an existing branch, opens it as a second pull request with
 * a story of its own (INF-2184) and offers it as a continuing merge. When
 * the captain's click is refused on a conflict, it moves the branch to the
 * same work on main's newer version and declares the repair; the kept
 * approval merges it.
 */
export const STORIED_CHANGES_MARKER = "publish both stories and merge the second one";
/** The existing branch the crewmate opens as its second pull request. */
export const STORIED_BRANCH = "reading-fix";
export const STORIED_CARD_TITLE = "Merge the second reading";
/** The task's own story. */
export const OWN_STORY = { ...MOCK_GITHUB_STORY, whatChanged: ["The meter reads on time."] };
export const OWN_STORY_TITLE = "fix: the meter reads on time";
/** The other pull request's own story. */
export const STORIED_STORY = {
  ...MOCK_GITHUB_STORY,
  whatChanged: ["The task reads the selected pull request."],
};
export const STORIED_STORY_TITLE = "fix: read the selected pull request";

/** One git reading: main's version, then the checked-out one. */
const READ_VERSIONS = "git rev-parse main HEAD";

export function storiedChanges(
  repair: () => NonNullable<ScriptedArgs<"check_change">["conflictRepair"]>,
): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream, latestUserTail }) => {
      if (isFirstmate || !wantsStream) return undefined;
      const { results } = sinceLastUser(body);
      if (
        latestUserTail.includes("your merge card's merge of") &&
        latestUserTail.includes("Nothing was merged")
      ) {
        const declared = repair();
        if (results.length === 0)
          return {
            calls: [{ name: "bash", args: { command: `git reset --hard ${declared.toHead}` } }],
          };
        if (results.length === 1)
          return { calls: [{ name: "check_change", args: { conflictRepair: declared } }] };
        return { text: "The unchanged repair is declared." };
      }
      if (latestUserTail.includes("The task stays open"))
        return { text: "The second pull request merged; this task remains open." };
      if (!latestUserTail.includes(STORIED_CHANGES_MARKER)) return undefined;
      const said = results.join("\n");
      switch (results.length) {
        case 0:
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command: `git commit --allow-empty -m "${OWN_STORY_TITLE}" && ${READ_VERSIONS}`,
                },
              },
            ],
          };
        case 1:
          return { calls: [prepareMockStory(OWN_STORY_TITLE, results[0], OWN_STORY)] };
        case 2:
          return {
            calls: [
              {
                name: "open_change",
                args: { title: OWN_STORY_TITLE, presentation: preparedRevision(said) },
              },
            ],
          };
        case 3:
          return {
            calls: [
              {
                name: "bash",
                args: { command: `git checkout ${STORIED_BRANCH} && ${READ_VERSIONS}` },
              },
            ],
          };
        case 4:
          return { calls: [prepareMockStory(STORIED_STORY_TITLE, results[3], STORIED_STORY)] };
        case 5:
          return {
            calls: [
              {
                name: "open_change",
                args: {
                  title: STORIED_STORY_TITLE,
                  branch: STORIED_BRANCH,
                  presentation: preparedRevision(said),
                },
              },
            ],
          };
        case 6: {
          const opened = Number(results[5]?.match(/Opened pull request #(\d+)/)?.[1]);
          if (!opened) return { text: "The second pull request did not open." };
          return { calls: [{ name: "check_change", args: { pull: opened } }] };
        }
        case 7: {
          const review = results[6]?.match(/Merge review (mr[0-9a-f]+)/)?.[1];
          if (!review) return { text: "The second pull request has no merge review." };
          return {
            calls: [
              {
                name: "emit_card",
                args: {
                  title: STORIED_CARD_TITLE,
                  body: "<p>The second pull request carries its own story.</p><p>Merging it keeps this task open.</p>",
                  actions: [
                    { id: "merge", effect: { kind: "merge", review, after: "continue" } },
                    { id: "not-now", label: "Not now" },
                  ],
                },
              },
            ],
          };
        }
        default:
          return { text: "The second pull request is ready for the captain." };
      }
    };
}
