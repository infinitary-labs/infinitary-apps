import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  type RunningCall,
  SAFE_STOP_BLOCKED_TEXT,
  type SafeStopOptions,
  type SafeStopOutcome,
} from "../session/session";
import { bareToolName } from "../storage/sessionReader";

/**
 * A rolling Claude session's safe stop (`ModelSession.stopSafely`): the gate
 * refuses every call the client asks about from now on, the calls it already
 * began finish and the client records their results, and then the turn is
 * cut. With the client's hooks off (a staged skill turns them off), a call is
 * still waited for once the client begins it. A second ask joins the first.
 */
export class ClaudeSafeStop {
  /** Tool calls the client began (streamed or recorded) with no result yet; a subagent's are its call's. */
  private readonly executing = new Map<string, RunningCall>();
  /** The safe stop under way: the gate refuses every call while it stands. */
  private stop:
    | { promise: Promise<SafeStopOutcome>; cut: boolean; options: SafeStopOptions; end: () => void }
    | undefined;

  /** `interrupt` cuts the session's running turn. */
  constructor(private readonly interrupt: () => void) {}

  /** The safe stop's gate, asked by the client before each call it would run. */
  readonly toolGate: HookCallback = async () =>
    this.stop
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: SAFE_STOP_BLOCKED_TEXT,
          },
        }
      : {};

  /** A safe stop stands: the turn takes nothing more. */
  get stopping(): boolean {
    return this.stop !== undefined;
  }

  /** The stop has cut the turn: a prompt the client has not taken yet ends as it starts. */
  get cut(): boolean {
    return this.stop?.cut === true;
  }

  /** Stop the turn that is open (`turnOpen`) safely; a second ask joins the first. */
  ask(options: SafeStopOptions, turnOpen: boolean): Promise<SafeStopOutcome> {
    if (this.stop) return this.stop.promise;
    if (!turnOpen) return Promise.resolve("stopped");
    const { signal } = options;
    if (signal?.aborted) return Promise.resolve("withdrawn");
    let settle!: (outcome: SafeStopOutcome) => void;
    const promise = new Promise<SafeStopOutcome>((resolve) => {
      settle = resolve;
    });
    const finish = (outcome: SafeStopOutcome) => {
      if (this.stop === stop) this.stop = undefined;
      signal?.removeEventListener("abort", withdraw);
      settle(outcome);
    };
    const withdraw = () => {
      if (!stop.cut) finish("withdrawn");
    };
    const stop = { promise, cut: false, options, end: () => finish("stopped") };
    this.stop = stop;
    signal?.addEventListener("abort", withdraw, { once: true });
    this.check();
    return promise;
  }

  track(message: unknown): void {
    const record = message as {
      type?: unknown;
      parent_tool_use_id?: unknown;
      message?: { content?: unknown };
      event?: { type?: unknown; content_block?: { type?: unknown; id?: unknown; name?: unknown } };
    };
    // A subagent's own calls run inside its call, which the stop waits for.
    if (record.parent_tool_use_id) return;
    const begin = (id: unknown, name: unknown) => {
      if (typeof id === "string" && !this.executing.has(id))
        this.executing.set(id, { callId: id, toolName: bareToolName(String(name ?? "")) });
    };
    if (record.type === "stream_event" && record.event?.type === "content_block_start") {
      const block = record.event.content_block;
      if (block?.type === "tool_use") begin(block.id, block.name);
      return;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    let ended = false;
    for (const block of content as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      tool_use_id?: unknown;
    }[]) {
      if (record.type === "assistant" && block?.type === "tool_use") begin(block.id, block.name);
      if (
        record.type === "user" &&
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      )
        ended = this.executing.delete(block.tool_use_id) || ended;
    }
    if (ended) this.check();
  }

  /** The turn is over: nothing it began still runs, and a safe stop of it has stopped. */
  turnOver(): void {
    this.executing.clear();
    this.stop?.end();
  }

  private check(): void {
    const stop = this.stop;
    if (!stop || stop.cut) return;
    const calls = [...this.executing.values()];
    if (calls.length > 0) {
      stop.options.waiting?.(calls);
      return;
    }
    stop.cut = true;
    stop.options.waiting?.([]);
    this.interrupt();
  }
}
