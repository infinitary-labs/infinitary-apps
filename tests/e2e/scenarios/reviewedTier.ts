import { REVIEW_BRIEF_OPENING } from "../../../src/core/orchestrator/intentBrief";
import { PERSONAL_WORKSPACE_NAME } from "../../../src/core/paths";
import { liveValidationSchema } from "../../../src/shared/liveValidation";
import { noSurfaceProof } from "../../helpers/liveValidation";
import type { ScriptedCardAction } from "../../helpers/scriptedCalls";
import {
  calledTool,
  contextRepos,
  findCrewTaskId,
  MOCK_STANDARD_CARD_BODY,
  MOCK_STANDARD_REPORT,
  REVIEWED_TIER_PROMPT_MARKER,
  type Scenario,
  type ScenarioAnswer,
  type ScenarioRequest,
  type ScriptedCall,
} from "../mockProvider";
import { providerMessages } from "../providerRequest";

/**
 * The reviewed tier (delivery rigor phases 2 and 3, rigor-reviewed e2e): a
 * builder asked to ship reviewed reports its green pull request with no
 * card, the first mate spawns the reviewer with `review_of`, and the
 * reviewer's findings, re-reviews, cap and pass run in the contract's
 * order. The shared stand-in still sets `rigor_ask` from the marker on
 * any spawn; only a journey that names this scenario gets the reviewer.
 */

/** The reviewed builder's change: its first save point's subject, and the pull request's title. */
export const MOCK_REVIEWED_CHANGE = {
  title: "fix: make the meter read on time",
  body: "The meter reads on the first paint.",
};
/** The host's review brief, recognised by its fixed opening instruction. */
export const REVIEW_BRIEF_MARKER = REVIEW_BRIEF_OPENING;
export const MOCK_REVIEWED_BUILDER_REPORT =
  "Intent: the meter test passes ten runs in a row. What changed: the test awaits the job queue flush before it reads the meter. Verified: pnpm test and pnpm test:e2e on the final commit; the PR is green on its head. Risk: low, one test file changed. Not done: nothing.";
const REVIEWED_BUILDER_NEEDLE = "the PR is green on its head";
export const MOCK_REVIEW_AUTOFIX_FINDING =
  "F1 error tests/meter.test.ts:12 the flush is awaited after the read, so the race stands - auto-fix";
export const MOCK_REVIEW_ASK_FINDING =
  "F2 warning src/meter.ts:40 the empty-state copy says Later, which the captain retired - ask-user";
export const MOCK_REVIEW_FINDINGS_REPORT = [
  "verdict: findings",
  MOCK_REVIEW_AUTOFIX_FINDING,
  MOCK_REVIEW_ASK_FINDING,
  "risk: medium - one production line moves.",
].join("\n");
export const MOCK_REVIEW_PASS_REPORT =
  "verdict: pass\nNo findings; the flush is awaited before the read now.\nrisk: low - one test file changed.";
export const MOCK_REVIEWED_FIX_REPORT =
  "Fixed F1: the flush is awaited before the read; pushed a new head and the checks passed again.";
export const MOCK_REVIEW_ASK_CARD_TITLE = "Keep the Later copy?";
export const MOCK_REVIEWED_CARD_TITLE = "The meter test is steady, reviewed";
/** "ask the reviewer to look again": the captain's word for the re-review. */
export const REREVIEW_PROMPT_MARKER = "ask the reviewer to look again";
// e2e-typed-words: the mock Firstmate's own steer, which its reviewer answers; it only shares a phrase with the product's hint
export const MOCK_REREVIEW_STEER = "re-review at the new head";
/**
 * The review cap (delivery rigor phase 3). The mock reviewer answers its
 * brief and its first two re-reviews with findings - the third findings is
 * one past the cap, so the host's wake asks for a decision - and the third
 * re-review with a pass. The mock Firstmate turns the cap wake into ONE
 * decision card on the builder's task, a later re-finding into a plain
 * steer, and the captain's answer on the cap card into the steer that
 * reopens the rounds; the builder reports the retry.
 */
export const MOCK_REVIEW_REFINDING =
  "F1 error tests/meter.test.ts:12 the flush is still awaited after the read - auto-fix";
export const MOCK_REVIEW_REFINDINGS_REPORT = [
  "verdict: findings",
  MOCK_REVIEW_REFINDING,
  "risk: medium - one production line moves.",
].join("\n");
export const MOCK_REVIEW_REFIX_STEER = "F1 still stands: move the await before the read.";
export const MOCK_REVIEWED_REFIX_REPORT =
  "Fixed F1 again: the await is before the read now; pushed a new head.";
export const MOCK_REVIEW_CAP_CARD_TITLE = "Three findings rounds on the meter fix";
export const MOCK_REVIEW_CAP_RETRY_LABEL = "Retry with the findings";
export const MOCK_CAP_RETRY_STEER =
  "The captain says retry: fix F1 for good and push, then the reviewer reads it again.";
export const MOCK_REVIEWED_RETRY_REPORT =
  "Retried after the cap: F1 is fixed for good; pushed a new head.";
export const MOCK_REVIEW_PASSED_STEER = "The review passed: emit your completion card now.";
const MOCK_REVIEWED_CARD_ACTIONS: ScriptedCardAction[] = [
  {
    id: "merge",
    label: "Merge the pull request",
    default: true,
    effect: { kind: "settle", mode: "merge" },
  },
  { id: "discard", label: "Discard", danger: true, effect: { kind: "settle", mode: "discard" } },
];

export const reviewedTier: Scenario = () => (request) => {
  if (!request.wantsStream) return undefined;
  return request.isFirstmate ? firstmateMove(request) : crewmateMove(request);
};

/** The first mate's side, in the contract's order. */
function firstmateMove({
  body,
  latestUserTail,
  hasToolResults,
}: ScenarioRequest): ScenarioAnswer | undefined {
  // A reviewed builder's green report: its recorded checks on the wake,
  // then spawn_crewmate with review_of.
  const reviewedReport =
    latestUserTail.includes("reported on task") &&
    latestUserTail.includes(REVIEWED_BUILDER_NEEDLE) &&
    !latestUserTail.includes("with verdict");
  // The wake carries the app's recorded checks (the builder's own
  // reading); the Firstmate acts on them without a tool call.
  if (
    reviewedReport &&
    latestUserTail.includes("recorded checks: green") &&
    !latestUserTail.includes("Commissioned")
  ) {
    const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
    // The captain's own project, never the personal workspace the app keeps beside it.
    const repo = contextRepos(body).find(([name]) => name !== PERSONAL_WORKSPACE_NAME);
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: "Review the meter fix",
            goal: "The pull request is reviewed.",
            user_words: `commission a crewmate: meterlab ${REVIEWED_TIER_PROMPT_MARKER}`,
            ...(repo ? { repo_id: repo[1] } : {}),
            shape: { review_of: taskId },
          },
        },
      ],
    };
  }
  if (hasToolResults) return undefined;
  // The review cap (phase 3): the host's wake is one decision card
  // on the builder's task - retry, a stronger model, or discard.
  if (latestUserTail.includes("past the review cap")) {
    const builderId = latestUserTail.match(/the review of task ([\w-]+)/)?.[1] ?? "missing";
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            task_id: builderId,
            title: MOCK_REVIEW_CAP_CARD_TITLE,
            body:
              "<p>The reviewer found the same race three times; the rounds are spent.</p>" +
              "<ul><li>Retry with the findings, a stronger model on your word, or discard.</li></ul>",
            actions: [
              { id: "retry", label: MOCK_REVIEW_CAP_RETRY_LABEL, default: true },
              {
                id: "discard",
                label: "Discard",
                danger: true,
                effect: { kind: "settle", mode: "discard" },
              },
            ],
          },
        },
      ],
    };
  }
  // The captain's answer on the cap card is no branch here: the
  // spec scripts it (`scriptFirstmateTurn`) from the card it reads.
  // The captain's word for the re-review, once the fix has landed. A
  // captain turn carries the wakes pending before its [user] line, so
  // one that also brought a re-finding steers the builder with it
  // first, the way the contract's Firstmate would do both.
  if (latestUserTail.includes(REREVIEW_PROMPT_MARKER)) {
    const reviewId =
      findCrewTaskId(latestUserTail, "Review: ") ?? findCrewTaskId(body, "Review: ") ?? "missing";
    const refinding = latestUserTail.includes(MOCK_REVIEW_REFINDING)
      ? latestUserTail.match(/the review of task ([\w-]+)/)?.[1]
      : undefined;
    // The head the round is counted at is the builder's own reading
    // (its check_change after the push), already on the record.
    return {
      calls: [
        ...(refinding
          ? [
              {
                name: "steer_crewmate",
                args: { task_id: refinding, message: MOCK_REVIEW_REFIX_STEER },
              } satisfies ScriptedCall,
            ]
          : []),
        { name: "steer_crewmate", args: { task_id: reviewId, message: MOCK_REREVIEW_STEER } },
      ],
    };
  }
  // A re-review's findings: the same auto-fix, steered again, no card.
  if (
    latestUserTail.includes("with verdict findings") &&
    latestUserTail.includes(MOCK_REVIEW_REFINDING)
  ) {
    const builderId = latestUserTail.match(/the review of task ([\w-]+)/)?.[1] ?? "missing";
    return {
      calls: [
        {
          name: "steer_crewmate",
          args: { task_id: builderId, message: MOCK_REVIEW_REFIX_STEER },
        },
      ],
    };
  }
  // The reviewer's findings: the auto-fix is a steer to the builder,
  // the ask-user finding one decision card on the builder's task.
  if (
    latestUserTail.includes("with verdict findings") &&
    latestUserTail.includes(MOCK_REVIEW_ASK_FINDING)
  ) {
    const builderId = latestUserTail.match(/the review of task ([\w-]+)/)?.[1] ?? "missing";
    return {
      calls: [
        {
          name: "steer_crewmate",
          args: { task_id: builderId, message: MOCK_REVIEW_AUTOFIX_FINDING },
        },
        {
          name: "emit_card",
          args: {
            task_id: builderId,
            review_task_id: latestUserTail.match(/on review task ([\w-]+)/)?.[1] ?? "missing",
            title: MOCK_REVIEW_ASK_CARD_TITLE,
            body:
              `<p>${MOCK_REVIEW_ASK_FINDING}</p>` +
              "<ul><li>The reviewer challenges a deliberate choice; your words did not settle it.</li></ul>",
            actions: [
              { id: "keep-copy", label: "Keep the copy", default: true },
              { id: "change-copy", label: "Change it" },
            ],
          },
        },
      ],
    };
  }
  // The pass: autonomy is off, so the builder emits its card.
  if (latestUserTail.includes("the hold is released")) {
    const builderId = latestUserTail.match(/the review of task ([\w-]+)/)?.[1] ?? "missing";
    return {
      calls: [
        {
          name: "steer_crewmate",
          args: { task_id: builderId, message: MOCK_REVIEW_PASSED_STEER },
        },
      ],
    };
  }
  return undefined;
}

function crewmateMove({
  body,
  latestUserTail,
  hasToolResults,
}: ScenarioRequest): ScenarioAnswer | undefined {
  // The reviewer (delivery rigor phase 2, capped in phase 3): findings
  // on its brief and on the first two re-review steers, a pass on the
  // third - the whole history rides the body, so the count is read off
  // it. Its final text is its report. Its brief also carries the
  // reviewed marker, so it is read before the builder.
  if (body.includes(REVIEW_BRIEF_MARKER)) {
    const rereviews = body.split(MOCK_REREVIEW_STEER).length - 1;
    if (!latestUserTail.includes(MOCK_REREVIEW_STEER)) return { text: MOCK_REVIEW_FINDINGS_REPORT };
    return rereviews >= 3 ? liveReviewAnswer(body) : { text: MOCK_REVIEW_REFINDINGS_REPORT };
  }
  // The reviewed builder: a green report and no card on its brief, the
  // fix on the auto-fix steer, the completion card once told the
  // review passed.
  if (!body.includes(REVIEWED_TIER_PROMPT_MARKER)) return undefined;
  if (latestUserTail.includes(MOCK_REVIEW_PASSED_STEER)) {
    if (hasToolResults) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: MOCK_REVIEWED_CARD_TITLE,
            body: MOCK_STANDARD_CARD_BODY,
            actions: MOCK_REVIEWED_CARD_ACTIONS,
          },
        },
        { name: "report", args: { text: MOCK_STANDARD_REPORT } },
      ],
    };
  }
  if (latestUserTail.includes(MOCK_REVIEW_AUTOFIX_FINDING))
    return { text: MOCK_REVIEWED_FIX_REPORT };
  if (latestUserTail.includes(MOCK_REVIEW_REFIX_STEER)) return { text: MOCK_REVIEWED_REFIX_REPORT };
  if (latestUserTail.includes(MOCK_CAP_RETRY_STEER)) return { text: MOCK_REVIEWED_RETRY_REPORT };
  // INF-125: this lifecycle fixture changes only commit history, not a running product.
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
  // Its own save point on its branch first - the head its change is
  // checked, reviewed and put in at - then the green report on it.
  if (!calledTool(body, "bash"))
    return {
      calls: [
        {
          name: "bash",
          args: { command: `git commit --allow-empty -m "${MOCK_REVIEWED_CHANGE.title}"` },
        },
      ],
    };
  // Then its own check reading, as a real builder takes one before
  // it reports: the app records it, and the Firstmate reads it.
  if (!calledTool(body, "check_change")) return { calls: [{ name: "check_change", args: {} }] };
  if (
    !providerMessages(body).some(
      (message) =>
        message.role === "tool" &&
        message.text.includes("Validation recorded at evidence revision"),
    )
  ) {
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
            text: MOCK_REVIEWED_BUILDER_REPORT,
            validation: { ...run, id: `fixture-${head}`, evidence: [] },
          },
        },
      ],
    };
  }
  return { text: MOCK_REVIEWED_BUILDER_REPORT };
}

/** INF-125: the scripted pass carries the assigned proof judgment, not prose alone. */
export function liveReviewAnswer(body: string): ScenarioAnswer {
  if (calledTool(body, "report")) return { text: MOCK_REVIEW_PASS_REPORT };
  const assignment = providerMessages(body)
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n")
    .matchAll(/Assigned live-validation record: (.+)/g);
  const snapshot = [...assignment].at(-1)?.[1];
  if (!snapshot) throw new Error("The scripted reviewer needs its assigned validation record.");
  const validation = liveValidationSchema.parse(JSON.parse(snapshot));
  const run = validation.runs.at(-1);
  if (!run) throw new Error("The scripted reviewer has no assigned proof.");
  const review = noSurfaceProof(run.head).reviews[0];
  if (!review) throw new Error("The lifecycle fixture has no review template.");
  const {
    reviewer: _reviewer,
    at: _at,
    scenarioRevision: _scenarioRevision,
    ...reviewInput
  } = review;
  return {
    calls: [
      {
        name: "report",
        args: {
          text: MOCK_REVIEW_PASS_REPORT,
          validation: { ...reviewInput, revision: run.revision },
        },
      },
    ],
  };
}
