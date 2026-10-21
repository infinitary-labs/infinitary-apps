import { REVIEW_CAREFULLY_WORDS } from "../../../src/shared/vocabulary";
import {
  calledTool,
  MOCK_STANDARD_DRAWN_BODY,
  MOCK_STANDARD_MERGE_ONLY_ACTIONS,
  MOCK_STANDARD_REPORT,
  REVIEW_CAREFULLY_MARKER,
  type Scenario,
  type ScriptedCall,
} from "../mockProvider";
import {
  MOCK_REVIEW_PASS_REPORT,
  MOCK_REVIEW_PASSED_STEER,
  MOCK_REVIEWED_CHANGE,
  REVIEW_BRIEF_MARKER,
} from "./reviewedTier";

/**
 * Review carefully (INF-562, review-carefully e2e). Briefed with
 * `REVIEW_CAREFULLY_MARKER` on a direct-pr repository at Default care, the
 * mock crewmate saves its change and emits its completion card. The
 * captain's Review carefully reaches it as a choice, and it reports without
 * pushing, in the words the reviewed tier's first mate answers with a
 * review. The mock reviewer passes a brief that names the card the captain
 * read; told the review passed, the crewmate emits its completion card
 * again. A journey names it before `reviewedTier`, whose first mate starts
 * the review and releases the hold.
 */

export const MOCK_CAREFUL_CARD_TITLE = "The meter reads on time, ready to merge";
export const MOCK_CAREFUL_REVIEWED_CARD_TITLE = "The meter reads on time, reviewed";
/** The careful builder's report after Review carefully: committed, nothing pushed. */
export const MOCK_CAREFUL_BUILDER_REPORT =
  "Intent: the meter reads on the first paint. What changed: nothing since the merge card; the work is committed and nothing was pushed. Verified: pnpm test on the final commit; the PR is green on its head. Risk: low. Not done: the review.";

export const reviewCarefully: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // A review the captain asked for from his merge card passes once its
    // brief names the card he read; any other review is `reviewedTier`'s.
    if (body.includes(REVIEW_BRIEF_MARKER)) {
      return body.includes(MOCK_CAREFUL_CARD_TITLE) ? { text: MOCK_REVIEW_PASS_REPORT } : undefined;
    }
    // The careful builder: its change and completion card at Default care;
    // after Review carefully a report with nothing pushed; after the pass
    // its completion card again.
    if (!body.includes(REVIEW_CAREFULLY_MARKER)) return undefined;
    const card = (title: string): ScriptedCall[] => [
      {
        name: "emit_card",
        args: {
          title,
          body: MOCK_STANDARD_DRAWN_BODY,
          actions: MOCK_STANDARD_MERGE_ONLY_ACTIONS,
        },
      },
      { name: "report", args: { text: MOCK_STANDARD_REPORT } },
    ];
    if (latestUserTail.includes(MOCK_REVIEW_PASSED_STEER)) {
      return hasToolResults ? { text: "done" } : { calls: card(MOCK_CAREFUL_REVIEWED_CARD_TITLE) };
    }
    if (
      latestUserTail.includes("the user chose") &&
      latestUserTail.includes(REVIEW_CAREFULLY_WORDS)
    ) {
      return { text: MOCK_CAREFUL_BUILDER_REPORT };
    }
    if (!calledTool(body, "bash")) {
      return {
        calls: [
          {
            name: "bash",
            args: { command: `git commit --allow-empty -m "${MOCK_REVIEWED_CHANGE.title}"` },
          },
        ],
      };
    }
    return calledTool(body, "emit_card")
      ? { text: "done" }
      : { calls: card(MOCK_CAREFUL_CARD_TITLE) };
  };
