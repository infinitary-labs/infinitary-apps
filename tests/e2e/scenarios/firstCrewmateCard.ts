import type { Scenario } from "../mockProvider";

/** The ask's marker, in the title the first mate gives its crewmate. */
export const FIRST_CREWMATE_ASK = "fix the readme typo";
export const FIRST_CREWMATE_CARD_TITLE = "The readme typo is fixed";

/**
 * A new person's first crewmate (docs/first-launch.md, "The first
 * crewmate's note"): its first card, a choice, is held until the journey
 * lets it go (`releaseThreadAnswer`), so the journey reads the note and the
 * open stage after Got it as an order before the card arrives.
 */
export const firstCrewmateCard: Scenario = () => (request) => {
  if (request.isFirstmate || !request.wantsStream) return undefined;
  if (!request.body.includes(FIRST_CREWMATE_ASK)) return undefined;
  if (request.hasToolResults) return { text: "done" };
  return {
    threadHeld: [
      {
        name: "emit_card",
        args: {
          title: FIRST_CREWMATE_CARD_TITLE,
          body: "<p>The first line of the readme said Welcom. It now says Welcome.</p>",
          actions: [
            { id: "keep-it", label: "Keep the fix", default: true },
            { id: "undo-it", label: "Undo it" },
          ],
        },
      },
      { name: "report", args: { text: "The readme typo is fixed; the card asks to keep it." } },
    ],
  };
};
