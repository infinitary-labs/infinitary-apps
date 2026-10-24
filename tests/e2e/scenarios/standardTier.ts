import type { ScriptedCardAction } from "../../helpers/scriptedCalls";
import {
  MOCK_STANDARD_CARD_BODY,
  MOCK_STANDARD_DRAWN_BODY,
  MOCK_STANDARD_MERGE_ONLY_ACTIONS,
  MOCK_STANDARD_REPORT,
  type Scenario,
  STANDARD_TIER_HOST_BUTTONS_MARKER,
  STANDARD_TIER_PROMPT_MARKER,
  sinceLastUser,
} from "../mockProvider";

export const STANDARD_TIER_MISSING_HEADING_MARKER = "ship at the standard tier missing a heading";

export const MOCK_STANDARD_CARD_TITLE = "The meter test is steady";

const MOCK_STANDARD_CARD_ACTIONS: ScriptedCardAction[] = [
  {
    id: "merge",
    label: "Merge the branch",
    default: true,
    effect: { kind: "settle", mode: "merge" },
  },
  { id: "discard", label: "Discard", danger: true, effect: { kind: "settle", mode: "discard" } },
];

export const MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE = "The meter test is steady, drawn";

/**
 * The standard tier: a completion card missing a heading is refused and
 * sent again whole, a card that declares its own merge buttons is refused,
 * and the crewmate reports under the five headings.
 */
export const standardTier: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // Exercise the real corrective refusal, then publish the correction.
    if (
      !isFirstmate &&
      latestUserTail.includes(STANDARD_TIER_MISSING_HEADING_MARKER) &&
      wantsStream
    ) {
      const results = sinceLastUser(body).results;
      if (results.length === 0) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_STANDARD_CARD_TITLE,
                body: MOCK_STANDARD_CARD_BODY.replace(/<h3>Before<\/h3>/, ""),
                actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
              },
            },
          ],
        };
      } else if (results.length === 1) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_STANDARD_CARD_TITLE,
                body: MOCK_STANDARD_CARD_BODY,
                actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
              },
            },
            { name: "report", args: { text: MOCK_STANDARD_REPORT } },
          ],
        };
      } else {
        return { text: "The corrected completion outline is shown." };
      }
    }
    // The host-attached buttons and the freed body (contract v3.6): one
    // declared merge under an invented label, a body that draws its
    // answer rather than repeating the record, and the report that still
    // carries the five headings.
    if (!isFirstmate && latestUserTail.includes(STANDARD_TIER_HOST_BUTTONS_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_STANDARD_HOST_BUTTONS_CARD_TITLE,
                body: MOCK_STANDARD_DRAWN_BODY,
                actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
              },
            },
            { name: "report", args: { text: MOCK_STANDARD_REPORT } },
          ],
        };
      }
      return { text: "done" };
    }
    // The standard-tier crewmate (delivery rigor phase 1): its completion
    // card carries the five headings as sections and its report is the
    // same five headings in prose, in one turn; the follow-up leg closes
    // briefly, so the explicit report is the one Firstmate hears.
    if (!isFirstmate && latestUserTail.includes(STANDARD_TIER_PROMPT_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                title: MOCK_STANDARD_CARD_TITLE,
                body: MOCK_STANDARD_CARD_BODY,
                actions: MOCK_STANDARD_CARD_ACTIONS,
              },
            },
            { name: "report", args: { text: MOCK_STANDARD_REPORT } },
          ],
        };
      }
      return { text: "done" };
    }
    return undefined;
  };
