import { expect, test } from "vitest";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { REVIEWED_TIER_PROMPT_MARKER, type ScenarioAnswer } from "../mockProvider";
import { agentsReach, REACH_READ_STEER } from "./agentsReach";
import { MOCK_REVIEWED_BUILDER_REPORT } from "./reviewedTier";

const CHANGE = "pull request #55 https://github.com/o/meterlab/pull/55";
const HEAD = "a63a769f877faa5787a91c3ddc4fa9af4e603463";

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

  said(
    renderWake({
      facts: { kind: "response-request", requestId: "d3d80450", guidance: REACH_READ_STEER },
    }),
  );
  expect(next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  results(
    `${CHANGE} head ${HEAD}\nfacts: ${JSON.stringify({
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
    })}\n- linux-checks: completed / success`,
  );
  // The watch's own reading came first, so its notice reaches the turn here.
  said(
    renderWake({
      facts: {
        kind: "checks-settled",
        outcome: "observed",
        change: CHANGE,
        head: HEAD,
        checks: [{ name: "linux-checks", state: "success" }],
      },
    }),
  );
  expect(next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "run", head: HEAD } } }],
  });
  results("Reported. Validation recorded at evidence revision 1.");
  expect(next()).toEqual({ text: "" });

  // Newer words than the notice are still the builder's next assignment: the
  // review's handoff at that version goes to the review's own moves.
  said(
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
  expect(next()).toBeUndefined();
});
