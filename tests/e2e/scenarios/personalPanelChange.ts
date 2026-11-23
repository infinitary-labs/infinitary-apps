import type { Scenario } from "../mockProvider";

export const PERSONAL_CHANGE_PROMPT_MARKER = "change my panel ";

export const personalPanelChange: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(PERSONAL_CHANGE_PROMPT_MARKER)) {
      const match = latestUserTail.match(/change my panel ([a-z0-9-]+): ([^"\\]+)/);
      const surface = match?.[1] ?? "unknown";
      const ask = match?.[2]?.trim() ?? "change it";
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: `Change the ${surface} panel`,
              goal: `Change the ${surface} panel: ${ask}`,
              user_words: `change my panel ${surface}: ${ask}`,
              personal_ui: true,
            },
          },
        ],
      };
    }
    return undefined;
  };
