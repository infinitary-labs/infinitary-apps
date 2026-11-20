import type { Scenario } from "../mockProvider";

/**
 * A move of repositories proposed by the first mate (docs/fleet.md, "Moving a
 * repository to another project"): the captain's message carrying
 * `PROJECT_MOVE_MARKER` gets one `app_change project-move` with no
 * `on_words`, so the app puts up its move card instead of moving.
 */
export const PROJECT_MOVE_MARKER = "combine the ledger projects";

export const projectMove =
  (move: { repoIds: string[]; project: string }): Scenario =>
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes(PROJECT_MOVE_MARKER)) return undefined;
    return {
      calls: [
        {
          name: "app_change",
          args: {
            action: "project-move",
            value: move,
            evidence: `the captain asked to ${PROJECT_MOVE_MARKER}`,
          },
        },
      ],
    };
  };
