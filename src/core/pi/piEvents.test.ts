import { PROGRESS_TOOL_NAMES, UNSTATED_TURN_ERROR } from "@shared/events";
import { describe, expect, it } from "vitest";
import {
  fmEventsFromPiEvent,
  piSessionEvents,
  seatEventsFromPiEvent,
  usageFromMessage,
} from "./piEvents";

describe("fmEventsFromPiEvent", () => {
  it("maps tool execution start and end", () => {
    expect(
      fmEventsFromPiEvent(
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} },
        "t1",
      ),
    ).toEqual([{ type: "tool_start", taskId: "t1", callId: "c1", toolName: "bash" }]);
    expect(
      fmEventsFromPiEvent(
        { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true },
        "t1",
      ),
    ).toEqual([{ type: "tool_end", taskId: "t1", callId: "c1", toolName: "bash", isError: true }]);
  });

  it("extracts usage on turn end for burn tracking", () => {
    const events = fmEventsFromPiEvent(
      {
        type: "turn_end",
        message: {
          usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.01 } },
        },
      },
      "t1",
    );
    expect(events).toEqual([
      {
        type: "turn_end",
        taskId: "t1",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
          cost: 0.01,
          costSource: "listed-prices",
        },
      },
    ]);
  });

  it("keeps the estimate by category where the model's listed prices split it", () => {
    const [event] = fmEventsFromPiEvent(
      {
        type: "turn_end",
        message: {
          usage: {
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0.003, output: 0.0015, cacheRead: 0, cacheWrite: 0, total: 0.0045 },
          },
        },
      },
      "t1",
    );
    expect(event).toMatchObject({
      usage: {
        cost: 0.0045,
        costSource: "listed-prices",
        costParts: { input: 0.003, output: 0.0015, cacheRead: 0, cacheWrite: 0 },
      },
    });
  });

  it("records no cost for a model with no listed prices, rather than calling its tokens free", () => {
    const [event] = fmEventsFromPiEvent(
      {
        type: "turn_end",
        message: {
          usage: {
            input: 400,
            output: 30,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
      "t1",
    );
    expect(event).toEqual({
      type: "turn_end",
      taskId: "t1",
      usage: { input: 400, output: 30, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("surfaces a provider-failed turn as turn_failed beside turn_end", () => {
    const events = fmEventsFromPiEvent(
      {
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Error Code null: Internal error during token generation",
        },
      },
      "t1",
    );
    expect(events).toEqual([
      {
        type: "turn_failed",
        taskId: "t1",
        error: "Error Code null: Internal error during token generation",
      },
      { type: "turn_end", taskId: "t1" },
    ]);
  });

  it("does not fabricate turn_failed for clean or aborted turns", () => {
    expect(
      fmEventsFromPiEvent({ type: "turn_end", message: { stopReason: "stop" } }, "t1"),
    ).toEqual([{ type: "turn_end", taskId: "t1" }]);
    expect(
      fmEventsFromPiEvent({ type: "turn_end", message: { stopReason: "aborted" } }, "t1"),
    ).toEqual([{ type: "turn_end", taskId: "t1" }]);
  });

  it("gives a message-less provider error a fallback text", () => {
    const events = fmEventsFromPiEvent(
      { type: "turn_end", message: { stopReason: "error" } },
      "t1",
    );
    expect(events[0]).toEqual({
      type: "turn_failed",
      taskId: "t1",
      error: "The provider returned an error.",
    });
  });

  it("surfaces compaction and retry as pseudo-tools", () => {
    expect(fmEventsFromPiEvent({ type: "compaction_start", reason: "auto" }, "t1")).toEqual([
      { type: "tool_start", taskId: "t1", callId: "t1:compaction", toolName: "compact_context" },
    ]);
    expect(
      fmEventsFromPiEvent({ type: "auto_retry_end", attempt: 2, success: false }, "t1"),
    ).toEqual([
      { type: "tool_end", taskId: "t1", callId: "t1:retry:2", toolName: "retry", isError: true },
    ]);
  });

  it("drops garbage and unknown events", () => {
    expect(fmEventsFromPiEvent(null, "t1")).toEqual([]);
    expect(fmEventsFromPiEvent("nope", "t1")).toEqual([]);
    expect(fmEventsFromPiEvent({ type: 42 }, "t1")).toEqual([]);
    expect(fmEventsFromPiEvent({ type: "agent_start" }, "t1")).toEqual([]);
  });
});

describe("usageFromMessage", () => {
  it("retains custom requests with unknown counts without manufacturing zeroes", () => {
    for (const stopReason of ["stop", "toolUse", "error", "aborted"]) {
      const message = {
        provider: "fm-custom-0123456789abcdef",
        stopReason,
        usage: { input: Number.NaN, output: Number.NaN, cost: { total: Number.NaN } },
      };
      expect(usageFromMessage(message)).toEqual({});
      expect(fmEventsFromPiEvent({ type: "turn_end", message }, "task")).toContainEqual({
        type: "turn_end",
        taskId: "task",
        usage: {},
      });
    }
    expect(
      usageFromMessage({
        provider: "fm-custom-0123456789abcdef",
        usage: { input: 0, output: 0, cost: { total: Number.NaN } },
      }),
    ).toEqual({});
    expect(usageFromMessage({ provider: "openai", usage: { input: Number.NaN } })).toBeUndefined();
  });
});

describe("seatEventsFromPiEvent (the Pi side of the seat seam)", () => {
  it("closes a failed turn_end as turn_failed, then turn_end, then turn_closed", () => {
    expect(
      seatEventsFromPiEvent(
        {
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "429 rate limited",
            content: [{ type: "text", text: "partial" }],
          },
        },
        "firstmate",
      ),
    ).toEqual([
      { type: "turn_failed", taskId: "firstmate", error: "429 rate limited" },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed", text: "partial" },
    ]);
  });

  it("words a failure the provider left unstated", () => {
    expect(
      seatEventsFromPiEvent(
        { type: "turn_end", message: { stopReason: "error", errorMessage: "", content: [] } },
        "firstmate",
      ),
    ).toEqual([
      { type: "turn_failed", taskId: "firstmate", error: UNSTATED_TURN_ERROR },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
  });

  it("carries the turn's usage and its closing text, joined and trimmed", () => {
    expect(
      seatEventsFromPiEvent(
        {
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 10, output: 2 },
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "Done." },
              { type: "text", text: "" },
              { type: "text", text: "Two tasks queued. " },
            ],
          },
        },
        "firstmate",
      ),
    ).toEqual([
      { type: "turn_end", taskId: "firstmate", usage: { input: 10, output: 2 } },
      { type: "turn_closed", text: "Done.\nTwo tasks queued." },
    ]);
  });

  it("says a model request started when the model's reply begins, or a compaction asks for its summary", () => {
    expect(
      seatEventsFromPiEvent({ type: "message_start", message: { role: "assistant" } }, "firstmate"),
    ).toEqual([{ type: "request_started" }]);
    expect(
      seatEventsFromPiEvent({ type: "compaction_start", reason: "threshold" }, "firstmate"),
    ).toEqual([
      { type: "request_started" },
      {
        type: "tool_start",
        taskId: "firstmate",
        callId: "firstmate:compaction",
        toolName: PROGRESS_TOOL_NAMES[0],
      },
    ]);
    // A user message (the prompt, or a steer taken in) is not a model request.
    expect(
      seatEventsFromPiEvent({ type: "message_start", message: { role: "user" } }, "firstmate"),
    ).toEqual([]);
  });

  it("closes a turn that said nothing with no text", () => {
    expect(
      seatEventsFromPiEvent({ type: "turn_end", message: { content: [] } }, "firstmate"),
    ).toEqual([{ type: "turn_end", taskId: "firstmate" }, { type: "turn_closed" }]);
  });

  it("adds nothing to events that close no turn", () => {
    expect(
      seatEventsFromPiEvent(
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
        "firstmate",
      ),
    ).toEqual([{ type: "assistant_delta", taskId: "firstmate", text: "hi" }]);
    expect(seatEventsFromPiEvent({ type: "agent_start" }, "firstmate")).toEqual([]);
    expect(seatEventsFromPiEvent(null, "firstmate")).toEqual([]);
  });
});

describe("completed context shortening usage", () => {
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 4,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
  };
  it.each(["manual", "threshold", "overflow"])(
    "preserves %s usage without closing a turn",
    (reason) => {
      const translate = piSessionEvents("task");
      translate({ type: "compaction_start", reason });
      const end = {
        type: "compaction_end",
        reason,
        result: { usage },
        aborted: false,
        willRetry: reason === "overflow",
      };
      expect(translate(end)).toEqual([
        {
          type: "tool_end",
          taskId: "task",
          callId: "task:compaction",
          toolName: PROGRESS_TOOL_NAMES[0],
          isError: false,
          usage: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 4,
            cost: 0.37,
            costSource: "listed-prices",
            costParts: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04 },
          },
        },
      ]);
      expect(translate({ ...end })).toEqual([]);
      translate({ type: "compaction_start", reason });
      expect(translate({ ...end })).toHaveLength(1);
    },
  );
  it.each([{ aborted: true }, { errorMessage: "failed" }, { result: undefined }, { result: {} }])(
    "does not invent usage for %j",
    (fields) => {
      const events = piSessionEvents("task")({
        type: "compaction_end",
        result: { usage },
        ...fields,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).not.toHaveProperty("usage");
    },
  );
});
