import { describe, expect, it } from "vitest";
import { LIVE_TEXT_MAX, LIVE_TOOLS_MAX, ObserveLiveBuffer } from "./liveBuffer";

describe("ObserveLiveBuffer", () => {
  it("accumulates a session's deltas and tool calls until its turn ends", () => {
    const live = new ObserveLiveBuffer();
    expect(live.read("firstmate")).toEqual({ id: "firstmate", text: "", tools: [] });
    live.apply({ type: "assistant_delta", taskId: "firstmate", text: "Hel" });
    live.apply({ type: "assistant_delta", taskId: "firstmate", text: "lo" });
    live.apply({ type: "tool_start", taskId: "firstmate", callId: "c1", toolName: "tasks" });
    // Another session's stream never bleeds in.
    live.apply({ type: "assistant_delta", taskId: "task-2", text: "other" });
    live.apply({
      type: "tool_end",
      taskId: "firstmate",
      callId: "c1",
      toolName: "tasks",
      isError: true,
    });
    expect(live.read("firstmate")).toEqual({
      id: "firstmate",
      text: "Hello",
      tools: [{ callId: "c1", toolName: "tasks", isError: true }],
    });
    expect(live.read("task-2").text).toBe("other");
    live.apply({ type: "turn_end", taskId: "firstmate" });
    expect(live.read("firstmate")).toEqual({ id: "firstmate", text: "", tools: [] });
    expect(live.read("task-2").text).toBe("other");
    live.apply({ type: "turn_failed", taskId: "task-2", error: "boom" });
    expect(live.read("task-2").text).toBe("");
  });

  it("keeps only the most recent text and tools", () => {
    const live = new ObserveLiveBuffer();
    live.apply({ type: "assistant_delta", taskId: "t", text: "a".repeat(LIVE_TEXT_MAX) });
    live.apply({ type: "assistant_delta", taskId: "t", text: "tail" });
    const text = live.read("t").text;
    expect(text).toHaveLength(LIVE_TEXT_MAX);
    expect(text.endsWith("tail")).toBe(true);
    for (let i = 0; i < LIVE_TOOLS_MAX + 5; i++) {
      live.apply({ type: "tool_start", taskId: "t", callId: `c${i}`, toolName: "bash" });
    }
    const tools = live.read("t").tools;
    expect(tools).toHaveLength(LIVE_TOOLS_MAX);
    expect(tools[0]?.callId).toBe("c5");
  });

  it("ignores a tool end for a session it never saw start", () => {
    const live = new ObserveLiveBuffer();
    live.apply({ type: "tool_end", taskId: "ghost", callId: "c", toolName: "x", isError: false });
    expect(live.read("ghost")).toEqual({ id: "ghost", text: "", tools: [] });
  });
});
