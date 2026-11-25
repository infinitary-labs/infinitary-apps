import { TAG_SUGGESTION_MARKER } from "../../../src/core/orchestrator/tagSuggestionNote";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * Suggest tags from Settings to the first mate's card (docs/task-tags.md,
 * "Suggesting tags"). Hermetic replay of the host's part, not a claim that a
 * live model follows the steps: the stand-in first mate answers only a turn
 * whose note the press added and which names the project by its key, with
 * one decision card of suggested tags.
 */
export const SUGGEST_TAGS_PROJECT = { id: "repo-harbour", name: "harbour", key: "HAR" };
export const SUGGEST_TAGS_CARD_TITLE = "Which tags should harbour have?";

export const suggestTags: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (!wantsStream || !isFirstmate) return undefined;
    const { user, results } = sinceLastUser(body);
    if (!user.includes(TAG_SUGGESTION_MARKER)) return undefined;
    if (!user.includes(`key ${SUGGEST_TAGS_PROJECT.key}`)) return undefined;
    if (results.length > 0) return { text: "Your suggested tags are on the card." };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            id: "suggest-tags-harbour",
            title: SUGGEST_TAGS_CARD_TITLE,
            asking: true,
            body: [
              "<p>I read harbour's one open task and suggest these tags.</p>",
              '<fieldset><legend>Tags to add</legend><label><input type="checkbox" name="tags" value="bug" data-inf-recommended> bug: something that used to work is broken now; not new work.</label></fieldset>',
            ].join(""),
            actions: [
              { id: "add", label: "Add the ticked tags", default: true },
              { id: "not-now", label: "Not now", declines: true },
            ],
          },
        },
      ],
    };
  };
