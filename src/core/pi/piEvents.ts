import {
  type FmEvent,
  type FmUsage,
  PROGRESS_TOOL_NAMES,
  UNSTATED_TURN_ERROR,
} from "@shared/events";
import type { SessionEvent } from "../session/session";

const [COMPACTION_TOOL, RETRY_TOOL] = PROGRESS_TOOL_NAMES;

/**
 * Normalizes raw Pi session events into the FmEvent union. Defensive by
 * design (hi-bit's chatEventsFromPiEvent is the model): the input is
 * `unknown`, anything unrecognized maps to no events, and only FmEvent ever
 * crosses IPC. Compaction and retries surface as pseudo-tools so the shell
 * can show progress without knowing Pi's internals.
 */
export function fmEventsFromPiEvent(event: unknown, taskId: string): FmEvent[] {
  if (
    !event ||
    typeof event !== "object" ||
    typeof (event as { type?: unknown }).type !== "string"
  ) {
    return [];
  }
  const typed = event as Record<string, unknown>;
  switch (typed.type) {
    case "message_update": {
      const assistantEvent = typed.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
        return [{ type: "assistant_delta", taskId, text: assistantEvent.delta }];
      }
      if (assistantEvent?.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
        return [{ type: "thinking_delta", taskId, text: assistantEvent.delta }];
      }
      return [];
    }
    case "tool_execution_start": {
      return [
        {
          type: "tool_start",
          taskId,
          callId: String(typed.toolCallId),
          toolName: String(typed.toolName),
        },
      ];
    }
    case "tool_execution_end": {
      return [
        {
          type: "tool_end",
          taskId,
          callId: String(typed.toolCallId),
          toolName: String(typed.toolName),
          isError: Boolean(typed.isError),
        },
      ];
    }
    case "turn_end": {
      const usage = usageFromMessage(typed.message);
      const events: FmEvent[] = [];
      // Pi's agent loop resolves a provider-failed turn instead of throwing
      // (the message carries stopReason "error"); surface it as its own
      // event or the failure never becomes visible anywhere.
      const error = errorFromMessage(typed.message);
      if (error !== undefined) {
        events.push({ type: "turn_failed", taskId, error });
      }
      events.push({ type: "turn_end", taskId, ...(usage ? { usage } : {}) });
      return events;
    }
    case "compaction_start": {
      return [
        { type: "tool_start", taskId, callId: `${taskId}:compaction`, toolName: COMPACTION_TOOL },
      ];
    }
    case "compaction_end": {
      const usage =
        !typed.aborted && !typed.errorMessage ? usageFromMessage(typed.result) : undefined;
      return [
        {
          type: "tool_end",
          taskId,
          callId: `${taskId}:compaction`,
          toolName: COMPACTION_TOOL,
          isError: Boolean(typed.errorMessage),
          ...(usage ? { usage } : {}),
        },
      ];
    }
    case "auto_retry_start": {
      const attempt = Number(typed.attempt);
      return [
        { type: "tool_start", taskId, callId: `${taskId}:retry:${attempt}`, toolName: RETRY_TOOL },
      ];
    }
    case "auto_retry_end": {
      const attempt = Number(typed.attempt);
      return [
        {
          type: "tool_end",
          taskId,
          callId: `${taskId}:retry:${attempt}`,
          toolName: RETRY_TOOL,
          isError: typed.success === false,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * A session's view of one raw Pi event (the session contract,
 * `src/core/session/`): its FmEvents, a `request_started` as a model
 * request begins (the model's reply starting, or a compaction's summary
 * being asked for), and after a turn_end the `turn_closed` that carries the
 * turn's closing assistant text. The owner reads only these; no Pi event
 * shape crosses the contract.
 */
export function seatEventsFromPiEvent(event: unknown, taskId: string): SessionEvent[] {
  const type = (event as { type?: unknown } | null)?.type;
  // A retried attempt is not a failed turn, but its measured usage still is.
  // The holder already normalized it, provider included. Reading the message
  // again would drop a custom request whose counts are unknown.
  if (type === "turn_end" && (event as { usageOnly?: unknown }).usageOnly === true) {
    const usage = (event as { usage?: FmUsage }).usage;
    return usage ? [{ type: "turn_end", taskId, usage }] : [];
  }
  if (type === "compaction_start" || isAssistantStart(event)) {
    return [{ type: "request_started" }, ...fmEventsFromPiEvent(event, taskId)];
  }
  const events: SessionEvent[] = fmEventsFromPiEvent(event, taskId);
  if (type !== "turn_end") return events;
  const text = closingText((event as { message?: unknown }).message);
  events.push({ type: "turn_closed", ...(text ? { text } : {}) });
  return events;
}

/** The model's reply began: Pi's first word of a model request. */
function isAssistantStart(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const typed = event as { type?: unknown; message?: { role?: unknown } };
  return typed.type === "message_start" && typed.message?.role === "assistant";
}

/** The assistant text of a turn_end message, joined; undefined when none. */
function closingText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const typed = part as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

/** The provider error a turn ended with, or undefined for a clean stop. */
function errorFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const typed = message as { stopReason?: unknown; errorMessage?: unknown };
  if (typed.stopReason !== "error") return undefined;
  return typeof typed.errorMessage === "string" && typed.errorMessage
    ? typed.errorMessage
    : UNSTATED_TURN_ERROR;
}

/**
 * Pulls the per-message usage (tokens and cost) for burn tracking (D-18).
 * Pi prices a message from the model's listed per-category rates; a model
 * with no rates prices it at zero, which says nothing about what it cost,
 * so a zero estimate is left out rather than recorded as free.
 */
export function usageFromMessage(message: unknown): FmUsage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const cost =
    u.cost && typeof u.cost === "object" ? (u.cost as Record<string, unknown>) : undefined;
  const result: FmUsage = {};
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const reasoning = num(u.reasoning);
  const total = cost ? num(cost.total) : undefined;
  // A missing custom count is stored as zero so Pi estimates the chat, and the
  // price stays unknown. Zero with an unknown price is that stand-in, not a measurement.
  // A reported price of zero still counts: those tokens were measured.
  const priced = total !== undefined;
  const reported = (value: number | undefined) => value !== undefined && (value !== 0 || priced);
  if (reported(reasoning)) result.reasoning = reasoning;
  if (reported(input)) result.input = input;
  if (reported(output)) result.output = output;
  if (reported(cacheRead)) result.cacheRead = cacheRead;
  if (reported(cacheWrite)) result.cacheWrite = cacheWrite;
  if (cost && total !== undefined && total > 0) {
    result.cost = total;
    result.costSource = "listed-prices";
    const parts = {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
    };
    const known = Object.entries(parts).filter(([, value]) => value !== undefined);
    if (known.length > 0) result.costParts = Object.fromEntries(known);
  }
  // A custom reply with no volunteered counts still represents a request.
  // Keep the empty usage object so every ledger consumer records its unknowns.
  const provider = (message as { provider?: unknown }).provider;
  const custom = typeof provider === "string" && /^fm-custom-[a-f0-9]{16}$/.test(provider);
  return Object.keys(result).length > 0 || custom ? result : undefined;
}

/** One subscription's completed housekeeping calls, never a replay of saved history. */
export function piSessionEvents(taskId: string): (event: unknown) => SessionEvent[] {
  let compactionEnded = false;
  return (event) => {
    const type = (event as { type?: unknown } | null)?.type;
    if (type === "compaction_start") compactionEnded = false;
    if (type === "compaction_end") {
      if (compactionEnded) return [];
      compactionEnded = true;
    }
    return seatEventsFromPiEvent(event, taskId);
  };
}
