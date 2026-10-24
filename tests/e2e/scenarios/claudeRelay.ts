import { CLAUDE_CREW_PROMPT_MARKER, type Scenario } from "../mockProvider";

/**
 * A Claude crewmate that relays a captain decision only the Firstmate can
 * carry out (FI3-710). A commission whose title carries this phrase beside
 * CLAUDE_CREW_PROMPT_MARKER puts up MOCK_CLAUDE_PLAN_CARD_TITLE, a decision
 * with two actions, and reports. A captain reply carrying
 * CLAUDE_RELAY_APPROVAL is answered with one thread line
 * (MOCK_CLAUDE_RELAY_ANSWER), the card left as it is, and a report that
 * quotes his words and declares needs_firstmate (MOCK_CLAUDE_RELAY_ASK).
 */
export const CLAUDE_RELAY_MARKER = "with a plan to approve";
export const MOCK_CLAUDE_PLAN_CARD_TITLE = "Raise the rivet threshold";
export const MOCK_CLAUDE_PLAN_REPORT = "The plan to raise the rivet threshold is on its card.";
export const CLAUDE_RELAY_APPROVAL =
  "for decision 5, raise the threshold from 8 to 32. now approve to build";
export const MOCK_CLAUDE_RELAY_ANSWER =
  "The first mate starts the builder next, with the threshold at 32.";
export const MOCK_CLAUDE_RELAY_ASK = "start the builder on the approved plan, threshold 32";
export const MOCK_CLAUDE_RELAY_REPORT = `The captain approved the plan by reply: "${CLAUDE_RELAY_APPROVAL}". The final plan keeps every decision, with the threshold at 32.`;

/** The Claude crewmate's plan card and report, then its relay of the captain's approval by reply. */
export const claudeRelay: Scenario =
  () =>
  ({ body, isFirstmate, anthropicMessages, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !anthropicMessages || !wantsStream) return undefined;
    if (!body.includes(CLAUDE_CREW_PROMPT_MARKER) || !body.includes(CLAUDE_RELAY_MARKER))
      return undefined;
    if (hasToolResults) return { text: "done" };
    const cardId = latestUserTail.includes(CLAUDE_RELAY_APPROVAL)
      ? latestUserTail.match(/\((card-[\w-]+)\)/)?.[1]
      : undefined;
    if (cardId) {
      return {
        calls: [
          { name: "reply", args: { card_id: cardId, text: MOCK_CLAUDE_RELAY_ANSWER } },
          {
            name: "report",
            args: { text: MOCK_CLAUDE_RELAY_REPORT, needs_firstmate: MOCK_CLAUDE_RELAY_ASK },
          },
        ],
      };
    }
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: MOCK_CLAUDE_PLAN_CARD_TITLE,
            body: "<p>Raise the rivet threshold before the next inspection.</p><p>Decision 5 sets it to 8 today.</p>",
            actions: [
              { id: "build", label: "Approve and build", default: true },
              { id: "later", label: "Not now" },
            ],
          },
        },
        { name: "report", args: { text: MOCK_CLAUDE_PLAN_REPORT } },
      ],
    };
  };
