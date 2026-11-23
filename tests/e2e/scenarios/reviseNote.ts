import type { Scenario } from "../mockProvider";
import { answering } from "../providerRequest";
import { MOCK_QUOTA_NOTE_TITLE } from "./everyCardKind";

export const MOCK_REVISED_NOTE_TEXT = "Codex weekly is now at 58% - still routing on pace.";

/**
 * INF-2022: a reply asks the card-kinds crewmate to revise its retained note
 * in place (same id, WI-12), releasing a new unread update.
 */
export const REVISE_NOTE_PROMPT_MARKER = "revise the quota note";

export const reviseNote: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (
      !isFirstmate &&
      latestUserTail.includes(REVISE_NOTE_PROMPT_MARKER) &&
      !hasToolResults &&
      wantsStream
    ) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "quota-note",
              // INF-2022: an emit under a waiting thread must answer the captain too.
              // Without this, CardService refuses the revision and leaves the original body intact.
              reply: "I updated the weekly reading under Quota note.",
              ...answering(latestUserTail),
              title: MOCK_QUOTA_NOTE_TITLE,
              body: `<p>${MOCK_REVISED_NOTE_TEXT}</p>`,
            },
          },
        ],
      };
    }
    return undefined;
  };
