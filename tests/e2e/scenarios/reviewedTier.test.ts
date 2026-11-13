import { expect, test } from "vitest";
import { SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { laneTurnText, renderWake, type TypedWake } from "../../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../../src/core/pi/bashWords";
import type { InboxRow } from "../../../src/core/storage/inboxStore";
import { frameServedInput } from "../../../src/shared/servedFrame";
import { REVIEWED_TIER_PROMPT_MARKER, type ScenarioAnswer } from "../mockProvider";
import {
  MOCK_REVIEW_AUTOFIX_FINDING,
  MOCK_REVIEWED_BUILDER_REPORT,
  MOCK_REVIEWED_CHANGE,
  MOCK_REVIEWED_FIX_REPORT,
  MOCK_REVIEWED_READ_STEER,
  reviewedTier,
} from "./reviewedTier";

/**
 * INF-1149: on PR #309's loaded Mac lane, `rigor-reviewed.spec.ts` waited 30
 * seconds for the builder's first report line and saw none. The builder's
 * save point runs in a shell below the UI, so on a busy computer it can
 * outlast the shell's limit and answer with its job's receipt before the
 * commit is on the branch. A check reading taken then names the branch
 * before it, and the proof at that head is refused once the commit lands;
 * the builder repeated it and never ended its turn. Replay the slow commit
 * at the stand-in's own boundary, without starting Electron or waiting on a
 * clock; the journey still owns the rest of the review.
 */
test("the reviewed builder reads its checks once its slow save point has exited", () => {
  const answerer = reviewedTier();
  const messages: { role: string; content: unknown }[] = [
    { role: "user", content: `[work] title: meterlab ${REVIEWED_TIER_PROMPT_MARKER}` },
  ];
  let last: ScenarioAnswer | undefined;
  const next = () => {
    const body = JSON.stringify({ messages });
    last = answerer({
      body,
      isFirstmate: false,
      wantsStream: true,
      latestUserTail: body,
      hasToolResults: messages.length > 1,
      anthropicMessages: false,
      port: 0,
    });
    return last;
  };
  // Anthropic's tool-use/result shape, as the journey's Pi seat sends it:
  // one result for each call of the last answer.
  const results = (...texts: string[]) => {
    if (!last || !("calls" in last)) throw new Error("Expected tool calls");
    expect(last.calls).toHaveLength(texts.length);
    const ids = last.calls.map((_, index) => `tool-${messages.length}-${index}`);
    messages.push(
      {
        role: "assistant",
        content: last.calls.map((call, index) => ({
          type: "tool_use",
          id: ids[index],
          name: call.name,
          input: call.args,
        })),
      },
      {
        role: "user",
        content: texts.map((text, index) => ({
          type: "tool_result",
          tool_use_id: ids[index],
          content: text,
        })),
      },
    );
  };
  expect(next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "plan" } } }],
  });
  results(
    "Validation plan recorded at evidence revision 0. This records facts, not a finished-work report or permission. Continue the task; report when the first mate must act.",
  );
  const command = `git commit --allow-empty -m "${MOCK_REVIEWED_CHANGE.title}"`;
  expect(next()).toEqual({ calls: [{ name: "bash", args: { command } }] });
  results(backgroundJobReceipt("4d2e8a17"));
  // While the commit runs, the builder ends its turn without words: they
  // would be one more report on the task, ahead of its green one.
  expect(next()).toEqual({ text: "" });

  // The job's exit is the builder's next turn; its commit is on the branch now.
  messages.push({
    role: "user",
    content: frameServedInput([
      {
        kind: "wake",
        origin: "agent",
        body: renderWake({
          facts: {
            kind: "job-exit",
            to: "crewmate",
            jobId: "4d2e8a17",
            command,
            exitCode: 0,
            durationMs: SYNC_CAP_MS + 1000,
          },
        }),
      },
    ]).text,
  });
  expect(next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  const committed = "9b51c0e7a2d4f86b3e1c5a7d9f0b2e4c6a8d1f3b";
  results(
    // INF-1555 F12: the current tool carries typed facts, not a crew-ready or overall prose line.
    `pull request #55 https://github.com/o/meterlab/pull/55 head ${committed}\nfacts: ${JSON.stringify({ headSha: committed, complete: true, checks: [{ name: "ci", state: "success" }] })}\n- ci: completed / success`,
  );
  expect(next()).toMatchObject({
    calls: [
      {
        name: "report",
        args: { text: MOCK_REVIEWED_BUILDER_REPORT, validation: { kind: "run", head: committed } },
      },
    ],
  });
  results("Reported. Validation recorded at evidence revision 1.");
  expect(next()).toEqual({ text: MOCK_REVIEWED_BUILDER_REPORT });
});

/**
 * INF-3605, the reviewed tier's half of INF-3603: `rigor-reviewed.spec.ts`'s
 * `builderReads` waits for the builder's proof at the version it has just read
 * green. When the app's own check watch reads that pushed version before the
 * builder does, it steers its notice into the builder's running reading turn,
 * after the check_change result (docs/forge.md, "The check watch"); a builder
 * that answers the notice instead of the steer gives its default report and
 * saves no proof at that version. Replay that order at the stand-in's own
 * boundary, in the chat completions shape the journey's builder sends, without
 * starting Electron or racing the watch.
 */
test("the reviewed builder revalidates a green reading the check watch's notice reached", () => {
  const builder = fixedBuilder();
  builder.said(renderWake(READ_STEER));
  expect(builder.next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  builder.results(reading(FIXED_HEAD));
  // The watch's own reading came first, so its notice reaches the turn here.
  builder.said(renderWake(NOTICE));
  expect(builder.next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "run", head: FIXED_HEAD } } }],
  });
  builder.results("Reported. Validation recorded at evidence revision 2.");
  expect(builder.next()).toEqual({ text: "" });

  // Newer words than the notice are still the builder's next assignment: the
  // review's next handoff at that version is the scripted fix.
  builder.said(handoff(FIXED_HEAD));
  expect(builder.next()).toEqual({ text: MOCK_REVIEWED_FIX_REPORT });
});

/**
 * INF-3605: the same race when the watch's notice and the captain's reading
 * request are both due on the builder's lane as its turn starts. The lane
 * serves them as one message (`laneTurnText`), which still asks for the
 * reading, so the builder never reads past it.
 */
test("the reviewed builder takes its reading when the check watch's notice rides the same message", () => {
  const builder = fixedBuilder();
  builder.said(laneTurnText([row(1, NOTICE), row(2, READ_STEER)]));
  expect(builder.next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  builder.results(reading(FIXED_HEAD));
  expect(builder.next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "run", head: FIXED_HEAD } } }],
  });
  builder.results("Reported. Validation recorded at evidence revision 2.");
  expect(builder.next()).toEqual({ text: "" });
});

/**
 * `agents-reach.spec.ts` section 1, in a paused merge batch: the builder's
 * second reading saved no proof at the version it read green. The journey
 * pushes its fix as the builder ends its turn on the review's handoff, and
 * the check watch's quiet refresh reads that new version on its next tick
 * (docs/forge.md, "The check watch"), so its notice can be the builder's
 * next turn, alone, before the captain's reading request arrives. A builder
 * that answered it with its default report sent that version back to the
 * reviewer, whose next handoff then reached the reading turn ahead of its
 * proof. The notice names checks nothing asked the builder to act on, so it
 * says nothing, and the reading that follows still saves its proof.
 */
test("the reviewed builder says nothing to the check watch's notice on its own turn", () => {
  const builder = fixedBuilder();
  builder.said(renderWake(NOTICE));
  const quiet = builder.next();
  expect(quiet).toEqual({ text: "" });
  builder.answered(quiet);

  builder.said(renderWake(READ_STEER));
  expect(builder.next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  builder.results(reading(FIXED_HEAD));
  expect(builder.next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "run", head: FIXED_HEAD } } }],
  });
});

const CHANGE = "pull request #55 https://github.com/o/meterlab/pull/55";
const FIRST_HEAD = "50c9b6595e1e3d99e22ccd80ec7c96fd961f68b0";
const FIXED_HEAD = "5881dadfacd5e3e80919b33440a3218598dc6865";
/** The first mate's relay of the captain's reading request (`builderReads`). */
const READ_STEER: TypedWake = {
  facts: { kind: "response-request", requestId: "69e50aae", guidance: MOCK_REVIEWED_READ_STEER },
};
/** The check watch's quiet-refresh notice of the pushed fix's green checks. */
const NOTICE: TypedWake = {
  facts: {
    kind: "checks-settled",
    outcome: "observed",
    change: CHANGE,
    head: FIXED_HEAD,
    checks: [{ name: "linux-checks", state: "success" }],
  },
};

/**
 * The reviewed builder's conversation in the chat completions shape, through
 * its brief - the plan, the save point, the reading and the proof at the
 * first head, then the green report - and the review's first handoff, whose
 * fix the journey pushes as `FIXED_HEAD`.
 */
function fixedBuilder() {
  const answerer = reviewedTier();
  const messages: {
    role: string;
    content: unknown;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[] = [{ role: "user", content: `[work] title: meterlab ${REVIEWED_TIER_PROMPT_MARKER}` }];
  let last: ScenarioAnswer | undefined;
  const next = () => {
    const body = JSON.stringify({ messages });
    // What the stand-in reads of a request (`mockProvider.ts`): what follows
    // the newest user message, and whether that holds a tool result.
    const latestUserTail = body.slice(body.lastIndexOf('"role":"user"'));
    last = answerer({
      body,
      isFirstmate: false,
      wantsStream: true,
      latestUserTail,
      hasToolResults: latestUserTail.includes('"tool_call_id"'),
      anthropicMessages: false,
      port: 0,
    });
    return last;
  };
  // One tool message for each call of the last answer.
  const results = (...texts: string[]) => {
    if (!last || !("calls" in last)) throw new Error("Expected tool calls");
    expect(last.calls).toHaveLength(texts.length);
    const ids = last.calls.map((_, index) => `call-${messages.length}-${index}`);
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: last.calls.map((call, index) => ({
        id: ids[index],
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    });
    for (const [index, text] of texts.entries())
      messages.push({ role: "tool", content: text, tool_call_id: ids[index] });
  };
  const said = (text: string) => messages.push({ role: "user", content: text });
  // An answer in words ends the turn; it stays in the conversation.
  const answered = (answer: ScenarioAnswer | undefined) => {
    if (!answer || !("text" in answer)) throw new Error("Expected words");
    messages.push({ role: "assistant", content: answer.text });
  };

  expect(next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "plan" } } }],
  });
  results("Validation plan recorded at evidence revision 0.");
  expect(next()).toMatchObject({ calls: [{ name: "bash" }] });
  results("exit 0 [fm/task-07989a01 50c9b65] fix: make the meter read on time");
  expect(next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  results(reading(FIRST_HEAD));
  expect(next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "run", head: FIRST_HEAD } } }],
  });
  results("Reported. Validation recorded at evidence revision 1.");
  answered(next());
  said(handoff(FIRST_HEAD));
  const fixed = next();
  expect(fixed).toEqual({ text: MOCK_REVIEWED_FIX_REPORT });
  answered(fixed);
  return { next, results, said, answered };
}

/** A green check_change reading at `head`, in the words and facts the tool answers with. */
function reading(head: string): string {
  return `${CHANGE} head ${head}\nfacts: ${JSON.stringify({
    change: { id: "fb1d4f18", base: "main" },
    headSha: head,
    currentHead: head,
    moved: true,
    mergeable: true,
    readiness: "clean",
    mergeableState: "clean",
    complete: true,
    problem: null,
    repairChecksNotInReading: [],
    checks: [
      {
        name: "linux-checks",
        state: "success",
        status: "completed",
        conclusion: "success",
        run: null,
        workflow: null,
        event: null,
      },
    ],
    main: null,
  })}\n- linux-checks: completed / success`;
}

/** The review's handoff of its auto-fix finding at `head`, as the host words it. */
function handoff(head: string): string {
  return renderWake({
    facts: {
      kind: "review-handoff",
      from: "METE-2",
      head,
      stage: "fix",
      excerpt: "The flush is still awaited after the read.",
      findings: [MOCK_REVIEW_AUTOFIX_FINDING],
    },
  });
}

/** One row of the builder's lane as the inbox serves it. */
function row(id: number, wake: TypedWake): InboxRow {
  return {
    v: 1,
    id,
    recipient: "task-builder",
    origin: "agent",
    ref: null,
    ...wake,
    createdAt: id,
    deliveredAt: null,
    attempts: 0,
    lastAttemptAt: null,
    escalatedAt: null,
    failures: 0,
    failingSince: null,
    nextAttemptAt: null,
    cuts: 0,
    refusals: 0,
    stuckAt: null,
  };
}
