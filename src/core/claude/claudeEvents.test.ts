import { describe, expect, it } from "vitest";
import {
  type ClaudeNormalizeResult,
  createNormalizerState,
  fmEventsFromClaudeMessage,
  STOPPED_EARLY_TEXT,
} from "./claudeEvents";

/**
 * Each message shape the Claude client emits about a turn's outcome, as the
 * Agent SDK types it (`SDKAssistantMessage.error`, `SDKResultSuccess` with
 * `is_error` and `api_error_status`, `SDKResultError` with its `errors`,
 * `SDKRateLimitEvent`), mapped to what the host learns. The words a message
 * carries never decide its class: the typed fields do.
 */

/** Run one turn's messages through a fresh normalizer; return the result's outcome. */
function turn(...messages: unknown[]): ClaudeNormalizeResult {
  const state = createNormalizerState();
  let last: ClaudeNormalizeResult = { events: [] };
  for (const message of messages) last = fmEventsFromClaudeMessage(message, "task-1", state);
  return last;
}

function apiErrorMessage(error: string, text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    error,
  };
}

function successResult(fields: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0,
    modelUsage: {},
    ...fields,
  };
}

function errorResult(subtype: string, errors: string[]) {
  return {
    type: "result",
    subtype,
    is_error: true,
    errors,
    total_cost_usd: 0,
    modelUsage: {},
  };
}

describe("fmEventsFromClaudeMessage, a turn's outcome", () => {
  it("settles a turn that answered clean, with its text", () => {
    const outcome = turn(successResult());
    expect(outcome.events).toEqual([{ type: "turn_end", taskId: "task-1" }]);
    expect(outcome.finalText).toBe("done");
    expect(outcome.failure).toBeUndefined();
  });

  it("reads a sign-in the provider refused from the assistant's typed error", () => {
    const outcome = turn(
      apiErrorMessage("authentication_failed", "Failed to authenticate."),
      successResult({ is_error: true, result: "Failed to authenticate.", api_error_status: 401 }),
    );
    expect(outcome.failure).toEqual({
      error: "Failed to authenticate.",
      cutOff: { class: "signed_out" },
    });
  });

  it("reads an organisation refusal as refused, and a 403 without a typed error too", () => {
    expect(
      turn(
        apiErrorMessage("oauth_org_not_allowed", "Your organization does not allow this."),
        successResult({ is_error: true, result: "Your organization does not allow this." }),
      ).failure?.cutOff,
    ).toEqual({ class: "refused" });
    expect(
      turn(successResult({ is_error: true, result: "API Error: 403", api_error_status: 403 }))
        .failure?.cutOff,
    ).toEqual({ class: "refused" });
  });

  it("reads a spent allowance with the reset the rejected reading named, in ms", () => {
    const outcome = turn(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_800_000_000,
          rateLimitType: "five_hour",
        },
      },
      apiErrorMessage("rate_limit", "You've hit your limit."),
      successResult({ is_error: true, result: "You've hit your limit.", api_error_status: 429 }),
    );
    expect(outcome.failure).toEqual({
      error: "You've hit your limit.",
      cutOff: { class: "no_headroom", resetsAt: 1_800_000_000_000 },
    });
  });

  it("never settles an error result clean: it fails the turn in the session's own words", () => {
    const outcome = turn(errorResult("error_max_turns", ["Reached the maximum number of turns."]));
    expect(outcome.events).toEqual([{ type: "turn_end", taskId: "task-1" }]);
    expect(outcome.failure).toEqual({ error: "Reached the maximum number of turns." });
    // No words of its own: still a failure, never a clean turn.
    expect(turn(errorResult("error_during_execution", [])).failure).toEqual({
      error: "The turn stopped before it finished (error_during_execution).",
    });
    expect(turn(successResult({ is_error: true, result: "" })).failure).toEqual({
      error: STOPPED_EARLY_TEXT,
    });
  });

  it("reads an overloaded provider as an ordinary failed turn, whatever its words say", () => {
    const outcome = turn(
      apiErrorMessage("overloaded", "API Error: 401 Unauthorized"),
      successResult({ is_error: true, result: "API Error: 401 Unauthorized" }),
    );
    // Words that look like a sign-in, typed as an overload: no cut-off.
    expect(outcome.failure).toEqual({ error: "API Error: 401 Unauthorized" });
  });

  it("INF-447: marks exhausted length recovery only from the typed terminal reason", () => {
    expect(
      turn(
        successResult({
          is_error: true,
          result: "Prompt is too long",
          terminal_reason: "prompt_too_long",
        }),
      ).failure,
    ).toEqual({ error: "Prompt is too long", contextOverflow: true });
    expect(turn(successResult({ is_error: true, result: "Prompt is too long" })).failure).toEqual({
      error: "Prompt is too long",
    });
    expect(
      turn(successResult({ result: "Prompt is too long", terminal_reason: "prompt_too_long" }))
        .failure,
    ).toBeUndefined();
  });

  it("marks an answer that kept running past the output cap, from its typed error alone", () => {
    // The shape the client ends with once its three carry-ons also hit the
    // cap (measured on 2.1.234 and 2.1.283): a synthetic assistant message
    // typed `max_output_tokens`, then an error result in its own words.
    const words =
      "API Error: Claude's response exceeded the 8192 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
    const outcome = turn(
      apiErrorMessage("max_output_tokens", words),
      successResult({ is_error: true, result: words }),
    );
    expect(outcome.failure).toEqual({ error: words, outputCapped: true });
    // The same words with no typed error mark nothing.
    expect(turn(successResult({ is_error: true, result: words })).failure).toEqual({
      error: words,
    });
  });

  it("reads a failed result with no typed field as an ordinary failed turn", () => {
    const outcome = turn(
      successResult({
        is_error: true,
        result: "Claude usage limit reached. Your limit resets at 3pm.",
      }),
    );
    expect(outcome.failure).toEqual({
      error: "Claude usage limit reached. Your limit resets at 3pm.",
    });
  });

  it("never fails a turn that answered over a subagent's error", () => {
    const outcome = turn(
      { ...apiErrorMessage("overloaded", "API Error: 529"), parent_tool_use_id: "toolu_task_1" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
        parent_tool_use_id: null,
      },
      successResult({ result: "The helper failed, so I did it myself. All done." }),
    );
    expect(outcome.failure).toBeUndefined();
    expect(outcome.finalText).toBe("The helper failed, so I did it myself. All done.");
    // Nor does a subagent's error name the class of a main turn that failed.
    const failed = turn(
      {
        ...apiErrorMessage("authentication_failed", "Failed to authenticate."),
        parent_tool_use_id: "toolu_task_1",
      },
      successResult({ is_error: true, result: "API Error: 500" }),
    );
    expect(failed.failure).toEqual({ error: "API Error: 500" });
  });

  it("classifies each turn with its own signals only", () => {
    const state = createNormalizerState();
    fmEventsFromClaudeMessage(
      apiErrorMessage("authentication_failed", "Failed to authenticate."),
      "task-1",
      state,
    );
    fmEventsFromClaudeMessage(
      successResult({ is_error: true, result: "Failed to authenticate." }),
      "task-1",
      state,
    );
    // The next turn answers clean: the earlier error does not follow it.
    const next = fmEventsFromClaudeMessage(successResult(), "task-1", state);
    expect(next.failure).toBeUndefined();
    const after = fmEventsFromClaudeMessage(
      errorResult("error_max_turns", ["Stopped."]),
      "task-1",
      state,
    );
    expect(after.failure).toEqual({ error: "Stopped." });
  });

  it("hands the quota surface the pushed reading, with its status and a reset in ms", () => {
    const outcome = fmEventsFromClaudeMessage(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          utilization: 0.9,
          resetsAt: 1_800_000_000,
          rateLimitType: "seven_day",
        },
      },
      "task-1",
      createNormalizerState(),
    );
    expect(outcome).toEqual({
      events: [],
      rateLimit: {
        status: "allowed_warning",
        utilization: 0.9,
        resetsAt: 1_800_000_000_000,
        windowId: "seven_day",
      },
    });
  });
});

describe("client background membership", () => {
  it("replaces rather than accumulates the complete list, including empty, and ignores malformed signals", () => {
    const state = createNormalizerState();
    const signal = (tasks: unknown) =>
      fmEventsFromClaudeMessage(
        { type: "system", subtype: "background_tasks_changed", tasks },
        "t",
        state,
      );
    expect(signal([{ task_id: "one", task_type: "local_bash" }]).backgroundJobs).toBe(1);
    expect(
      signal([
        { task_id: "two", task_type: "agent" },
        { task_id: "three", task_type: "local_bash" },
      ]).backgroundJobs,
    ).toBe(2);
    expect(signal([]).backgroundJobs).toBe(0);
    expect(signal([{}]).backgroundJobs).toBeUndefined();
    expect(signal(undefined).backgroundJobs).toBeUndefined();
  });

  // INF-379: a computer that runs work keeps the tasks that end with the
  // client, so its next start can tell a crewmate which its stop cut off.
  it("names the tasks that run inside the client by the id its model was given, and leaves out a remote one", () => {
    const listed = fmEventsFromClaudeMessage(
      {
        type: "system",
        subtype: "background_tasks_changed",
        // As 2.1.234 lists a background shell, beside a cloud agent and a
        // task its model gave no description.
        tasks: [
          { task_id: "bybac1mss", task_type: "local_bash", description: "Run the long suite" },
          { task_id: "r5k2", task_type: "remote_agent", description: "Review in the cloud" },
          { task_id: "a9x3", task_type: "local_agent", description: "" },
        ],
        uuid: "5d83894d-397d-4c6d-9d49-92b4c04b39a2",
        session_id: "a56ed764-fe4e-4e12-9398-da919edd5ed2",
      },
      "t",
      createNormalizerState(),
    );
    expect(listed.backgroundJobs).toBe(3);
    expect(listed.backgroundTasks).toEqual([
      { id: "bybac1mss", description: "Run the long suite" },
      { id: "a9x3", description: "local_agent" },
    ]);
  });
});

describe("Claude Code's refusal fallback", () => {
  const notice = (fields: Record<string, unknown>) =>
    fmEventsFromClaudeMessage(
      {
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-opus-5-5",
        fallback_model: "claude-opus-4-8",
        request_id: "req_1",
        content: "Opus 5.5's safeguards flagged this session.",
        uuid: "u1",
        session_id: "s1",
        ...fields,
      },
      "t",
      createNormalizerState(),
    );

  it("reads which model the client moved off and onto, how far, and the provider's category", () => {
    expect(notice({ scope: "session", api_refusal_category: "cyber" })).toEqual({
      events: [],
      fallback: {
        from: "claude-opus-5-5",
        to: "claude-opus-4-8",
        scope: "session",
        category: "cyber",
      },
    });
    // A subagent's own answer: the session's model is unchanged.
    expect(notice({ scope: "local", api_refusal_category: null }).fallback).toEqual({
      from: "claude-opus-5-5",
      to: "claude-opus-4-8",
      scope: "local",
    });
    // An older client names no scope, and means the session's.
    expect(notice({}).fallback?.scope).toBe("session");
  });

  it("ignores a notice that does not name both models", () => {
    expect(notice({ fallback_model: undefined })).toEqual({ events: [] });
    expect(notice({ original_model: 5 })).toEqual({ events: [] });
  });
});

describe("a turn's usage, model by model", () => {
  /** A result carrying the session's running totals for each model. */
  function totals(models: Record<string, [input: number, output: number, cost: number]>) {
    return successResult({
      modelUsage: Object.fromEntries(
        Object.entries(models).map(([model, [input, output, cost]]) => [
          model,
          {
            inputTokens: input,
            outputTokens: output,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: cost,
          },
        ]),
      ),
    });
  }
  const usageOf = (result: ClaudeNormalizeResult) =>
    result.events.find((event) => event.type === "turn_end")?.usage;

  it("records each model's own share of a turn, under the model that served it", () => {
    const state = createNormalizerState();
    const usage = usageOf(
      fmEventsFromClaudeMessage(
        totals({ "claude-opus-4-1": [100, 20, 0.5], "claude-haiku-4-5": [40, 4, 0.01] }),
        "t",
        state,
      ),
    );
    expect(usage?.models).toEqual([
      {
        model: "claude-opus-4-1",
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.5,
        costSource: "claude",
      },
      {
        model: "claude-haiku-4-5",
        input: 40,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        costSource: "claude",
      },
    ]);
    // The turn's own figures are their sum.
    expect(usage).toMatchObject({ input: 140, output: 24, costSource: "claude" });
    expect(usage?.cost).toBeCloseTo(0.51, 6);
  });

  it("turns the running totals into each turn's spend, and leaves a model the turn did not use out", () => {
    const state = createNormalizerState();
    fmEventsFromClaudeMessage(
      totals({ "claude-opus-4-1": [100, 20, 0.5], "claude-haiku-4-5": [40, 4, 0.01] }),
      "t",
      state,
    );
    const usage = usageOf(
      fmEventsFromClaudeMessage(
        totals({ "claude-opus-4-1": [160, 30, 0.8], "claude-haiku-4-5": [40, 4, 0.01] }),
        "t",
        state,
      ),
    );
    expect(usage?.models?.map((part) => [part.model, part.input, part.output])).toEqual([
      ["claude-opus-4-1", 60, 10],
    ]);
    expect(usage?.models?.[0]?.cost).toBeCloseTo(0.3, 6);
  });

  it("spends nothing on a result reported twice", () => {
    const state = createNormalizerState();
    const result = totals({ "claude-opus-4-1": [100, 20, 0.5] });
    fmEventsFromClaudeMessage(result, "t", state);
    expect(fmEventsFromClaudeMessage(result, "t", state).events).toEqual([
      { type: "turn_end", taskId: "t" },
    ]);
  });

  it("counts a model's totals from zero again when the client starts over", () => {
    const state = createNormalizerState();
    fmEventsFromClaudeMessage(totals({ "claude-opus-4-1": [500, 50, 2] }), "t", state);
    const usage = usageOf(
      fmEventsFromClaudeMessage(totals({ "claude-opus-4-1": [30, 5, 0.1] }), "t", state),
    );
    expect(usage?.models).toEqual([
      expect.objectContaining({ model: "claude-opus-4-1", input: 30, output: 5, cost: 0.1 }),
    ]);
  });

  it.each([
    ["inputTokens", "input"],
    ["outputTokens", "output"],
    ["cacheReadInputTokens", "cacheRead"],
    ["cacheCreationInputTokens", "cacheWrite"],
    ["costUSD", "cost"],
  ] as const)(
    "retains %s across partial results without reporting an invented value",
    (wire, field) => {
      const state = createNormalizerState();
      const report = (row: Record<string, number>) =>
        usageOf(
          fmEventsFromClaudeMessage(successResult({ modelUsage: { opus: row } }), "t", state),
        );
      report({ [wire]: 100 });
      // A missing counter must not trigger a restart of the reported counter.
      const partial: Record<string, number> =
        wire === "outputTokens" ? { inputTokens: 5 } : { outputTokens: 5 };
      const next = report(partial);
      expect(next?.[field]).toBeUndefined();
      expect(next?.models?.[0]?.[field]).toBeUndefined();
      expect(report(partial)).toBeUndefined();
      expect(report({ ...partial, [wire]: 110 })?.models?.[0]?.[field]).toBe(10);
    },
  );

  it("clears omitted baselines on a proven model restart, without restarting other models", () => {
    const state = createNormalizerState();
    fmEventsFromClaudeMessage(totals({ opus: [100, 10, 1], haiku: [50, 5, 0.5] }), "t", state);
    const restarted = successResult({
      modelUsage: {
        opus: { outputTokens: 0, costUSD: 0.1 },
        haiku: { outputTokens: 10, costUSD: 1 },
      },
    });
    expect(usageOf(fmEventsFromClaudeMessage(restarted, "t", state))?.models).toEqual([
      { model: "opus", output: 0, cost: 0.1, costSource: "claude" },
      { model: "haiku", output: 5, cost: 0.5, costSource: "claude" },
    ]);
    expect(usageOf(fmEventsFromClaudeMessage(restarted, "t", state))).toBeUndefined();
    const resumed = usageOf(
      fmEventsFromClaudeMessage(
        successResult({
          modelUsage: {
            opus: { inputTokens: 150, outputTokens: 5, costUSD: 0.2 },
            haiku: { inputTokens: 60, outputTokens: 10, costUSD: 1 },
          },
        }),
        "t",
        state,
      ),
    );
    expect(resumed?.models).toEqual([
      { model: "opus", input: 150, output: 5, cost: 0.1, costSource: "claude" },
      { model: "haiku", input: 10, output: 0 },
    ]);
  });

  it("retains unnamed cumulative baselines when an entire report or a field is missing", () => {
    const state = createNormalizerState();
    const report = (fields: Record<string, unknown>) =>
      usageOf(
        fmEventsFromClaudeMessage(
          successResult({ total_cost_usd: undefined, ...fields }),
          "t",
          state,
        ),
      );
    report({ usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 1 });
    expect(report({})).toBeUndefined();
    expect(report({ usage: { output_tokens: 15 }, total_cost_usd: 1.5 })).toEqual({
      output: 5,
      cost: 0.5,
      costSource: "claude",
    });
    expect(report({ usage: { input_tokens: 120, output_tokens: 15 } })).toEqual({
      input: 20,
      output: 0,
    });
    expect(report({ usage: { output_tokens: 20 }, total_cost_usd: 2 })).toEqual({
      output: 5,
      cost: 0.5,
      costSource: "claude",
    });
  });

  it("keeps a turn that names no model whole and unattributed, with no field it did not report", () => {
    const usage = usageOf(
      turn(
        successResult({
          modelUsage: {},
          usage: { input_tokens: 12, output_tokens: 3 },
          total_cost_usd: 0.02,
        }),
      ),
    );
    expect(usage).toEqual({ input: 12, output: 3, cost: 0.02, costSource: "claude" });
  });
});
