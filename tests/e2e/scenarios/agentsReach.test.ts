import { expect, test } from "vitest";
import { laneTurnText, renderWake, type TypedWake } from "../../../src/core/orchestrator/wakes";
import type { InboxRow } from "../../../src/core/storage/inboxStore";
import { REVIEWED_TIER_PROMPT_MARKER, type ScenarioAnswer } from "../mockProvider";
import { agentsReach, REACH_READ_STEER } from "./agentsReach";
import { MOCK_REVIEWED_BUILDER_REPORT } from "./reviewedTier";

const CHANGE = "pull request #55 https://github.com/o/meterlab/pull/55";
const HEAD = "a63a769f877faa5787a91c3ddc4fa9af4e603463";

/** The first mate's relay of the captain's reading request (`REACH_READ_WORDS`). */
const READ_STEER: TypedWake = {
  facts: { kind: "response-request", requestId: "d3d80450", guidance: REACH_READ_STEER },
};
/** The check watch's quiet-refresh notice of the pushed fix's green checks. */
const NOTICE: TypedWake = {
  facts: {
    kind: "checks-settled",
    outcome: "observed",
    change: CHANGE,
    head: HEAD,
    checks: [{ name: "linux-checks", state: "success" }],
  },
};

/**
 * INF-3603: `agents-reach.spec.ts` section 1 waited 30 seconds for the
 * builder's proof at the version it had just read green, and none came. When
 * the app's own check watch read the pushed version before the builder did,
 * it steered its notice into the builder's running reading turn, after the
 * check_change result; the scripted builder answered that notice instead of
 * the steer and never reported its proof. Replay that order at the stand-in's
 * own boundary, in the chat completions shape the journey's builder sends,
 * without starting Electron or racing the watch.
 */
test("the reviewed builder revalidates a green reading the check watch's notice reached", () => {
  const builder = readingBuilder();
  builder.said(renderWake(READ_STEER));
  expect(builder.next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  builder.results(reading());
  // The watch's own reading came first, so its notice reaches the turn here.
  builder.said(renderWake(NOTICE));
  expect(builder.next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "run", head: HEAD } } }],
  });
  builder.results("Reported. Validation recorded at evidence revision 1.");
  expect(builder.next()).toEqual({ text: "" });

  // Newer words than the notice are still the builder's next assignment: the
  // review's handoff at that version goes to the review's own moves.
  builder.said(
    renderWake({
      facts: {
        kind: "review-handoff",
        from: "METE-2",
        head: HEAD,
        stage: "fix",
        excerpt: "The flush is still awaited after the read.",
        findings: ["F1 error tests/meter.test.ts:12 The flush is awaited after the read."],
      },
    }),
  );
  expect(builder.next()).toBeUndefined();
});

/**
 * INF-3627, found by INF-3605: the same race when the watch's notice and the
 * captain's reading request are both due on the builder's lane as its turn
 * starts. The lane serves them as one message, a paragraph each
 * (`laneTurnText`), in the order they were queued. That message still asks
 * for the reading, so the builder never reads past it; a reader that passed
 * any message naming a notice left the builder answering nothing.
 */
test.each([
  ["before", [NOTICE, READ_STEER]],
  ["after", [READ_STEER, NOTICE]],
])(
  "the reviewed builder takes its reading when the check watch's notice rides the same message %s the request",
  (_order, wakes) => {
    const builder = readingBuilder();
    builder.said(laneTurnText(wakes.map((wake, index) => row(index + 1, wake))));
    expect(builder.next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
    builder.results(reading());
    expect(builder.next()).toMatchObject({
      calls: [{ name: "report", args: { validation: { kind: "run", head: HEAD } } }],
    });
    builder.results("Reported. Validation recorded at evidence revision 1.");
    expect(builder.next()).toEqual({ text: "" });
  },
);

/**
 * The reviewed builder's conversation in the chat completions shape, after
 * its brief and its green report, as the journey's builder sends it.
 */
function readingBuilder() {
  const answerer = agentsReach();
  const messages: {
    role: string;
    content: unknown;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[] = [
    { role: "user", content: `[work] title: meterlab ${REVIEWED_TIER_PROMPT_MARKER}` },
    { role: "assistant", content: MOCK_REVIEWED_BUILDER_REPORT },
  ];
  let last: ScenarioAnswer | undefined;
  const next = () => {
    const body = JSON.stringify({ messages });
    last = answerer({
      body,
      isFirstmate: false,
      wantsStream: true,
      latestUserTail: body,
      hasToolResults: messages.at(-1)?.role === "tool",
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
  return { next, results, said };
}

/** A green check_change reading at `HEAD`, in the words and facts the tool answers with. */
function reading(): string {
  return `${CHANGE} head ${HEAD}\nfacts: ${JSON.stringify({
    change: { id: "255aeb0b", base: "main" },
    headSha: HEAD,
    currentHead: HEAD,
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
  };
}
