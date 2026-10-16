import { classifyClaudeSignal } from "@shared/authFailure";
import type { ObserveTurn } from "@shared/observe";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { redactObserveText } from "./redact";
import {
  emptyParsedSession,
  finishTranscript,
  type ParsedSession,
  timestampOf,
  touchTime,
  truncate,
  userTurns,
} from "./transcript";

/**
 * Claude's own session JSONL → Observe turns, the same vocabulary the Pi
 * parser produces so the pane reads identically for a crewmate on either
 * backend. The file is the one Claude's client writes for a run of ours
 * (src/core/claude/claudeTranscript.ts locates it); Infinitary never writes
 * it, so this is a reader over a vendor shape, kept deliberately loose:
 *
 * - one line per content block: an assistant message is split over several
 *   lines that share `message.id` and repeat the same `usage`, so usage is
 *   emitted once per message, after its last block;
 * - `user` lines carry captain/host text (string or text parts) or
 *   `tool_result` parts, whose tool name is joined from the earlier
 *   `tool_use` id;
 * - `isApiErrorMessage` marks the provider-failed turn (the only error
 *   channel), `isCompactSummary` the post-compaction summary, `isMeta` a
 *   client-injected line; everything else (queue ops, snapshots, modes,
 *   attachments, system lines, sidechains) is skipped.
 */
export function parseClaudeTranscript(raw: string): ParsedSession {
  return finishTranscript(claudeTranscript(raw));
}

export function* claudeTranscript(raw: string, summary = false): Generator<number, ParsedSession> {
  const { turns, ...meta } = emptyParsedSession();
  if (!raw) return { ...meta, turns };

  const toolNames = new Map<string, string>();
  let pendingUsage: { messageId: string; turn: ObserveTurn } | null = null;
  const flushUsage = (unlessMessageId?: string) => {
    if (pendingUsage && pendingUsage.messageId !== unlessMessageId) {
      turns.push(pendingUsage.turn);
      pendingUsage = null;
    }
  };

  for (const line of raw.split("\n")) {
    yield line.length;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (meta.sessionId === null && typeof entry.sessionId === "string") {
      meta.sessionId = entry.sessionId;
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    const message = entry.message;
    if ((type !== "user" && type !== "assistant") || !message || typeof message !== "object") {
      continue;
    }
    const typed = message as Record<string, unknown>;
    const at = timestampOf(entry) ?? 0;
    const id = typeof entry.uuid === "string" && entry.uuid ? entry.uuid : type;

    if (type === "user") {
      flushUsage();
      const text = summary ? "" : textFromContent(typed.content);
      if (entry.isCompactSummary === true) {
        if (!summary)
          turns.push({
            id: `${id}:compaction`,
            at,
            kind: "compaction",
            text: truncate(redactObserveText(text)),
          });
      } else if (entry.isMeta === true) {
        if (text) {
          turns.push({ id: `${id}:context`, at, kind: "context", text: redactObserveText(text) });
        }
      } else {
        for (const [index, result] of toolResultsFromContent(typed.content).entries()) {
          const toolName = toolNames.get(result.toolUseId) ?? "tool";
          const body = !summary || result.isError ? truncate(redactObserveText(result.text)) : "";
          if (!summary)
            turns.push({
              id: `${id}:result:${index}`,
              at,
              kind: "tool",
              text: body,
              toolName,
              isError: result.isError,
            });
          if (result.isError) meta.error = body || `${toolName} failed`;
        }
        if (text) for (const turn of userTurns(id, at, text)) turns.push(turn);
      }
      touchTime(meta, at);
      continue;
    }

    const messageId = typeof typed.id === "string" ? typed.id : id;
    flushUsage(messageId);
    const model =
      typeof typed.model === "string" && typed.model
        ? `${CLAUDE_PROVIDER_ID}/${typed.model}`
        : null;
    if (model) meta.model = model;
    const text = textFromContent(typed.content);
    if (entry.isApiErrorMessage === true) {
      const error = redactObserveText(text || "provider error");
      if (!summary)
        turns.push({ id: `${id}:error`, at, kind: "error", text: error, isError: true });
      meta.error = error;
      // The client writes the typed error beside its words; only that field
      // says whether the sign-in was the problem - no longer accepted, or
      // refused here (docs/quota.md "Typed cut-offs").
      const outcome =
        typeof entry.error === "string"
          ? classifyClaudeSignal({ isError: true, assistantError: entry.error })
          : undefined;
      meta.authFailure =
        outcome?.kind === "cut-off" &&
        (outcome.cutOff.class === "signed_out" || outcome.cutOff.class === "refused");
      touchTime(meta, at);
      continue;
    }
    if (text && !summary) {
      turns.push({
        id: `${id}:assistant`,
        at,
        kind: "assistant",
        text: redactObserveText(text),
        ...(model ? { model } : {}),
      });
    }
    for (const [index, call] of toolUsesFromContent(typed.content).entries()) {
      if (call.id) toolNames.set(call.id, call.name);
      if (!summary)
        turns.push({
          id: `${id}:tool:${index}`,
          at,
          kind: "tool",
          text: call.name,
          toolName: call.name,
        });
    }
    const usage = usageOf(typed.usage);
    if (usage && !pendingUsage && !summary) {
      pendingUsage = {
        messageId,
        turn: {
          id: `${messageId}:usage`,
          at,
          kind: "usage",
          text: "",
          usage,
          ...(model ? { model } : {}),
        },
      };
    }
    if (typeof typed.stop_reason === "string" && typed.stop_reason) meta.authFailure = false;
    touchTime(meta, at);
  }
  flushUsage();
  return { ...meta, turns };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as Record<string, unknown>;
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolUsesFromContent(content: unknown): { id: string; name: string }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const typed = part as Record<string, unknown>;
    if (typed.type !== "tool_use" || typeof typed.name !== "string") return [];
    return [{ id: typeof typed.id === "string" ? typed.id : "", name: typed.name }];
  });
}

function toolResultsFromContent(
  content: unknown,
): { toolUseId: string; text: string; isError: boolean }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const typed = part as Record<string, unknown>;
    if (typed.type !== "tool_result") return [];
    return [
      {
        toolUseId: typeof typed.tool_use_id === "string" ? typed.tool_use_id : "",
        text: textFromContent(typed.content),
        isError: typed.is_error === true,
      },
    ];
  });
}

function usageOf(value: unknown): ObserveTurn["usage"] | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    typeof usage[key] === "number" && Number.isFinite(usage[key])
      ? (usage[key] as number)
      : undefined;
  const input = number("input_tokens");
  const output = number("output_tokens");
  const cacheRead = number("cache_read_input_tokens");
  const cacheWrite = number("cache_creation_input_tokens");
  if (input === undefined && output === undefined) return null;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead ? { cacheRead } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
  };
}
