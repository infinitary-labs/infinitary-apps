import type { FmEvent, FmUsage } from "@shared/events";
import { describe, expect, it } from "vitest";
import { type ClaudeCallCost, ClaudeCallUsage } from "./claudeCallUsage";
import { createNormalizerState, fmEventsFromClaudeMessage } from "./claudeEvents";

// Approved local-cost direction: this is the sanitized priced request captured
// from the boxed real client (42 input, 7 output, $0.000077), not a tariff table.
const CALL = {
  requestId: "req_local_1",
  model: "claude-haiku-4-5",
  input: 42,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.000077,
} satisfies ClaudeCallCost;
function ending(...calls: ClaudeCallCost[]): FmEvent[] {
  const models = new Map<string, FmUsage>();
  for (const call of calls) {
    const part = models.get(call.model) ?? { costSource: "claude" };
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
      if (call[key] !== undefined) part[key] = (part[key] ?? 0) + call[key];
    models.set(call.model, part);
  }
  return [
    {
      type: "turn_end",
      taskId: "task",
      usage: { models: [...models].map(([model, part]) => ({ model, ...part })) },
    },
  ];
}
function setup() {
  const recorded: FmUsage[] = [];
  const calls = new ClaudeCallUsage((usage) => recorded.push(usage));
  return { calls, recorded };
}
function completed(
  calls: ClaudeCallUsage,
  { requestId, model }: ClaudeCallCost = CALL,
  fields = {},
) {
  calls.observe(
    { type: "stream_event", event: { type: "message_start", message: { id: requestId, model } } },
    model,
  );
  calls.observe(
    { type: "assistant", request_id: requestId, message: { id: requestId, model } },
    model,
  );
  calls.observe({ type: "stream_event", event: { type: "message_delta", usage: fields } }, model);
  calls.observe({ type: "stream_event", event: { type: "message_stop" } }, model);
}

// Intent: a local price waits for the next main
// model boundary; subagent and content events are not that boundary.
function nextBoundary(calls: ClaudeCallUsage) {
  calls.observe(
    {
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_next", model: CALL.model } },
    },
    CALL.model,
  );
}

describe("approved Claude local-cost reports and independent turn-end fallback", () => {
  it("charges a completed call before turn end, once, including replayed content and reports", () => {
    const { calls, recorded } = setup();
    completed(calls);
    completed(calls);
    calls.report(CALL);
    calls.report(CALL);
    expect(recorded).toHaveLength(0);
    nextBoundary(calls);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      cost: CALL.cost,
      input: CALL.input,
      output: CALL.output,
      models: [{ model: CALL.model, cost: CALL.cost }],
    });
    expect(calls.settle(ending(CALL))).toEqual([{ type: "turn_end", taskId: "task" }]);
  });
  it("joins a price that arrived before the SDK frame without guessing from amounts", () => {
    const { calls, recorded } = setup();
    calls.report(CALL);
    expect(recorded).toEqual([]);
    completed(calls);
    expect(recorded).toHaveLength(0);
    nextBoundary(calls);
    expect(recorded).toHaveLength(1);
  });
  it("keeps missing, late, wrong-model and unrelated reports on the terminal path", () => {
    const { calls, recorded } = setup();
    completed(calls);
    calls.report({ ...CALL, model: "another-model" });
    calls.report({ ...CALL, requestId: "an-internal-helper-request" });
    expect(calls.settle(ending(CALL))).toEqual(ending(CALL));
    calls.report(CALL);
    expect(recorded).toEqual([]);
    const next = { ...CALL, requestId: "req_local_2" };
    completed(calls, next);
    calls.report(next);
    nextBoundary(calls);
    expect(recorded).toHaveLength(1);
    expect(calls.settle(ending(next))).toEqual([{ type: "turn_end", taskId: "task" }]);
  });
  it("records a lost report and unstreamed model work only in the result, without charging the matched call again", () => {
    const { calls, recorded } = setup();
    const missing = { ...CALL, requestId: "req_local_2" };
    completed(calls);
    completed(calls, missing);
    calls.report(CALL);
    nextBoundary(calls);
    const ended = calls.settle(ending(CALL, missing));
    expect(ended).toEqual(
      ending(missing).map((e) =>
        e.type === "turn_end"
          ? {
              ...e,
              usage: {
                ...e.usage,
                input: missing.input,
                output: missing.output,
                cacheRead: 0,
                cacheWrite: 0,
                cost: missing.cost,
                costSource: "claude",
              },
            }
          : e,
      ),
    );
    expect(recorded).toHaveLength(1);
  });
  it("accounts for independent models and out-of-order exports without merging their counters", () => {
    const { calls, recorded } = setup();
    const other = { ...CALL, requestId: "req_local_2", model: "claude-sonnet-5-5" };
    completed(calls);
    completed(calls, other);
    calls.report(other);
    calls.report(CALL);
    nextBoundary(calls);
    expect(recorded.map((u) => u.models?.[0]?.model)).toEqual([other.model, CALL.model]);
    expect(calls.settle(ending(CALL, other))).toEqual([{ type: "turn_end", taskId: "task" }]);
  });
  it("does not treat incomplete, failed or advisor-bearing requests as independently priced calls", () => {
    const { calls, recorded } = setup();
    completed(calls, CALL, { iterations: [{ model: "claude-sonnet-5-5" }] });
    calls.report(CALL);
    expect(recorded).toEqual([]);
    expect(calls.settle(ending(CALL))).toEqual(ending(CALL));
    calls.observe(
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: CALL.requestId, model: CALL.model } },
      },
      CALL.model,
    );
    calls.observe(
      {
        type: "assistant",
        request_id: CALL.requestId,
        error: "rate_limit",
        message: { id: CALL.requestId, model: CALL.model },
      },
      CALL.model,
    );
    calls.report(CALL);
    expect(recorded).toEqual([]);
  });
  it("joins a subagent's streamed completion independently of the main request scope", () => {
    const { calls, recorded } = setup();
    const parent_tool_use_id = "toolu_count_rivets";
    for (const row of [
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: CALL.requestId, model: CALL.model } },
      },
      {
        type: "assistant",
        request_id: CALL.requestId,
        message: { id: CALL.requestId, model: CALL.model },
      },
      { type: "stream_event", event: { type: "message_stop" } },
    ])
      calls.observe({ ...row, parent_tool_use_id }, "claude-sonnet-5-5");
    calls.report(CALL);
    nextBoundary(calls);
    expect(recorded).toHaveLength(1);
    expect(calls.settle(ending(CALL))).toEqual([{ type: "turn_end", taskId: "task" }]);
  });

  it("does not emit a turn boundary when a price arrives during text or a subagent request", () => {
    const { calls, recorded } = setup();
    completed(calls);
    calls.report(CALL);
    calls.observe(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Still working" },
        },
      },
      CALL.model,
    );
    calls.observe(
      {
        type: "stream_event",
        parent_tool_use_id: "toolu_background",
        event: { type: "message_start", message: { id: "msg_child", model: CALL.model } },
      },
      CALL.model,
    );
    expect(recorded).toEqual([]);
    nextBoundary(calls);
    expect(recorded).toHaveLength(1);
  });

  it("returns result-boundary charges without emitting them ahead of a failed result", () => {
    const { calls, recorded } = setup();
    completed(calls);
    calls.report(CALL);
    const settled = calls.settle(ending(CALL));
    expect(recorded).toEqual([]);
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({
      type: "turn_end",
      taskId: "task",
      usage: { cost: CALL.cost },
    });
    expect(settled[1]).toEqual({ type: "turn_end", taskId: "task" });
  });

  it("absorbs cumulative-counter cancellation without writing zero-token cost dust", () => {
    const { calls } = setup();
    const state = createNormalizerState();
    // A long-lived client's baseline, derived from the captured call rather
    // than from a second price table; only the next 2,000 turns are recorded.
    let count = 1_000_000;
    let cost = count * CALL.cost;
    const result = () => ({
      type: "result",
      modelUsage: {
        [CALL.model]: {
          costUSD: cost,
          inputTokens: count * (CALL.input as number),
          outputTokens: count * (CALL.output as number),
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    fmEventsFromClaudeMessage(result(), "task", state);
    let observedCancellation = false;
    for (let turn = 0; turn < 2_000; turn++) {
      // Results can follow one request or a tool/subagent batch. Each
      // cumulative addition rounds, not only the final subtraction.
      const requests = [1, 2, 8][turn % 3] as number;
      for (let request = 0; request < requests; request++) {
        const current = { ...CALL, requestId: `req_round_${turn}_${request}` };
        completed(calls, current);
        calls.report(current);
        nextBoundary(calls);
        count++;
        cost += CALL.cost;
      }
      const normalized = fmEventsFromClaudeMessage(result(), "task", state);
      const delta = normalized.events.find((e) => e.type === "turn_end");
      if (
        delta?.type === "turn_end" &&
        (delta.usage?.cost ?? 0) - requests * CALL.cost > Number.EPSILON
      )
        observedCancellation = true;
      expect(calls.settle(normalized.events, state.totals)).toEqual([
        { type: "turn_end", taskId: "task" },
      ]);
    }
    expect(observedCancellation).toBe(true);
  });

  it("retains a genuine cost-only remainder rather than discarding every zero-token part", () => {
    const { calls } = setup();
    completed(calls);
    calls.report(CALL);
    nextBoundary(calls);
    const terminal = ending(CALL);
    const end = terminal[0];
    if (end?.type !== "turn_end" || !end.usage?.models) throw new Error("missing terminal fixture");
    const model = end.usage.models[0];
    if (!model) throw new Error("missing model fixture");
    model.cost = CALL.cost * 2;
    expect(calls.settle(terminal)[0]).toMatchObject({
      type: "turn_end",
      usage: { cost: CALL.cost, models: [{ input: 0, output: 0, cost: CALL.cost }] },
    });
  });

  it("a fresh attachment starts from its own receipts, not an earlier session's cumulative report", () => {
    const first = setup();
    completed(first.calls);
    first.calls.report(CALL);
    nextBoundary(first.calls);
    first.calls.settle(ending(CALL));
    const resumed = setup();
    resumed.calls.report(CALL);
    expect(resumed.recorded).toEqual([]);
    const next = { ...CALL, requestId: "req_local_2" };
    completed(resumed.calls, next);
    resumed.calls.report(next);
    nextBoundary(resumed.calls);
    expect(resumed.recorded).toHaveLength(1);
    expect(resumed.calls.settle(ending(next))).toEqual([{ type: "turn_end", taskId: "task" }]);
  });
});
