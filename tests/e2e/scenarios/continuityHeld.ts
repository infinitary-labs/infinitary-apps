import type { Scenario } from "../mockProvider";

/** The captain's words that ask the first mate for the marked card. */
export const CONTINUITY_HELD_ASK = "raise the harbour master's question when I say";
/** The marked card's title. */
export const CONTINUITY_HELD_TITLE = "The harbour master needs an answer";

/**
 * A first mate card marked `holds_place`, held until the journey lets it go
 * (`releaseThreadAnswer`), so the journey can type in the shown card before
 * it arrives and read the arrival as an order, not a race.
 */
export const continuityHeld: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes(CONTINUITY_HELD_ASK)) return undefined;
    return {
      threadHeld: [
        {
          name: "emit_card",
          args: {
            id: "harbour-master",
            title: CONTINUITY_HELD_TITLE,
            body: "<p>The harbour master asks which berth the crew wants.</p>",
            holds_place: true,
            actions: [
              { id: "north", label: "North berth", default: true },
              { id: "south", label: "South berth" },
            ],
          },
        },
      ],
    };
  };
