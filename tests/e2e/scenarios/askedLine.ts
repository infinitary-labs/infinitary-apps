import type { Scenario } from "../mockProvider";

/** A short message of the captain's, answered on one card. */
export const SHORT_ASK = "what does the port flag do?";

/** A long message of three paragraphs, the kind the line must not show whole. */
export const LONG_ASK = [
  "did something change about how we order the cards in the stack? this morning a card I had replied under jumped behind two newer notes, and then the merge card for the footer fix showed up first even though I had been reading the plan card.",
  "I'm not sure whether that's the new reply rule or something else. could you check what changed in the last few days, and whether the order is still the one we agreed on in the design skill?",
  "if it is a regression, please fix it, but keep the minimize behavior as it is.",
].join("\n\n");

/** The title of the first mate's answer to each message. */
export const ASKED_TITLES = {
  short: "It picks the port the app listens on",
  long: "Yes: a card you replied under keeps its place",
} as const;

/**
 * The first mate answers either message with one note of its own, marked
 * `answering`, whose body never repeats the captain's words (INF-1610).
 */
export const askedLine: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    const which = latestUserTail.includes(LONG_ASK.slice(0, 60))
      ? "long"
      : latestUserTail.includes(SHORT_ASK)
        ? "short"
        : undefined;
    if (!which) return undefined;
    if (hasToolResults) return { text: "Answered on the card." };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: ASKED_TITLES[which],
            standalone: true,
            answering: true,
            body: "<p>The stack now keeps a card you replied under in its place while its author answers.</p>",
          },
        },
      ],
    };
  };
