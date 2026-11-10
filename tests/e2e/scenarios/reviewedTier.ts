import { REVIEW_BRIEF_OPENING } from "../../../src/core/orchestrator/intentBrief";
import { REVIEW_HANDOFF_NEXT } from "../../../src/core/orchestrator/reportWakes";
import { DECIDED_SO_FAR } from "../../../src/core/orchestrator/reviewHistory";
import { PERSONAL_WORKSPACE_NAME } from "../../../src/core/paths";
import { checkSnapshotSummary } from "../../../src/shared/checkSnapshot";
import type { KeptValidationInput } from "../../../src/shared/liveValidation";
import { type ReviewFinding, renderFinding } from "../../../src/shared/rigor";
import { CHECK_WORDS } from "../../../src/shared/vocabulary";
import { noSurfaceProof } from "../../helpers/liveValidation";
import type { ScriptedCardAction } from "../../helpers/scriptedCalls";
import { shellJobsRunning } from "../browserScript";
import { MOCK_STANDARD_CARD_BODY, MOCK_STANDARD_REPORT } from "../crewCards";
import {
  REVIEWED_TIER_PROMPT_MARKER,
  type Scenario,
  type ScenarioAnswer,
  type ScenarioRequest,
} from "../mockProvider";
import {
  calledTool,
  checkFactsSnapshot,
  contextRepos,
  providerMessages,
  sinceLastUser,
} from "../providerRequest";

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
/**
 * The reviewer's findings, typed (INF-1875): the verdict is the review
 * record on its report, never a line of the report text. The app renders
 * each finding as one line on the first mate's wake, which the mock first
 * mate reads them off.
 */
const AUTOFIX_FINDING: ReviewFinding = {
  id: "F1",
  severity: "error",
  file: "tests/meter.test.ts",
  line: 12,
  text: "the flush is awaited after the read, so the race stands",
  action: "auto-fix",
};
const ASK_FINDING: ReviewFinding = {
  id: "F2",
  severity: "warning",
  file: "src/meter.ts",
  line: 40,
  text: "the empty-state copy says Later, which the captain retired",
  action: "ask-user",
};
export const MOCK_REVIEW_AUTOFIX_FINDING = renderFinding(AUTOFIX_FINDING);
export const MOCK_REVIEW_ASK_FINDING = renderFinding(ASK_FINDING);
export const MOCK_REVIEW_FINDINGS_REPORT =
  "Two findings: the flush is awaited after the read, and the empty-state copy says Later.";
export const MOCK_REVIEW_FINDINGS_RISK = {
  level: "medium",
  why: "one production line moves.",
} as const;
/** The risk the passing review declares. */
export const MOCK_REVIEW_PASS_RISK = { level: "low", why: "one test file changed." } as const;
export const MOCK_REVIEW_PASS_REPORT = "No findings; the flush is awaited before the read now.";
export const MOCK_REVIEWED_FIX_REPORT =
  "Fixed F1: the flush is awaited before the read; pushed a new head and the checks passed again.";
export const MOCK_REVIEW_ASK_CARD_TITLE = "Keep the Later copy?";
/**
 * The captain's answer on the ask-user finding: keep the copy. The spec
 * scripts the first mate's turn on that click (`scriptFirstmateTurn`), which
 * relays it to the builder; the builder has nothing to change and says so.
 */
export const MOCK_REVIEW_KEEP_LABEL = "Keep the copy";
export const MOCK_REVIEW_KEEP_STEER = "The captain keeps the Later copy: F2 needs no change.";
export const MOCK_REVIEWED_KEEP_REPORT =
  "Noted the captain's answer on F2: the Later copy stays, so nothing changes.";
export const MOCK_REVIEWED_CARD_TITLE = "The meter test is steady, reviewed";
/**
 * The review cap (delivery rigor phase 3). The mock reviewer answers its
 * brief and its first two re-reviews with findings - the third findings is
 * one past the cap, so the host's wake asks for a decision - and the third
 * re-review with a pass. The mock Firstmate turns the cap wake into ONE
 * decision card on the builder's task, a later re-finding into a plain
 * steer, and the captain's answer on the cap card into the steer that
 * reopens the rounds; the builder reports the retry.
 */
const REFINDING: ReviewFinding = {
  id: "F1",
  severity: "error",
  file: "tests/meter.test.ts",
  line: 12,
  text: "the flush is still awaited after the read",
  action: "auto-fix",
};
export const MOCK_REVIEW_REFINDING = renderFinding(REFINDING);
export const MOCK_REVIEW_REFINDINGS_REPORT = "The flush is still awaited after the read.";
export const MOCK_REVIEWED_REFIX_REPORT =
  "Fixed F1 again: the await is before the read now; pushed a new head.";
export const MOCK_REVIEW_CAP_CARD_TITLE = "Three findings rounds on the meter fix";
export const MOCK_REVIEW_CAP_RETRY_LABEL = "Retry with the findings";
export const MOCK_CAP_RETRY_STEER =
  "The captain says retry: fix F1 for good and push, then the reviewer reads it again.";
export const MOCK_REVIEWED_RETRY_REPORT =
  "Retried after the cap: F1 is fixed for good; pushed a new head.";
/**
 * The builder's own reading after the journey pushes its fix (INF-1153, as
 * INF-1148 did for agents-reach): the captain asks, the first mate relays
 * it, and the builder takes check_change and, on green, reports its
 * revalidated proof, so the app records both. A spec that wrote them into
 * the running app's database collided with the app's own writes ("database
 * is locked").
 */
export const MOCK_REVIEWED_READ_WORDS = "read the meter fix's checks where it now stands";
export const MOCK_REVIEWED_READ_STEER =
  "Take check_change on the fix you pushed; when its checks pass, revalidate that version.";
const MOCK_REVIEWED_READ_REPORT =
  "Took check_change on the pushed fix; its checks passed, and I revalidated that version.";
const MOCK_REVIEWED_CARD_ACTIONS: ScriptedCardAction[] = [
  {
    id: "merge",
    label: "Merge the pull request",
    default: true,
    effect: { kind: "merge", after: "close" },
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
  // A reviewed builder's ready declaration: separate from the recorded check facts,
  // then spawn_crewmate with review_of.
  const reviewedReport =
    latestUserTail.includes("reported on task") &&
    latestUserTail.includes(REVIEWED_BUILDER_NEEDLE) &&
    !latestUserTail.includes("with verdict");
  // The wake carries the app's recorded checks (the builder's own
  // reading); the Firstmate acts on them without a tool call.
  if (
    reviewedReport &&
    latestUserTail.includes(`recorded checks: ${CHECK_WORDS.green}`) &&
    !latestUserTail.includes("Recorded task")
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
          name: "emit_card",
          args: {
            task_id: builderId,
            review_task_id: latestUserTail.match(/on review task ([\w-]+)/)?.[1] ?? "missing",
            title: MOCK_REVIEW_ASK_CARD_TITLE,
            body:
              `<p>${MOCK_REVIEW_ASK_FINDING}</p>` +
              "<ul><li>The reviewer challenges a deliberate choice; your words did not settle it.</li></ul>",
            actions: [
              { id: "keep-copy", label: MOCK_REVIEW_KEEP_LABEL, default: true },
              { id: "change-copy", label: "Change it" },
            ],
          },
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
  // on its brief and on the first two changed heads, a pass on the
  // third - the whole history rides the body, so the count is read off
  // it. Its final text is its report. Its brief also carries the
  // reviewed marker, so it is read before the builder.
  if (body.includes(REVIEW_BRIEF_MARKER)) {
    // The journey promises findings on the first two changed heads. A proof
    // revision at the same head is another assignment, not another code fix.
    const assignedHeads = new Set(
      providerMessages(body)
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          [
            ...message.text.matchAll(/with kind review, head ([a-f0-9]{40}) and revision (\d+)/g),
          ].map((assignment) => assignment[1]),
        ),
    );
    const rereviews = assignedHeads.size - 1;
    if (!latestUserTail.includes(REVIEW_HANDOFF_NEXT.reread))
      return reviewAnswer(body, hasToolResults, MOCK_REVIEW_FINDINGS_REPORT, {
        code: "findings",
        findings: [AUTOFIX_FINDING, ASK_FINDING],
        risk: MOCK_REVIEW_FINDINGS_RISK,
      });
    return rereviews >= 3
      ? liveReviewAnswer(body, hasToolResults)
      : reviewAnswer(body, hasToolResults, MOCK_REVIEW_REFINDINGS_REPORT, {
          code: "findings",
          findings: [REFINDING],
          risk: MOCK_REVIEW_FINDINGS_RISK,
        });
  }
  // The reviewed builder: a green report and no card on its brief, the
  // fix on the auto-fix steer, the completion card once told the
  // review passed.
  if (!body.includes(REVIEWED_TIER_PROMPT_MARKER)) return undefined;
  // Its reading after the journey pushes a fix: the checks at the new
  // head, then on green its proof at that version, as its first report
  // carried it. On red it has nothing more to say.
  const turn = sinceLastUser(body);
  if (turn.user.includes(MOCK_REVIEWED_READ_STEER)) {
    const reading = turn.results.findLast((result) => /^facts: /m.test(result));
    if (!reading) return { calls: [{ name: "check_change", args: {} }] };

    const recorded = turn.results.some((result) =>
      result.includes("Validation recorded at evidence revision"),
    );
    const facts = checkFactsSnapshot(reading);
    if (recorded || !facts || checkSnapshotSummary(facts).overall !== "green") return { text: "" };
    const head = facts.headSha;
    if (!head) throw new Error("The scripted builder needs its actual checked version.");
    return {
      calls: [
        { name: "report", args: { text: MOCK_REVIEWED_READ_REPORT, validation: proofAt(head) } },
      ],
    };
  }
  if (latestUserTail.includes(REVIEW_HANDOFF_NEXT.ship)) {
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
  // The direct handoff carries earlier findings as history too; only the
  // current round, before that history, determines this scripted repair.
  const currentFindings = latestUserTail.split(DECIDED_SO_FAR)[0] ?? "";
  if (currentFindings.includes(MOCK_REVIEW_AUTOFIX_FINDING))
    return { text: MOCK_REVIEWED_FIX_REPORT };
  if (currentFindings.includes(MOCK_REVIEW_REFINDING)) return { text: MOCK_REVIEWED_REFIX_REPORT };
  if (latestUserTail.includes(MOCK_CAP_RETRY_STEER)) return { text: MOCK_REVIEWED_RETRY_REPORT };
  if (latestUserTail.includes(MOCK_REVIEW_KEEP_STEER)) return { text: MOCK_REVIEWED_KEEP_REPORT };
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
  // INF-1149: the shell runs below the UI, so on a busy computer the save
  // point can outlast the shell's limit and come back as a background job's
  // receipt before the commit is on the branch. Its checks read then are the
  // branch before it, and a proof at that head is refused once the commit
  // lands. So the builder ends its turn quietly - its plan is not a report -
  // and reads its checks once the job has exited.
  if (shellJobsRunning(body)) return { text: "" };
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
    return {
      calls: [
        { name: "report", args: { text: MOCK_REVIEWED_BUILDER_REPORT, validation: proofAt(head) } },
      ],
    };
  }
  return { text: MOCK_REVIEWED_BUILDER_REPORT };
}

/** INF-125: the builder's proof that this history-only fixture has no running product, at `head`. */
function proofAt(head: string) {
  const proof = noSurfaceProof(head).runs[0];
  if (!proof) throw new Error("The fixture's proof has its run.");
  const { revision: _revision, deviceId: _deviceId, at: _at, ...run } = proof;
  return { ...run, id: `fixture-${head}`, evidence: [] };
}

/** INF-125: the scripted pass carries the assigned proof judgment, not prose alone. */
export function liveReviewAnswer(body: string, hasToolResults: boolean): ScenarioAnswer {
  return reviewAnswer(body, hasToolResults, MOCK_REVIEW_PASS_REPORT, {
    code: "clear",
    risk: MOCK_REVIEW_PASS_RISK,
  });
}

/**
 * One reviewer turn (INF-1875): the typed review record on the report tool,
 * at the head and evidence revision the latest assignment in its
 * conversation names, with the no-surface proof judgment this lifecycle
 * fixture's empty branch gets; then the report text ending the turn.
 */
function reviewAnswer(
  body: string,
  hasToolResults: boolean,
  text: string,
  input: Pick<Extract<KeptValidationInput, { kind: "review" }>, "code" | "findings" | "risk">,
): ScenarioAnswer {
  if (hasToolResults) return { text };
  const assigned = [
    ...providerMessages(body)
      .filter((message) => message.role === "user")
      .map((message) => message.text)
      .join("\n")
      .matchAll(/with kind review, head ([a-f0-9]{40}) and revision (\d+)/g),
  ].at(-1);
  const head = assigned?.[1];
  const revision = assigned?.[2];
  if (!head || revision === undefined)
    throw new Error("The scripted reviewer needs its assigned head and evidence revision.");
  const review = noSurfaceProof(head).reviews[0];
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
        args: { text, validation: { ...reviewInput, revision: Number(revision), ...input } },
      },
    ],
  };
}
