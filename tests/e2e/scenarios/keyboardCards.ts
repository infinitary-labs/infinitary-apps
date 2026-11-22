import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";

/**
 * Marker prompt: the mock crewmate emits two notes that each hold a text
 * field, one drawn inline (no script) and one served at a host of its own (a
 * script), so a key can be pressed with focus inside either kind of card
 * frame (tests/e2e/keyboard-routing.spec.ts).
 */
export const KEYBOARD_CARDS_PROMPT_MARKER = "show the keyboard cards";
export const KEYBOARD_CARD_TITLES = {
  inline: "A note field drawn inline",
  served: "A note field served on its own",
} as const;

function keyboardCardToolCalls(): ScriptedCall[] {
  const field =
    '<p>Write the note here.</p><p><label>Note <textarea name="note"></textarea></label></p>';
  return [
    { name: "emit_card", args: { title: KEYBOARD_CARD_TITLES.inline, body: field } },
    {
      name: "emit_card",
      args: {
        title: KEYBOARD_CARD_TITLES.served,
        body: `${field}<script>document.querySelector("textarea").placeholder = "a short note";</script>`,
      },
    },
  ];
}

export const keyboardCards: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults) return undefined;
    return latestUserTail.includes(KEYBOARD_CARDS_PROMPT_MARKER)
      ? { calls: keyboardCardToolCalls() }
      : undefined;
  };
