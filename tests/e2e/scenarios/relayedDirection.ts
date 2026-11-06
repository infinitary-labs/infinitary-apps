import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * Hermetic replay for INF-638, not a claim that a live model obeys: the
 * captain saves a standing direction by a choice on a crewmate's card, and
 * never types it. The crewmate puts up a decision whose default saves the
 * direction; his click on it reaches the crewmate, which reports it with
 * needs_firstmate. The first mate, woken by that report and not by his
 * words, saves the direction on its own judgment through app_change, the
 * same app action catalog path as every setting. The journey that names
 * this scenario passes a `seen` box, where the first mate's tool results
 * land for it to read.
 */
// e2e-typed-words: the captain's own words that start a scripted spawn; they only share a phrase with the product's
export const RELAYED_DIRECTION_MARKER = "weigh the slow alpha";
export const RELAYED_DIRECTION_CARD = "The alpha's late failures cost a day";
export const RELAYED_DIRECTION_CHOICE = { id: "save-direction", label: "Save the direction" };
export const RELAYED_DIRECTION =
  "A fix for a broken main merges on its own once all of its checks pass.";
/** The first mate's reason, which the direction's history keeps. */
// e2e-typed-words: the scripted first mate's own reason; it only shares a phrase with the product's
export const RELAYED_DIRECTION_REASON = `The captain chose "${RELAYED_DIRECTION_CHOICE.label}" on the crewmate's card about the slow alpha.`;
const RELAY_ASK = `save the standing direction the captain chose: ${RELAYED_DIRECTION}`;

export type RelayedDirectionSeen = { results: string[] };

export function relayedDirection(seen: RelayedDirectionSeen): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) =>
      wantsStream ? move(body, isFirstmate, seen) : undefined;
}

function move(
  body: string,
  firstmate: boolean,
  seen: RelayedDirectionSeen,
): ScenarioAnswer | undefined {
  const { user, results } = sinceLastUser(body);
  if (firstmate) {
    // Only the report that relays his choice; the shared stand-in spawns.
    if (!user.includes(RELAY_ASK)) return undefined;
    if (results.length > 0) {
      seen.results.push(...results);
      return { text: "Recorded the direction you chose." };
    }
    return {
      calls: [
        {
          name: "app_change",
          args: {
            action: "direction",
            value: { op: "add", scope: "captain", text: RELAYED_DIRECTION },
            evidence: RELAYED_DIRECTION_REASON,
          },
        },
      ],
    };
  }
  if (!body.includes(RELAYED_DIRECTION_MARKER)) return undefined;
  if (results.length > 0) return { text: "Reported." };
  if (user.includes(`"${RELAYED_DIRECTION_CHOICE.label}"`)) {
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `The captain chose "${RELAYED_DIRECTION_CHOICE.label}" on the card: ${RELAYED_DIRECTION}`,
            summary: "The captain chose to save the standing direction.",
            needs_firstmate: RELAY_ASK,
          },
        },
      ],
    };
  }
  return {
    calls: [
      {
        name: "emit_card",
        args: {
          title: RELAYED_DIRECTION_CARD,
          body: `<p>Three failed versions held the alpha for nine hours.</p><p>Fix: ${RELAYED_DIRECTION}</p>`,
          actions: [
            { ...RELAYED_DIRECTION_CHOICE, default: true },
            { id: "not-now", label: "Not now" },
          ],
        },
      },
      { name: "report", args: { text: "The slowdown and its fix are on the card." } },
    ],
  };
}
