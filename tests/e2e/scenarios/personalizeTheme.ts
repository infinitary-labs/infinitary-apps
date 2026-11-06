import { WELCOME_WAKE_WORDS } from "../../../src/core/orchestrator/wakes";
import type { Scenario } from "../mockProvider";

/**
 * Talk-to-personalize Step 1 (Tier A): the mock Firstmate answers "switch to
 * light" with ONE app_change call and no card, the way the contract says.
 */
export const PERSONALIZE_THEME_PROMPT_MARKER = "switch to light";

/** The first mate switches the theme to light. The first-run wake outranks it, as in the shared stand-in. */
export const personalizeTheme: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (latestUserTail.includes(WELCOME_WAKE_WORDS)) return undefined;
    if (!latestUserTail.includes(PERSONALIZE_THEME_PROMPT_MARKER)) return undefined;
    return {
      calls: [
        {
          name: "app_change",
          args: { action: "theme", value: { theme: "light" }, evidence: "switch to light" },
        },
      ],
    };
  };
