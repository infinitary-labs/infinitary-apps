import type { Scenario } from "../mockProvider";

/**
 * A hard task (INF-4104 piece 2): "start a hard task: <title>" has the mock
 * first mate spawn a crewmate asking for the high level, as a first mate
 * judges a hard task, so routing walks the high level first.
 */
// e2e-typed-words: the captain's own words that start a scripted hard spawn; they only share a phrase with the product's
export const HARD_TASK_PROMPT_MARKER = "start a hard task:";

export const hardTask: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    const title = latestUserTail.match(new RegExp(`${HARD_TASK_PROMPT_MARKER} ([^"\\\\]+)`))?.[1];
    if (!title) return undefined;
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: title.trim(),
            goal: `Complete the task "${title.trim()}" and report the outcome.`,
            user_words: `${HARD_TASK_PROMPT_MARKER} ${title.trim()}`,
            shape: { intelligence: "high", rigor_ask: "quick" },
          },
        },
      ],
    };
  };
