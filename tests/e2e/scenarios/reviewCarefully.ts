import { REVIEW_HANDOFF_NEXT } from "../../../src/core/orchestrator/reportWakes";
import { REVIEW_CAREFULLY_WORDS } from "../../../src/shared/vocabulary";
import { noSurfaceProof } from "../../helpers/liveValidation";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import {
  MOCK_STANDARD_DRAWN_BODY,
  MOCK_STANDARD_MERGE_ONLY_ACTIONS,
  MOCK_STANDARD_REPORT,
} from "../crewCards";
import { REVIEW_CAREFULLY_MARKER, type Scenario } from "../mockProvider";
import { calledTool, providerMessages, sinceLastUser } from "../providerRequest";
import { liveReviewAnswer, MOCK_REVIEWED_CHANGE, REVIEW_BRIEF_MARKER } from "./reviewedTier";

/**
 * Review carefully (INF-562, review-carefully e2e). Briefed with
 * `REVIEW_CAREFULLY_MARKER` on a direct-pr repository at Default care, the
 * mock crewmate saves its change and emits its completion card. The
 * captain's Review carefully reaches it as a choice, and it reports without
 * pushing. The app starts the review of the version the card offered
 * (INF-1875); the mock reviewer passes a brief that names the card the
 * captain read; told the review passed, the crewmate emits its completion
 * card again. A journey names it before `reviewedTier`; the host delivers the pass
 * directly to the builder.
 */

export const MOCK_CAREFUL_CARD_TITLE = "The meter reads on time, ready to merge";
export const MOCK_CAREFUL_REVIEWED_CARD_TITLE = "The meter reads on time, reviewed";
/** The careful builder's report after Review carefully: committed, nothing pushed. */
export const MOCK_CAREFUL_BUILDER_REPORT =
  "Intent: the meter reads on the first paint. What changed: nothing since the merge card; the work is committed and nothing was pushed. Verified: pnpm test on the final commit; the pull request's checks passed at its version. Risk: low. Not done: the review.";

export const reviewCarefully: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream) return undefined;
    // INF-125 / INF-562: the merge-card review uses the same assigned,
    // typed no-surface judgment as the lifecycle review.
    if (body.includes(REVIEW_BRIEF_MARKER)) {
      return body.includes(MOCK_CAREFUL_CARD_TITLE)
        ? liveReviewAnswer(body, hasToolResults)
        : undefined;
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
    if (latestUserTail.includes(REVIEW_HANDOFF_NEXT.ship)) {
      return hasToolResults ? { text: "done" } : { calls: card(MOCK_CAREFUL_REVIEWED_CARD_TITLE) };
    }
    if (
      latestUserTail.includes("the user chose") &&
      latestUserTail.includes(REVIEW_CAREFULLY_WORDS)
    ) {
      // Its plan and proof at this version are on the record from before
      // the card (INF-994: records are kept at every care), and the app
      // started the review at that version, so the report is one turn.
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
    if (!calledTool(body, "check_change")) return { calls: [{ name: "check_change", args: {} }] };
    // INF-125 / INF-562: the actual committed empty branch has no running
    // surface; the builder declares that and records its proof at the
    // version it read, before its card - a Default-care record the app keeps.
    const results = sinceLastUser(body).results;
    if (!calledTool(body, "report")) {
      return {
        calls: [
          {
            name: "report",
            args: {
              text: "The lifecycle fixture has no running product.",
              validation: {
                kind: "plan",
                previousRevision: 0,
                reason: "Only the empty lifecycle fixture's history changes.",
                scenarios: [],
              },
            },
          },
        ],
      };
    }
    if (!results.some((result) => result.includes("Validation recorded at evidence revision"))) {
      const head = providerMessages(body)
        .filter((message) => message.role === "tool")
        .map((message) => message.text)
        .join("\n")
        .match(/head ([a-f0-9]{40})/)?.[1];
      if (!head) throw new Error("The scripted builder needs its actual checked version.");
      const {
        revision: _revision,
        deviceId: _deviceId,
        at: _at,
        ...run
      } = noSurfaceProof(head).runs[0]!;
      return {
        calls: [
          {
            name: "report",
            args: {
              text: "The empty branch has no running surface to exercise.",
              validation: { ...run, id: `fixture-${head}`, evidence: [] },
            },
          },
        ],
      };
    }

    return calledTool(body, "emit_card")
      ? { text: "done" }
      : { calls: card(MOCK_CAREFUL_CARD_TITLE) };
  };
