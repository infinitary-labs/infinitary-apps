import type { Scenario } from "../mockProvider";

/** The note the mock Firstmate remembers on REMEMBER_PROMPT_MARKER and retires on FORGET_PROMPT_MARKER. */
export const MOCK_NOTE = { id: "squash-merges", content: "Always squash-merge when landing work." };

export const REMEMBER_PROMPT_MARKER = "remember that I always squash-merge";

export const FORGET_PROMPT_MARKER = "forget the squash-merge note";

export const notes: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(REMEMBER_PROMPT_MARKER)) {
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "direction",
              value: { op: "add", id: MOCK_NOTE.id, text: MOCK_NOTE.content },
              evidence: "captain said always squash-merge",
            },
          },
        ],
      };
    }
    if (!hasToolResults && latestUserTail.includes(FORGET_PROMPT_MARKER)) {
      return {
        calls: [
          {
            name: "app_change",
            args: {
              action: "direction",
              value: { op: "retire", id: `d:${MOCK_NOTE.id}`, expectedRevision: 1 },
              evidence: "captain said to forget it",
            },
          },
        ],
      };
    }
    return undefined;
  };
