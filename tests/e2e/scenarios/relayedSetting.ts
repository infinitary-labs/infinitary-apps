import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * Hermetic replay for INF-751, not a claim that a live model obeys: the
 * captain chooses a setting on a crewmate's card and never types it. The
 * crewmate puts up a decision whose default switches the app to the light
 * theme; his click reaches the crewmate, which reports it with
 * needs_firstmate. The first mate, woken by that report and not by his
 * words, applies the catalog's `theme` line through app_change with his
 * choice as its evidence. The journey that names this scenario passes a
 * `seen` box, where the first mate's tool results land for it to read.
 */
// e2e-typed-words: the captain's own words that start a scripted spawn; they only share a phrase with the product's
export const RELAYED_SETTING_MARKER = "compare the board in both themes";
export const RELAYED_SETTING_CARD = "The task board reads better in the light theme";
export const RELAYED_SETTING_CHOICE = { id: "use-light", label: "Use the light theme" };
/** The first mate's evidence: his choice, as the crewmate relayed it. */
// e2e-typed-words: the scripted first mate's own evidence; it only shares a phrase with the product's
export const RELAYED_SETTING_EVIDENCE = `The captain chose "${RELAYED_SETTING_CHOICE.label}" on the crewmate's card about the task board.`;
const RELAY_ASK = "switch the app to the light theme, as the captain chose on my card";

export type RelayedSettingSeen = { results: string[] };

export function relayedSetting(seen: RelayedSettingSeen): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) =>
      wantsStream ? move(body, isFirstmate, seen) : undefined;
}

function move(
  body: string,
  firstmate: boolean,
  seen: RelayedSettingSeen,
): ScenarioAnswer | undefined {
  const { user, results } = sinceLastUser(body);
  if (firstmate) {
    // Only the report that relays his choice; the shared stand-in spawns.
    if (!user.includes(RELAY_ASK)) return undefined;
    if (results.length > 0) {
      seen.results.push(...results);
      return { text: "Switched to the light theme you chose." };
    }
    return {
      calls: [
        {
          name: "app_change",
          args: {
            action: "theme",
            value: { theme: "light" },
            evidence: RELAYED_SETTING_EVIDENCE,
          },
        },
      ],
    };
  }
  if (!body.includes(RELAYED_SETTING_MARKER)) return undefined;
  if (results.length > 0) return { text: "Reported." };
  if (user.includes(`"${RELAYED_SETTING_CHOICE.label}"`)) {
    return {
      calls: [
        {
          name: "report",
          args: {
            text: `The captain chose "${RELAYED_SETTING_CHOICE.label}" on the card.`,
            summary: "The captain chose the light theme for the task board.",
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
          title: RELAYED_SETTING_CARD,
          body: "<p>Task keys and their lanes keep more contrast in the light theme.</p><p>Fix: switch the app to the light theme.</p>",
          actions: [
            { ...RELAYED_SETTING_CHOICE, default: true },
            { id: "keep-dark", label: "Keep the dark theme" },
          ],
        },
      },
      { name: "report", args: { text: "The comparison and its choice are on the card." } },
    ],
  };
}
