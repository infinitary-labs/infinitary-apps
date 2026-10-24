import { captainTurn, renderWake } from "../../../src/core/orchestrator/wakes";
import { fixedHoldWords, type OverridableHold } from "../../../src/shared/holds";
import { noSurfaceProof } from "../../helpers/liveValidation";
import {
  browserShellMessages,
  contextRepos,
  findCrewTaskId,
  MOCK_CLOSING_SENTENCES,
  MOCK_STANDARD_CARD_BODY,
  REVIEWED_TIER_PROMPT_MARKER,
  type Scenario,
  type ScenarioAnswer,
  type ScenarioRequest,
  sinceLastUser,
} from "../mockProvider";
import { holdsSegment, latestServedTurn, providerMessages, served } from "../providerRequest";

/**
 * The agent's-reach story (INF-484 ring 4, INF-140), run end to end by
 * `agents-reach.spec.ts` beside `reviewedTier`: the moves only that journey
 * needs, in the order the story meets them.
 *
 * 1. The captain's words stop a capped review: the reviewed builder, steered
 *    with them, emits its completion card at the reviewed version. Before
 *    that, after each fix the journey pushes, the builder reads its checks
 *    and revalidates the new version through the app's own tools.
 * 2. Words naming a fixed limit: the first mate passes the soft hold the
 *    words name (asking first), tries the merge, and relays GitHub's rule,
 *    which no one's word passes, in its reply.
 * 3. The rerun limit: a crewmate reruns a failed job once, is refused a
 *    second, and reports; the first mate asks the captain, and his choice
 *    relayed as a steer lets the crewmate rerun it once more.
 * 4. The weekly audit rule's wake: the first mate starts the audit task in
 *    the project the rule names, and its crewmate answers on a card.
 */

/** The captain's words on the capped review (ring 4's own quote). */
export const REACH_STOP_WORDS = "stop the review and merge it";
/** The soft holds the first mate reads those words to pass, for this version. */
export const REACH_STOP_HOLDS: OverridableHold[] = ["rounds", "review", "live-proof", "checks"];
export const REACH_STOP_STEER =
  "The captain said stop the review and merge it: his words pass the review, its live proof and the checks at this version. Emit your completion card now; no re-review.";
export const REACH_STOP_CARD_TITLE = "The meter fix merges at the reviewed version";
const REACH_STOP_REPORT =
  "Emitted the completion card at the reviewed version on the captain's words; no re-review asked.";

/**
 * The reviewed builder's own reading after the journey pushes its fix
 * (INF-1148): the captain asks, the first mate relays it, and the builder
 * takes check_change and, on green, reports its revalidated proof, so the
 * app records both. A spec that wrote them into the running app's database
 * collided with the app's own writes ("database is locked").
 */
export const REACH_READ_WORDS = "read the meter fix's checks at its new version";
export const REACH_READ_STEER =
  "Read the checks on the fix you pushed with check_change; when they pass, revalidate its new version.";
const REACH_READ_REPORT =
  "Read the checks on the pushed fix; they passed, and I revalidated its new version.";

/** The second task: a change GitHub's own rule holds. */
export const REACH_RULE_MARKER = "trim the meter help copy";
export const REACH_RULE_CHANGE = {
  number: 56,
  title: "fix: trim the meter help copy",
  body: "The meter help fits on one line.",
};
export const REACH_RULE_DONE_TITLE = "The meter help copy is one line";
/** The captain's words: merge it yourself (a soft hold) and skip GitHub's rule (a fixed limit). */
export const REACH_RULE_WORDS =
  "merge the meter help copy yourself and skip GitHub's required review";
export const REACH_RULE_HOLDS: OverridableHold[] = ["asks-first"];
/**
 * The first mate's words once GitHub's rule refused the merge, its reply
 * line (the turn's closing words): its builder's completion card is up, so it
 * adds no card of its own.
 */
export const REACH_RULE_REPLY = "GitHub's rule holds it; merge it there";

/** The third task: a failed check rerun once, then once more on the captain's word. */
export const REACH_RERUN_MARKER = "steady the meter retry";
export const REACH_RERUN_CHANGE = {
  number: 57,
  title: "fix: steady the meter retry",
  body: "The meter retries once on a slow read.",
};
export const REACH_RERUN_CHECK = "linux-checks";
/** The failed job's rerun, on the project's own route. */
export const REACH_RERUN_PATH = "/repos/o/meterlab/actions/jobs/31/rerun";
const REACH_RERUN_EVIDENCE =
  "The job timed out in its network step; the same step passed on main an hour earlier.";
const REACH_RERUN_REPORT =
  "The linux-checks job failed again after its one rerun, and a second rerun was refused:";
export const REACH_RERUN_CARD_TITLE = "The meter retry check failed again after its one rerun";
export const REACH_RERUN_AGAIN_LABEL = "Rerun it once more";
export const REACH_RERUN_HOLDS: OverridableHold[] = ["rerun"];
export const REACH_RERUN_STEER =
  "The captain chose to rerun the failed check once more: reserve the rerun again and run it.";
const REACH_RERUN_DONE_REPORT =
  "Reran the failed linux-checks job once more, as the captain chose.";

/**
 * The weekly audit rule as docs/agents-reach.md ("The weekly audit") gives
 * it: the captain's saved prompt, word for word.
 */
export const REACH_AUDIT_RULE = {
  name: "Weekly reach audit",
  prompt:
    'Start a task in Infinitary that runs the weekly reach audit in docs/agents-reach.md ("The weekly audit") for the week up to {{scheduled time}}.\nIt answers on a card and changes no code.',
};
export const REACH_AUDIT_PROJECT = "infinitary";
export const REACH_AUDIT_CARD_TITLE = "This week's reach audit found no new verdict in code";

/** A completion card's one merge, unlabeled: the host attaches its buttons and their words. */
const MERGE_ACTION = {
  id: "merge",
  default: true,
  effect: { kind: "settle", mode: "merge" },
} as const;

/** The captain's typed words, as the first mate is served them. */
export function captainWords(words: string) {
  return served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) });
}

export const agentsReach: Scenario = () => (request) => {
  if (!request.wantsStream) return undefined;
  return request.isFirstmate ? firstmateMove(request) : crewmateMove(request);
};

function firstmateMove({ body }: ScenarioRequest): ScenarioAnswer | undefined {
  const turn = latestServedTurn(body);
  if (!turn) return undefined;
  const results = turn.toolResults;
  const said = (needle: string) => turn.segments.some((segment) => segment.body.includes(needle));

  // 2. Merge it yourself, past GitHub's rule: the soft hold his words pass
  //    is declared, the merge is tried, and the refusal is relayed in words
  //    only when it names the fixed limit.
  if (holdsSegment(turn, captainWords(REACH_RULE_WORDS))) {
    const task = findCrewTaskId(body, REACH_RULE_MARKER) ?? "missing";
    if (results.length === 0)
      return {
        calls: [
          {
            name: "update_task",
            args: { task, override: { holds: REACH_RULE_HOLDS, until: "version" } },
          },
          {
            name: "settle_task",
            args: {
              task_id: task,
              mode: "merge-pr",
              closing_sentence: MOCK_CLOSING_SENTENCES["merge-pr"],
            },
          },
        ],
      };
    // The emote is motion only; the closing words are the reply line (INF-772).
    if (results[1]?.includes(fixedHoldWords("host-rules"))) {
      if (results.length === 2) return { calls: [{ name: "emote", args: { emote: "confused" } }] };
      if (results.length === 3) return { text: REACH_RULE_REPLY };
    }
    return { text: "The merge did not go through." };
  }

  // 3. The crewmate's report of the refused second rerun: one decision.
  if (said("reported on task") && said(REACH_RERUN_REPORT)) {
    if (results.length > 0 || body.includes(REACH_RERUN_CARD_TITLE))
      return { text: "Asked the captain." };
    const task = findCrewTaskId(body, REACH_RERUN_MARKER) ?? "missing";
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            task_id: task,
            title: REACH_RERUN_CARD_TITLE,
            body:
              "<p>The linux-checks job failed again after the one rerun its crewmate may run.</p>" +
              "<p>Another rerun needs your word; the evidence still points at a slow network step.</p>",
            actions: [
              { id: "rerun-again", label: REACH_RERUN_AGAIN_LABEL, default: true },
              { id: "leave-red", label: "Leave it red" },
            ],
          },
        },
      ],
    };
  }

  // 4. The weekly audit rule fired: start its task in the project it names.
  if (said("by automation") && said(JSON.stringify(REACH_AUDIT_RULE.name))) {
    if (results.length > 0) return { text: "Started the weekly reach audit." };
    const repo = contextRepos(body).find(([name]) => name === REACH_AUDIT_PROJECT);
    return {
      calls: [
        {
          name: "spawn_crewmate",
          args: {
            title: REACH_AUDIT_RULE.name,
            goal: "The weekly reach audit answers on a card, with its verdicts, holds and counts.",
            user_words: REACH_AUDIT_RULE.prompt,
            ...(repo ? { repo_id: repo[1] } : {}),
            constraints: [{ kind: "read-only" }],
          },
        },
      ],
    };
  }
  return undefined;
}

/**
 * A crewmate's latest assignment, the tool answers since, and whether a
 * command it ran is still running (INF-1127). A commit past a Pi shell's
 * limit answers with a job receipt, and its exit comes back later as a
 * wake quoting the command, which names the task. Read through the
 * browser's reader, the receipt is no answer and the exit is the commit's
 * answer, never a new assignment that starts the task over.
 */
function sinceLastAssignment(body: string) {
  const { readings, pending } = browserShellMessages(providerMessages(body));
  const at = readings.findLastIndex((message) => message.role === "user");
  return {
    user: readings[at]?.text ?? "",
    results: readings
      .slice(at + 1)
      .flatMap((message) => (message.role === "tool" ? [message.text] : [])),
    pending,
  };
}

function crewmateMove({ body, hasToolResults }: ScenarioRequest): ScenarioAnswer | undefined {
  // 1. The reviewed builder's reading: its checks at the pushed fix, then
  //    on green its proof at that version, as the first reading's report
  //    carried it (`reviewedTier`). On red it has nothing more to say.
  const turn = sinceLastUser(body);
  if (body.includes(REVIEWED_TIER_PROMPT_MARKER) && turn.user.includes(REACH_READ_STEER)) {
    const { results } = turn;
    const reading = results.find((result) => /^overall: /m.test(result));
    if (!reading) return { calls: [{ name: "check_change", args: {} }] };
    const recorded = results.some((result) =>
      result.includes("Validation recorded at evidence revision"),
    );
    if (recorded || !/^overall: green$/m.test(reading)) return { text: "" };
    const head = reading.match(/head ([a-f0-9]{40})/)?.[1];
    if (!head) throw new Error("The scripted builder needs its actual checked version.");
    const proof = noSurfaceProof(head).runs[0];
    if (!proof) throw new Error("The fixture's proof has its run.");
    const { revision: _revision, deviceId: _deviceId, at: _at, ...run } = proof;
    return {
      calls: [
        {
          name: "report",
          args: {
            text: REACH_READ_REPORT,
            validation: { ...run, id: `fixture-${head}`, evidence: [] },
          },
        },
      ],
    };
  }

  // 1. The reviewed builder, steered with the captain's words.
  if (body.includes(REVIEWED_TIER_PROMPT_MARKER) && turn.user.includes(REACH_STOP_STEER)) {
    if (hasToolResults) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: REACH_STOP_CARD_TITLE,
            body: MOCK_STANDARD_CARD_BODY,
            actions: [MERGE_ACTION],
          },
        },
        { name: "report", args: { text: REACH_STOP_REPORT } },
      ],
    };
  }

  // 2. The change GitHub's rule holds: a commit, then the completion card.
  if (body.includes(REACH_RULE_MARKER)) {
    const { user, results, pending } = sinceLastAssignment(body);
    // A commit still running ends the turn with no words: its exit wake is
    // the next turn, and words now would be one more report on the task.
    if (pending) return { text: "" };
    if (!user.includes(REACH_RULE_MARKER)) return { text: "Nothing new to do." };
    if (results.length === 0)
      return {
        calls: [
          {
            name: "bash",
            args: { command: `git commit --allow-empty -m "${REACH_RULE_CHANGE.title}"` },
          },
        ],
      };
    if (results.length === 1)
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: REACH_RULE_DONE_TITLE,
              body: MOCK_STANDARD_CARD_BODY,
              actions: [MERGE_ACTION],
            },
          },
          { name: "report", args: { text: "The meter help copy is one line; the checks passed." } },
        ],
      };
    return { text: "done" };
  }

  // 3. The failed check: read, diagnose, reserve, rerun once, be refused
  //    a second, report; then on the captain's relayed word, once more.
  if (body.includes(REACH_RERUN_MARKER)) {
    const { user, results, pending } = sinceLastAssignment(body);
    if (pending) return { text: "" };
    const head =
      providerMessages(body)
        .filter((message) => message.role === "tool")
        .map((message) => message.text)
        .join("\n")
        .match(/head ([a-f0-9]{40})/)?.[1] ?? "missing";
    const rerun = {
      name: "check_change",
      args: { rerun: { headSha: head, check: REACH_RERUN_CHECK, evidence: REACH_RERUN_EVIDENCE } },
    } as const;
    const write = {
      name: "github_write",
      args: { method: "POST", path: REACH_RERUN_PATH },
    } as const;
    if (user.includes(REACH_RERUN_STEER)) {
      if (results.length === 0) return { calls: [rerun] };
      if (results.length === 1 && results[0]?.startsWith("Rerun authorized once"))
        return { calls: [write] };
      if (results.length === 2)
        return { calls: [{ name: "report", args: { text: REACH_RERUN_DONE_REPORT } }] };
      return {
        text: results.length === 1 ? `The rerun was not authorized: ${results[0]}` : "done",
      };
    }
    if (!user.includes(REACH_RERUN_MARKER)) return { text: "Nothing new to do." };
    if (results.length === 0)
      return {
        calls: [
          {
            name: "bash",
            args: { command: `git commit --allow-empty -m "${REACH_RERUN_CHANGE.title}"` },
          },
        ],
      };
    if (results.length === 1) return { calls: [{ name: "check_change", args: {} }] };
    if (results.length === 2)
      return {
        calls: [
          {
            name: "check_change",
            args: {
              diagnosis: {
                headSha: head,
                check: REACH_RERUN_CHECK,
                classification: "suspected-flake",
                evidence: REACH_RERUN_EVIDENCE,
                changedTest: false,
              },
            },
          },
        ],
      };
    if (results.length === 3) return { calls: [rerun] };
    if (results.length === 4 && results[3]?.startsWith("Rerun authorized once"))
      return { calls: [write] };
    if (results.length === 5) return { calls: [rerun] };
    if (results.length === 6)
      return {
        calls: [{ name: "report", args: { text: `${REACH_RERUN_REPORT} ${results[5]}` } }],
      };
    return { text: "done" };
  }

  // 4. The weekly audit's crewmate: its card is the answer.
  if (body.includes("runs the weekly reach audit")) {
    if (hasToolResults) return { text: "done" };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: REACH_AUDIT_CARD_TITLE,
            body:
              "<p>The week added no limit, hold or served sentence that decides for the agent.</p>" +
              "<p>Your words passed one hold each: the review, its live proof, the checks, the re-review limit, asking first and the rerun limit.</p>",
            actions: [
              { id: "keep", label: "Keep the holds as they are", default: true },
              { id: "lower-rerun", label: "Lower the rerun limit" },
            ],
          },
        },
        { name: "report", args: { text: "The weekly reach audit is on its card." } },
      ],
    };
  }
  return undefined;
}
