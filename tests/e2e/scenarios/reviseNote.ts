import type { Scenario } from "../mockProvider";
import { MOCK_QUOTA_NOTE_TITLE } from "./everyCardKind";

export const MOCK_REVISED_NOTE_TEXT = "Codex weekly is now at 58% - still routing on pace.";

/**
 * Marker steer: the card-kinds crewmate revises its "Quota note" in place
 * (same id, WI-12), so a collapsed note can come back (fable review M1).
 */
export const REVISE_NOTE_PROMPT_MARKER = "revise the quota note";

/** A crewmate revises its own note in place under the same id. */
export const reviseNote: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // The mock crewmate: the card e2e answers a marked brief with
    // emit_card tool calls; the follow-up (carrying tool results)
    // finishes with plain text.
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
              title: MOCK_QUOTA_NOTE_TITLE,
              body: `<p>${MOCK_REVISED_NOTE_TEXT}</p>`,
            },
          },
        ],
      };
    }
    return undefined;
  };
