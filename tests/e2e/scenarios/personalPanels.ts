import { CREATE_PANEL_DRAFT } from "../../../src/shared/createPanelSlot";
import { MOCK_PANEL_REPORT, MOCK_PANEL_REVISED_REPORT } from "../crewScripts";
import type { Scenario } from "../mockProvider";

/**
 * The talk-to-personalize build loop (Step 4). "make me a panel: <title>",
 * or the words the create-your-own-panel slot puts in the message box
 * finished by the captain, makes the mock Firstmate spawn with personal_ui
 * true; "remove my panel <id>" is the Tier A `personalize remove`. The
 * crewmate that builds the panel answers the host's own build-in-place
 * brief, so it stays in the shared stand-in. Its report reaches the first
 * mate like any other, and the first mate closes the build as finished
 * (INF-1677).
 */
export const PERSONAL_PANEL_PROMPT_MARKER = "make me a panel:";
export const PERSONAL_REMOVE_PROMPT_MARKER = "remove my panel ";

export const personalPanels: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    const reported = latestUserTail.match(/reported on task ([\w-]+)/)?.[1];
    if (
      reported &&
      (latestUserTail.includes(MOCK_PANEL_REPORT) ||
        latestUserTail.includes(MOCK_PANEL_REVISED_REPORT))
    ) {
      return {
        calls: [
          {
            name: "settle_task",
            args: {
              task_id: reported,
              mode: "done",
              why: "finished",
              evidence: "the panel is on the rail and its report saved it",
              closing_sentence: "Your panel is built.",
            },
          },
        ],
      };
    }
    if (latestUserTail.includes(PERSONAL_REMOVE_PROMPT_MARKER)) {
      const surface = latestUserTail.match(/remove my panel ([a-z0-9-]+)/)?.[1]?.trim() as string;
      return {
        calls: [
          {
            name: "personalize",
            args: { action: "remove", surface, evidence: `remove my panel ${surface}` },
          },
        ],
      };
    }
    // The marker, or the words the create-your-own-panel slot puts in
    // the message box, finished by the captain.
    const slotAsk = latestUserTail.match(new RegExp(`${CREATE_PANEL_DRAFT}([^"\\\\]+)`));
    if (latestUserTail.includes(PERSONAL_PANEL_PROMPT_MARKER) || slotAsk) {
      const title =
        (latestUserTail.match(/make me a panel: ([^"\\]+)/) ?? slotAsk)?.[1]?.trim() ?? "A panel";
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title,
              goal: `Add a panel: ${title}`,
              user_words: slotAsk ? `${CREATE_PANEL_DRAFT}${title}` : `make me a panel: ${title}`,
              personal_ui: true,
            },
          },
        ],
      };
    }
    return undefined;
  };
