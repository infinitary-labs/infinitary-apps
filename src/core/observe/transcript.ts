import { isAuthFailureMessage } from "@shared/authFailure";
import type { ObserveTurn } from "@shared/observe";
import { parseServedInput } from "@shared/servedFrame";
import { cutText } from "@shared/textCut";
import { usageFromMessage } from "../pi/piEvents";
import { redactObserveText } from "./redact";

const TOOL_TEXT_LIMIT = 8_000;

export type ParsedSessionMeta = {
  sessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  model: string | null;
  error: string | null;
  /**
   * The session's CURRENT auth state: true only while its latest
   * provider-reported error is an auth failure. Set exclusively from
   * assistant stopReason "error" messages - never from tool or bash errors,
   * which quote arbitrary text - and cleared by a later completed turn, so
   * one old 401 cannot badge a rolling session forever.
   */
  authFailure: boolean;
};

export type ParsedSession = ParsedSessionMeta & {
  turns: ObserveTurn[];
};

export function emptyParsedSession(): ParsedSession {
  return {
    sessionId: null,
    startedAt: null,
    endedAt: null,
    model: null,
    error: null,
    authFailure: false,
    turns: [],
  };
}

/**
 * Pi session JSONL → Observe turns. Splits Firstmate's concatenated
 * context+[user] messages so the loop is readable, redacts secrets, and
 * skips unknown / malformed lines (including a trailing partial write).
 */
export function parseSessionJsonl(raw: string): ParsedSession {
  return finishTranscript(sessionJsonl(raw));
}

/** The same parser, pausable between lines; summaries never materialize message bodies. */
export function* sessionJsonl(raw: string, summary = false): Generator<number, ParsedSession> {
  const { turns, ...meta } = emptyParsedSession();
  if (!raw) return { ...meta, turns };

  const lines = raw.split("\n");
  for (const line of lines) {
    yield line.length;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "session") {
      if (typeof entry.id === "string") meta.sessionId = entry.id;
      const started = timestampOf(entry);
      if (started !== null) meta.startedAt = started;
      continue;
    }
    if (type === "model_change") {
      const model = modelLabel(entry.provider, entry.modelId);
      if (model) meta.model = model;
      continue;
    }
    if (type === "compaction") {
      const at = timestampOf(entry) ?? 0;
      const text =
        !summary && typeof entry.summary === "string"
          ? redactObserveText(entry.summary)
          : "context compacted";
      if (!summary)
        turns.push({
          id: turnId(entry, "compaction"),
          at,
          kind: "compaction",
          text,
        });
      touchTime(meta, at);
      continue;
    }
    if (type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const parsed = turnsFromMessage(entry, message as Record<string, unknown>, summary);
    if (!summary) for (const turn of parsed.turns) turns.push(turn);
    if (parsed.model) meta.model = parsed.model;
    if (parsed.error) meta.error = parsed.error;
    if (parsed.assistantOutcome === "error") {
      meta.authFailure = Boolean(parsed.error && isAuthFailureMessage(parsed.error));
    } else if (parsed.assistantOutcome === "ok") {
      meta.authFailure = false;
    }
    touchTime(meta, parsed.at);
  }

  return { ...meta, turns };
}

function turnsFromMessage(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  summary: boolean,
): {
  turns: ObserveTurn[];
  model: string | null;
  error: string | null;
  at: number;
  /** Assistant messages only: how the provider turn ended (auth tracking). */
  assistantOutcome?: "ok" | "error";
} {
  const at = timestampOf(entry) ?? timestampOf(message) ?? 0;
  const role = typeof message.role === "string" ? message.role : "";
  const id = turnId(entry, role);
  const model = modelLabel(message.provider, message.model);
  const usage = usageFromMessage(message);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  const errorMessage =
    typeof message.errorMessage === "string" ? redactObserveText(message.errorMessage) : "";

  if (role === "user") {
    return {
      turns: summary ? [] : userTurns(id, at, textFromContent(message.content)),
      model,
      error: null,
      at,
    };
  }
  if (role === "assistant") {
    const turns: ObserveTurn[] = [];
    const text = summary ? "" : textFromContent(message.content);
    const toolNames = summary ? [] : toolNamesFromContent(message.content);
    if (text) {
      turns.push({
        id: `${id}:assistant`,
        at,
        kind: "assistant",
        text: redactObserveText(text),
        ...(model ? { model } : {}),
      });
    }
    for (const [index, toolName] of toolNames.entries()) {
      turns.push({
        id: `${id}:tool:${index}`,
        at,
        kind: "tool",
        text: toolName,
        toolName,
      });
    }
    if (stopReason === "error" && errorMessage) {
      turns.push({
        id: `${id}:error`,
        at,
        kind: "error",
        text: errorMessage,
        isError: true,
      });
    }
    if (usage && !summary) {
      turns.push({
        id: `${id}:usage`,
        at,
        kind: "usage",
        text: "",
        usage,
        ...(model ? { model } : {}),
      });
    }
    const assistantOutcome =
      stopReason === "error"
        ? ("error" as const)
        : stopReason === "stop" || stopReason === "length" || stopReason === "toolUse"
          ? ("ok" as const)
          : undefined;
    return {
      turns,
      model,
      error: stopReason === "error" && errorMessage ? errorMessage : null,
      at,
      ...(assistantOutcome ? { assistantOutcome } : {}),
    };
  }
  if (role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const isError = Boolean(message.isError);
    const body =
      !summary || isError ? truncate(redactObserveText(textFromContent(message.content))) : "";
    return {
      turns: [
        {
          id,
          at,
          kind: "tool",
          text: body,
          toolName,
          isError,
        },
      ],
      model: null,
      error: isError ? body || `${toolName} failed` : null,
      at,
    };
  }
  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "bash";
    const output = typeof message.output === "string" ? message.output : "";
    const cancelled = message.cancelled === true;
    const failed = typeof message.exitCode === "number" && message.exitCode !== 0;
    const isError = cancelled || failed;
    return {
      turns: [
        {
          id,
          at,
          kind: "tool",
          text: summary ? "" : truncate(redactObserveText(output || command)),
          toolName: "bash",
          isError,
        },
      ],
      model: null,
      error: isError ? redactObserveText(output || command) : null,
      at,
    };
  }
  return { turns: [], model: null, error: null, at };
}

export function userTurns(id: string, at: number, rawText: string): ObserveTurn[] {
  // A framed input (R2) says what each part is; nothing is read from labels.
  const framed = parseServedInput(rawText);
  if (framed) {
    return framed.flatMap((segment, index): ObserveTurn[] => {
      const segmentId = framed.length === 1 ? id : `${id}:${index}`;
      const body = segment.body.trim();
      if (segment.kind === "context") {
        return [{ id: segmentId, at, kind: "context", text: redactObserveText(body) }];
      }
      if (segment.kind === "wake") {
        return body ? [{ id: segmentId, at, kind: "op", text: redactObserveText(body) }] : [];
      }
      const words = body.startsWith("[user]") ? body.slice("[user]".length).trim() : body;
      return words ? [{ id: segmentId, at, kind: "user", text: redactObserveText(words) }] : [];
    });
  }
  const text = rawText.replace(/\r\n/g, "\n");
  if (text.startsWith("[fm-op] context")) {
    const userMarker = "\n[user]\n";
    const userAt = text.indexOf(userMarker);
    if (userAt >= 0) {
      const context = redactObserveText(text.slice(0, userAt).trim());
      const user = redactObserveText(text.slice(userAt + userMarker.length).trim());
      const turns: ObserveTurn[] = [{ id: `${id}:context`, at, kind: "context", text: context }];
      if (user) turns.push({ id: `${id}:user`, at, kind: "user", text: user });
      return turns;
    }

    // Operational inbox turns receive the same injected context as captain
    // turns, followed by the actual [fm-op] payload instead of a [user]
    // marker. Keep that wrapper out of the op row: Observe should label only
    // content that was sent as the operational message.
    const separator = "\n\n";
    const opAt = text.indexOf(`${separator}[fm-op]`);
    if (opAt >= 0) {
      const context = redactObserveText(text.slice(0, opAt).trim());
      const op = redactObserveText(text.slice(opAt + separator.length).trim());
      const turns: ObserveTurn[] = [{ id: `${id}:context`, at, kind: "context", text: context }];
      if (op) turns.push({ id: `${id}:op`, at, kind: "op", text: op });
      return turns;
    }

    return [{ id: `${id}:context`, at, kind: "context", text: redactObserveText(text) }];
  }
  if (text.startsWith("[fm-op]")) {
    return [{ id, at, kind: "op", text: redactObserveText(text) }];
  }
  return [{ id, at, kind: "user", text: redactObserveText(text) }];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as Record<string, unknown>;
      if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolNamesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const typed = part as Record<string, unknown>;
    if (typed.type === "toolCall" && typeof typed.name === "string") return [typed.name];
    return [];
  });
}

function modelLabel(provider: unknown, id: unknown): string | null {
  if (typeof provider === "string" && typeof id === "string" && provider && id) {
    return `${provider}/${id}`;
  }
  return null;
}

export function timestampOf(entry: Record<string, unknown>): number | null {
  const value = entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function turnId(entry: Record<string, unknown>, fallback: string): string {
  return typeof entry.id === "string" && entry.id ? entry.id : fallback;
}

export function touchTime(meta: ParsedSessionMeta, at: number): void {
  if (!at) return;
  if (meta.startedAt === null || at < meta.startedAt) meta.startedAt = at;
  if (meta.endedAt === null || at > meta.endedAt) meta.endedAt = at;
}

export function truncate(text: string): string {
  if (text.length <= TOOL_TEXT_LIMIT) return text;
  const omitted = text.length - TOOL_TEXT_LIMIT;
  return `${cutText(text, TOOL_TEXT_LIMIT)}\n[truncated ${omitted} characters]`;
}

/** Synchronous offline readers use the very same line parser. */
export function finishTranscript(parser: Generator<number, ParsedSession>): ParsedSession {
  let next = parser.next();
  while (!next.done) next = parser.next();
  return next.value;
}
