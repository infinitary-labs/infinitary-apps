import type { CutOff } from "@shared/authFailure";
import type { ClaudeRateLimit } from "../../src/core/claude/claudeEvents";
import {
  CLAUDE_MODEL_PROVIDER,
  type ClaudeQueryFactory,
} from "../../src/core/claude/claudeQueryCore";
import { CLAUDE_STEER_PRIORITY } from "../../src/core/claude/claudeSessionOptions";
import { CREWMATE_TOOLS } from "../../src/core/pi/crewmateTaskTools";
import { bindTools, type CrewmateToolDelegate } from "../../src/core/session/tools";
import { codingSpec } from "./codingSession";
import { type SDKUserMessage, scriptedClaudeFactory } from "./scriptedClaudeQuery";

/** A crewmate as a case describes it: its facts, its callbacks, and its continuations. */
export type CrewmateCase = CrewmateToolDelegate & {
  taskId: string;
  cwd: string;
  configDir: string;
  systemPrompt: string;
  model?: string;
  thinking?: "low" | "medium" | "high" | "xhigh";
  quick?: boolean;
  resumeToken?: string;
  onRateLimit?: (reading: ClaudeRateLimit) => void;
  onServed?: (accountId: string) => void;
  log?: (line: string) => void;
  /** The continuation boundary, as the supervisor follows it. */
  onContinuationStart?: () => void;
  onContinuationEnd?: (error?: string, cutOff?: CutOff) => void;
};

/**
 * The crewmate's session, from Claude's factory on a scripted client: its
 * tools are the ones its callbacks bind (the crewmate preset's), and its
 * continuations reach the case's callbacks as the supervisor follows them.
 */
export async function createClaudeSession(spec: CrewmateCase, query: ClaudeQueryFactory) {
  const onRateLimit = spec.onRateLimit;
  const session = await scriptedClaudeFactory({
    configDir: spec.configDir,
    query,
    ...(onRateLimit ? { onRateLimit: (_accountId, reading) => onRateLimit(reading) } : {}),
    ...(spec.onServed ? { onServed: spec.onServed } : {}),
    ...(spec.log ? { log: spec.log } : {}),
  }).open(
    codingSpec({
      binding: { backend: "claude", accountId: "acct_claude" },
      cwd: spec.cwd,
      owner: spec.taskId,
      instructions: spec.systemPrompt,
      ...(spec.model ? { model: { provider: CLAUDE_MODEL_PROVIDER, id: spec.model } } : {}),
      ...(spec.thinking ? { thinking: spec.thinking } : {}),
      ...(spec.quick ? { quick: true } : {}),
      ...(spec.resumeToken
        ? { resume: { backend: "claude", sessionId: spec.resumeToken } as const }
        : {}),
      tools: bindTools(CREWMATE_TOOLS, spec),
    }),
  );
  // Only a case that follows continuations subscribes here: the first
  // subscriber is handed every event emitted before it.
  if (spec.onContinuationStart || spec.onContinuationEnd) {
    session.subscribe((event) => {
      if (event.type === "continuation_started") spec.onContinuationStart?.();
      if (event.type === "continuation_ended") spec.onContinuationEnd?.(event.error, event.cutOff);
    });
  }
  return session;
}

/** One result message, with the cumulative totals the client actually sends. */
export function result(totals: { cost: number; input: number; output: number }, text = "done") {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: totals.cost,
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: totals.cost,
      },
    },
    session_id: "session-under-test",
  };
}

/** What the client says around a turn, as a rolling session asks it to. */
export const says = {
  running: { type: "system", subtype: "session_state_changed", state: "running" },
  idle: { type: "system", subtype: "session_state_changed", state: "idle" },
  /** The client took this pushed message into a turn. */
  ack: (message: SDKUserMessage) => ({
    type: "user",
    isReplay: true,
    uuid: message.uuid,
    message: message.message,
    parent_tool_use_id: null,
  }),
  /** The model called a tool, whose result the client has not handed back yet. */
  toolCall: (id: string, name: string) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  }),
  toolResult: (id: string) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false }] },
  }),
};

export type Emit = (message: unknown) => void;

/** A turn opens on a pushed message: the client runs, and takes the message in. */
export function opens(emit: Emit, message: SDKUserMessage): void {
  emit(says.running);
  emit(says.ack(message));
}

/** A turn ends on its result, and the client is idle again. */
export function closes(emit: Emit, message: unknown): void {
  emit(message);
  emit(says.idle);
}

/** A client that answers every prompt in one turn, with what `reply` says. */
export function answering(reply: (message: SDKUserMessage) => unknown[]) {
  return (message: SDKUserMessage, emit: Emit) => {
    if (message.priority === CLAUDE_STEER_PRIORITY) return;
    opens(emit, message);
    const said = reply(message);
    for (const line of said.slice(0, -1)) emit(line);
    closes(emit, said.at(-1));
  };
}

/** An interrupt the client answers the way it answers the host's own: the turn ends, idle. */
export function interruptedBy(ending: unknown) {
  return (emit: Emit) => closes(emit, ending);
}

export const interruptedResult = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  terminal_reason: "aborted_streaming",
  total_cost_usd: 0.01,
  modelUsage: {},
};

export const baseSpec = {
  taskId: "task-1",
  cwd: "/tmp/worktree",
  configDir: "/accounts/anthropic-claude/acct_a",
  systemPrompt: "You are a crewmate.",
};
