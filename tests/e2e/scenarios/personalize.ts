import { PERSONAL_WORKSPACE_NAME } from "../../../src/core/paths";
import { contextRepos, type Scenario } from "../mockProvider";

export const PERSONALIZE_HIDE_PROMPT_MARKER = "hide tasks";

export const PERSONALIZE_SHOW_PROMPT_MARKER = "show tasks again";

export const PERSONALIZE_INSTRUCTION_PROMPT_MARKER = "always use compact rows in my panels";

/** The standing instruction the mock Firstmate writes for that turn. */
export const MOCK_STANDING_INSTRUCTION = "Always use compact rows in my panels.";

/** The first mate hides and shows the tasks panel, and writes a standing instruction, each with one call and no card. */
export const personalize: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(PERSONALIZE_HIDE_PROMPT_MARKER)) {
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "panel",
              value: { surface: "now", visible: false },
              evidence: "hide tasks",
            },
          },
        ],
      };
    }
    if (!hasToolResults && latestUserTail.includes(PERSONALIZE_SHOW_PROMPT_MARKER)) {
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "panel",
              value: { surface: "now", visible: true },
              evidence: "show tasks again",
            },
          },
        ],
      };
    }
    if (!hasToolResults && latestUserTail.includes(PERSONALIZE_INSTRUCTION_PROMPT_MARKER)) {
      // A panel instruction is a direction scoped to the personal workspace (INF-1054).
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "direction",
              value: {
                op: "add",
                text: MOCK_STANDING_INSTRUCTION,
                scope: contextRepos(body).find(([name]) => name === PERSONAL_WORKSPACE_NAME)?.[1],
              },
              evidence: "always use compact rows in my panels",
            },
          },
        ],
      };
    }
    return undefined;
  };
