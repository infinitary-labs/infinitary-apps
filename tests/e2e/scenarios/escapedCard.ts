import { completionCardBody } from "../../helpers/completionCard";
import type { ScriptedCardAction } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";

/**
 * The Sep 15 Claude crewmate case (contract v2.0): a completion card whose
 * body arrives entity-escaped. The mock crewmate emits it that way first,
 * and emits the raw-tag version only after the tool result names the
 * escaping - so the corrected card on screen is proof the refusal said so.
 */
export const ESCAPED_CARD_PROMPT_MARKER = "show an escaped card";

export const MOCK_ESCAPED_CARD_TITLE = "Transcript scroll is fixed";

export const MOCK_ESCAPED_CARD_LEAD = "PR 140 keeps the transcript on its newest line.";

const MOCK_ESCAPED_CARD_ACTIONS: ScriptedCardAction[] = [
  {
    id: "merge",
    label: "Merge the branch",
    default: true,
    effect: { kind: "settle", mode: "merge" },
  },
  { id: "discard", label: "Discard", danger: true, effect: { kind: "settle", mode: "discard" } },
];

/** The escaped card's one list item, which the frame must show as words, never as markup. */
export const MOCK_ESCAPED_CARD_ITEM = "Scrolls with the stream, stops when you scroll up.";

const MOCK_ESCAPED_CARD_BODY = completionCardBody(
  "<p>The newest transcript line should stay in view.</p>",
  "<p>The transcript follows the stream until you scroll up.</p>",
  "<p>The newest line could scroll out of view.</p>",
  `<p>${MOCK_ESCAPED_CARD_LEAD}</p><ul><li>${MOCK_ESCAPED_CARD_ITEM}</li></ul>`,
);

const ESCAPED_BODY_REFUSAL_PHRASE = "arrived HTML-escaped";

/** A crewmate whose card body arrives entity-escaped is refused once and sends it again as markup. */
export const escapedCard: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (!isFirstmate && latestUserTail.includes(ESCAPED_CARD_PROMPT_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_ESCAPED_CARD_TITLE,
                body: MOCK_ESCAPED_CARD_BODY.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
                actions: MOCK_ESCAPED_CARD_ACTIONS,
              },
            },
          ],
        };
      }
      if (
        latestUserTail.includes(ESCAPED_BODY_REFUSAL_PHRASE) &&
        !latestUserTail.includes(`Card shown: ${MOCK_ESCAPED_CARD_TITLE}`)
      ) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_ESCAPED_CARD_TITLE,
                body: MOCK_ESCAPED_CARD_BODY,
                actions: MOCK_ESCAPED_CARD_ACTIONS,
              },
            },
          ],
        };
      }
      // The card is up: the turn ends with the plain-text report below.
    }
    return undefined;
  };
