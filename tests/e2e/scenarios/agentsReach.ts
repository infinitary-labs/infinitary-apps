import { captainTurn, renderWake } from "../../../src/core/orchestrator/wakes";
import { checkSnapshotSummary } from "../../../src/shared/checkSnapshot";
import { fixedHoldWords, type OverridableHold } from "../../../src/shared/holds";
import { noSurfaceProof } from "../../helpers/liveValidation";
import { browserShellMessages } from "../browserScript";
import { MOCK_STANDARD_CARD_BODY } from "../crewCards";
import {
  MOCK_CLOSING_SENTENCES,
  REVIEWED_TIER_PROMPT_MARKER,
  type Scenario,
  type ScenarioAnswer,
  type ScenarioRequest,
} from "../mockProvider";
import {
  answering,
  checkFactsSnapshot,
  contextRepos,
  findCrewTaskId,
  holdsSegment,
  latestServedTurn,
  onlyCheckNotices,
  providerMessages,
  served,
  sinceLastAsked,
} from "../providerRequest";

/**
 * The agent's-reach story (INF-484 ring 4, INF-140), run end to end by
 * `agents-reach.spec.ts` beside `reviewedTier`: the moves only that journey
 * needs, in the order the story meets them.
 *
 * 1. The captain's words stop a review that still has findings: the
 *    reviewed builder, steered with them, emits its completion card at the
 *    reviewed version. Before that, after each fix the journey pushes, the
 *    builder reads its checks and revalidates the new version through the
 *    app's own tools.
 * 2. Words naming a fixed limit: the first mate passes the soft hold the
 *    words name (asking first), tries the merge, and relays GitHub's rule,
 *    which no one's word passes, in its reply.
 * 3. A second rerun: a crewmate diagnoses a failed job as a suspected
 *    flake, then reserves and reruns it twice with no host allowance to
 *    refuse the second, and reports with no card.
 * 4. The weekly audit rule's wake: the first mate starts the audit task in
 *    the project the rule names, and its crewmate answers on a card.
 */

/** The captain's words on the review that still has findings (ring 4's own quote). */
export const REACH_STOP_WORDS = "stop the review and merge it";
/**
 * The soft holds the first mate reads those words to pass, for this version:
 * the checks alone, since the review and its live proof are the crew's
 * judgment and no hold of the host's (INF-1876).
 */
export const REACH_STOP_HOLDS: OverridableHold[] = ["checks"];
export const REACH_STOP_STEER =
  "The captain said stop the review and merge it: his words pass the checks at this version, and end the review. Emit your completion card now; no re-review.";
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
/** The captain's reply under that card (INF-1216's journey, the plan's own words). */
export const REACH_RERUN_REPLY = "keep going until the checks pass";
export const REACH_RERUN_HOLDS: OverridableHold[] = ["checks"];
/** The crewmate's relay of his reply, naming the card it came under. */
const REACH_RERUN_RELAY = "Relayed from card";
const REACH_RERUN_ANSWER = "I passed your words to the first mate to record for this task.";
export const REACH_RERUN_STEER =
  "The captain's words pass the rerun limit at this version: reserve the rerun again and run it.";
const REACH_RERUN_DONE_REPORT =
  "Reran the failed linux-checks job once more, as the captain's words allow.";

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
  effect: { kind: "merge", after: "close" },
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

  // 3. The crewmate relays the captain's reply under its rerun card: the
  //    first mate records it as his override in this turn, citing the card,
  //    and steers the crewmate on.
  if (said("reported on task") && said(REACH_RERUN_RELAY)) {
    if (results.length > 0) return { text: "Recorded the captain's words; the rerun goes out." };
    const task = findCrewTaskId(body, REACH_RERUN_MARKER) ?? "missing";
    const card = turn.segments
      .map((segment) => new RegExp(`${REACH_RERUN_RELAY} (\\S+):`).exec(segment.body)?.[1])
      .find(Boolean);
    return {
      calls: [
        {
          name: "update_task",
          args: {
            task,
            override: { holds: REACH_RERUN_HOLDS, until: "version", from: card ?? "missing" },
          },
        },
        { name: "steer_crewmate", args: { task_id: task, message: REACH_RERUN_STEER } },
      ],
    };
  }
  // The crewmate's report of the refused second rerun: its own card asks.
  if (said("reported on task") && said(REACH_RERUN_REPORT))
    return { text: "Its crewmate asked the captain on its card." };

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
  //    The check watch's notice is never its next assignment: when the
  //    app's own reading of the pushed version comes first, the watch steers
  //    it into the builder's running turn, after its check_change result
  //    (docs/forge.md, "The check watch"), and it names checks that reading
  //    already holds. Read past it, or it hides the steer the builder is
  //    answering and no proof is saved at that version (INF-3603). Only a
  //    message made wholly of notices is read past: when the notice and the
  //    steer are both due as the turn starts, the lane serves them as one
  //    message, which still asks for the reading (INF-3627).
  const turn = sinceLastAsked(body, onlyCheckNotices);
  if (body.includes(REVIEWED_TIER_PROMPT_MARKER) && turn.user.includes(REACH_READ_STEER)) {
    const { results } = turn;
    const reading = results.findLast((result) => /^facts: /m.test(result));
    if (!reading) return { calls: [{ name: "check_change", args: {} }] };

    const recorded = results.some((result) =>
      result.includes("Validation recorded at evidence revision"),
    );
    const facts = checkFactsSnapshot(reading);
    if (recorded || !facts || checkSnapshotSummary(facts).overall !== "green") return { text: "" };
    const head = facts.headSha;
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
    if (turn.results.length > 0) return { text: "done" };
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
    if (results.length === 1) return { calls: [{ name: "check_change", args: {} }] };
    if (results.length === 2)
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
    // The captain's reply under its card: answer in the thread, and relay
    // his words, naming the card, so the first mate records them. Only the
    // reply's own turn names the card; the standing words he gave, served
    // on the crewmate's next turn, quote his reply too.
    const card = new RegExp(`Card "${REACH_RERUN_CARD_TITLE}" \\((\\S+)\\)`).exec(user)?.[1];
    if (card && user.includes(REACH_RERUN_REPLY)) {
      if (results.length > 0) return { text: "" };
      return {
        calls: [
          { name: "reply", args: { card_id: card, text: REACH_RERUN_ANSWER, ...answering(user) } },
          {
            name: "report",
            args: {
              text: `${REACH_RERUN_RELAY} ${card}: "${REACH_RERUN_REPLY}"`,
              needs_firstmate: `Record the captain's words under card ${card} as their override on the rerun limit: "${REACH_RERUN_REPLY}"`,
            },
          },
        ],
      };
    }
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
    if (results.length === 4) return { calls: [write] };
    if (results.length === 5) return { calls: [rerun] };
    if (results.length === 6) return { calls: [write] };
    if (results.length === 7)
      return { calls: [{ name: "report", args: { text: REACH_RERUN_DONE_REPORT } }] };
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
              "<p>Your words passed one hold each: the checks and asking first.</p>",
            actions: [
              { id: "keep", label: "Keep the holds as they are", default: true },
              { id: "review-holds", label: "Review the holds" },
            ],
          },
        },
        { name: "report", args: { text: "The weekly reach audit is on its card." } },
      ],
    };
  }
  return undefined;
}
