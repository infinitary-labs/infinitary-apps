import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The one reader of a rolling session's record (W1 S11; the session
 * contract's step 6), whichever role it served. Every offline consumer - the
 * replay engine (the Firstmate's recording and each crewmate's), the
 * dispatch extractor (C5) and the corpus export over it, the kind-classifier
 * scorer and dev Observe's Firstmate pane - opens a session through here,
 * and so does a task record's Activity, which reads a crewmate's calls
 * (`sessionToolCalls`; docs/task-record.md, "A crewmate's actions"),
 * whichever backend served it:
 *
 * - **pi**: the Pi session JSONL (`firstmate/sessions/`,
 *   `crewmates/<task>/sessions/`), read exactly as it was written;
 * - **claude**: the app's copy of the Claude client's transcript
 *   (`SessionRecordStore`: the seat's under `firstmate/claude/`, a
 *   crewmate's beside a Pi crewmate's under `crewmates/<task>/sessions/`),
 *   joined to its served sidecar.
 *
 * The dialect is read from the file's own first line, never from its path.
 * A Claude session is mapped into the Pi dialect's entries - the one shape
 * every reader already walks - so a Claude-served turn reads as the same
 * turn a Pi-served one does:
 *
 * - a top-level `user` line with words is the served prompt, a
 *   `queued_command` attachment a steer the client folded into the running
 *   turn (Pi records both as a `user` message); the client's own queued
 *   notice - a background command of its own finishing - keeps the client's
 *   `commandMode` (`task-notification`) on that message, because nobody
 *   served it: the turn carried on by itself;
 * - an `assistant` line's `tool_use` blocks are `toolCall`s, their names
 *   without the app tool server's `mcp__infinitary__` prefix (or the older
 *   `mcp__firstmate__`), and the client's
 *   several lines of one message are one message;
 * - a `tool_result` block inside a `user` line is a `toolResult` message;
 * - the model rides each assistant message (the client writes no model
 *   entry of its own), labelled `anthropic-claude/<id>`; its usage keeps
 *   the latest reported counter per field across that message's blocks,
 *   never summing repeated usage or inventing a missing counter;
 * - the contract that served a turn, when its role stamps one, comes from
 *   the sidecar, as a Pi session's `fm-contract` custom entry. The client
 *   writes its transcript on its own schedule, so the join is by the uuid
 *   the session gave each message, kept in the sidecar's served stamps,
 *   never by a location the session read back at the turn's end; a turn no
 *   stamp names takes the contract stamped last before it.
 *
 * Everything else the client writes (its queue, its token reminders, its
 * sidechains, its own injected lines) is not the conversation and is left
 * out.
 *
 * No imports beyond Node's own: the offline scripts load this file through
 * Node's type stripping.
 */

type JsonRecord = Record<string, unknown>;

export type SessionDialect = "pi" | "claude";

/** A session file, read. */
export type SessionRead = {
  path: string;
  dialect: SessionDialect;
  /** The session id the file records, when it records one. */
  sessionId: string | null;
  /** The session in the Pi dialect's entries: a Pi file's own lines, parsed. */
  entries: JsonRecord[];
  /** The same entries as JSONL: a Pi file's own text, byte for byte. */
  text: string;
};

/** The server the Claude seat serves the Firstmate's tools on. */
export const CLAUDE_SEAT_TOOL_SERVER = "infinitary";

/** How the Claude client names each of those tools: `mcp__infinitary__<name>`. */
export const CLAUDE_SEAT_TOOL_PREFIX = `mcp__${CLAUDE_SEAT_TOOL_SERVER}__`;

/**
 * Every prefix a Claude transcript names the app's tools by: Infinitary's,
 * and `mcp__firstmate__`, the server's name before the Infinitary rename,
 * which a conversation recorded or resumed from then still carries.
 */
const CLAUDE_SEAT_TOOL_PREFIXES = [CLAUDE_SEAT_TOOL_PREFIX, "mcp__firstmate__"] as const;

/** A tool's own name, as a Claude transcript names it under the app's server or not. */
export function bareToolName(name: string): string {
  const prefix = CLAUDE_SEAT_TOOL_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? name.slice(prefix.length) : name;
}

/**
 * The `commandMode` the client gives a notice it queued itself: one of its own
 * background commands finished. Every other queued command was served.
 */
export const CLIENT_NOTICE = "task-notification";

/**
 * The line the client writes as a user message when a turn is interrupted
 * (`[Request interrupted by user]`, and its `for tool use` form): the
 * client's own notice, not words anyone sent, as the client's own SDK
 * reads it. A reader that shows a conversation leaves it out.
 */
export const CLIENT_INTERRUPT_NOTICE = /^\[Request interrupted by user[^\]]*\]$/;

/** The provider a Claude-served turn's model is labelled under (`CLAUDE_PROVIDER_ID`). */
const CLAUDE_PROVIDER = "anthropic-claude";

/** How much of a session file a first-line read takes at a time. */
const FIRST_LINE_CHUNK = 64 * 1024;

/** The Pi session's contract stamp (`FIRSTMATE_CONTRACT_ENTRY`, src/core/pi/session.ts). */
const CONTRACT_ENTRY = "fm-contract";

/** The served sidecar beside a Claude transcript copy: `<sessionId>.served.jsonl`. */
export function sidecarPathOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, ".served.jsonl");
}

/**
 * The dialect a session file is written in, from its first line: a Pi
 * session opens on its `session` header, and every line the Claude client
 * writes names its session. Anything else - a sidecar, a torn line - is
 * not a session's first line.
 */
export function sessionDialect(firstLine: string): SessionDialect | null {
  const entry = parseLine(firstLine);
  if (!entry) return null;
  if (entry.type === "session") return "pi";
  if (typeof entry.type === "string" && typeof entry.sessionId === "string") return "claude";
  return null;
}

/** The dialect a whole session text is written in, by its first line. */
export function sessionDialectOf(raw: string): SessionDialect | null {
  return sessionDialect(firstLineOf(raw));
}

/**
 * The dialect of a session file on disk, off its first line alone: a
 * rolling session is never read whole to learn who wrote it. Null when the
 * file cannot be read or its first line is not a session's.
 */
export function sessionDialectAt(path: string): SessionDialect | null {
  const line = firstLineAt(path);
  return line === null ? null : sessionDialect(line);
}

/** Read one session file, whichever backend wrote it. */
export function readSession(path: string): SessionRead {
  const raw = readFileSync(path, "utf8");
  if (sessionDialectOf(raw) !== "claude") {
    // A Pi session, or a file no reader recognizes: read as Pi always was.
    const entries = parseLines(raw);
    const header = entries.find((entry) => entry.type === "session");
    return {
      path,
      dialect: "pi",
      sessionId: typeof header?.id === "string" ? header.id : null,
      entries,
      text: raw,
    };
  }
  const sidecar = sidecarPathOf(path);
  const served =
    sidecar !== path && existsSync(sidecar) ? parseLines(readFileSync(sidecar, "utf8")) : [];
  const entries = claudeSessionEntries(parseLines(raw), served);
  const header = entries[0];
  return {
    path,
    dialect: "claude",
    sessionId: typeof header?.id === "string" ? header.id : null,
    entries,
    text: entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "",
  };
}

/** A call a session's own conversation made (`sessionToolCalls`). */
export type SessionToolCall = {
  /** When the session recorded it; null when its line names no time. */
  at: number | null;
  /** The tool, as the Pi dialect's `toolCall` names it. */
  name: string;
  arguments: JsonRecord;
};

/** A line only an assistant's message can be, in each dialect; anything else holds no call. */
const ASSISTANT_LINE: Record<SessionDialect, RegExp> = {
  pi: /"role"\s*:\s*"assistant"/,
  claude: /"type"\s*:\s*"assistant"/,
};

/**
 * The tool calls a session's own conversation made, in file order, from the
 * whole lines of `text`: a Pi assistant message's `toolCall` parts, and a
 * Claude assistant line's `tool_use` blocks, named as `readSession` names
 * them. A sidechain's calls are its helper's, not the session's, and are
 * left out, as `readSession` leaves them out. Only a line that can be an
 * assistant's is parsed, so a long session's tool output costs a scan, not
 * a parse; a reader that follows a growing session passes only what was
 * appended since its last read.
 */
export function sessionToolCalls(text: string, dialect: SessionDialect): SessionToolCall[] {
  const calls: SessionToolCall[] = [];
  for (const line of text.split("\n")) {
    if (!ASSISTANT_LINE[dialect].test(line)) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (dialect === "pi") {
      const message = entry.message as JsonRecord | undefined;
      if (entry.type !== "message" || message?.role !== "assistant") continue;
      if (!Array.isArray(message.content)) continue;
      const at = timeOf(entry) ?? timeOf(message);
      for (const part of message.content as unknown[]) {
        if (!part || typeof part !== "object") continue;
        const typed = part as JsonRecord;
        if (typed.type !== "toolCall" || typeof typed.name !== "string") continue;
        const args = typed.arguments;
        calls.push({
          at,
          name: typed.name,
          arguments: args && typeof args === "object" ? (args as JsonRecord) : {},
        });
      }
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    const body = entry.message as JsonRecord | undefined;
    for (const block of assistantBlocks(body?.content)) {
      if (block.type !== "toolCall") continue;
      calls.push({
        at: timeOf(entry),
        name: String(block.name),
        arguments: block.arguments as JsonRecord,
      });
    }
  }
  return calls;
}

/**
 * The session files in a directory, oldest name first: every
 * `.jsonl` file but a served sidecar, which is a Claude session's companion
 * rather than a session of its own.
 */
export function sessionFilesIn(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile() && !isSidecarLine(firstLineAt(file) ?? ""))
    .sort();
}

/**
 * A Claude session's lines and its sidecar's records, as Pi-dialect
 * entries: a `session` header, then the conversation in file order.
 */
export function claudeSessionEntries(lines: JsonRecord[], sidecar: JsonRecord[]): JsonRecord[] {
  const mapper = new ClaudeSessionMapper(sidecar);
  for (const entry of lines) mapper.push(entry);
  return mapper.entries();
}

/**
 * The mapping `claudeSessionEntries` makes, one client line at a time, so a
 * reader that follows a growing session (`SessionFollower`) maps only what
 * was appended. A later line of a message the mapper already holds joins
 * that message's entry, as the client writes one line per content block.
 */
class ClaudeSessionMapper {
  private readonly contracts: ReturnType<typeof sidecarContracts>;
  private readonly out: JsonRecord[] = [];
  private readonly toolNames = new Map<string, string>();
  private readonly assistants = new Map<string, JsonRecord>();
  private sessionId: string | null = null;
  private startedAt: unknown;
  private stamped: string | null = null;
  private stamps = 0;

  constructor(sidecar: JsonRecord[]) {
    this.contracts = sidecarContracts(sidecar);
  }

  /** The session's entries so far: its `session` header, then the conversation. */
  entries(): JsonRecord[] {
    if (this.sessionId === null) return this.out;
    return [
      {
        type: "session",
        id: this.sessionId,
        ...(this.startedAt !== undefined ? { timestamp: this.startedAt } : {}),
      },
      ...this.out,
    ];
  }

  private openTurn(entry: JsonRecord, servedUuid: unknown, content: unknown, commandMode?: string) {
    const contract =
      (typeof servedUuid === "string" ? this.contracts.byUuid.get(servedUuid) : undefined) ??
      this.contracts.before(timeOf(entry));
    if (contract) {
      const key = JSON.stringify(contract);
      if (key !== this.stamped) {
        // An entry id like every other, unique to the session, as Pi gives its stamp one.
        this.stamps += 1;
        const id = `${this.sessionId ?? ""}#${CONTRACT_ENTRY}-${this.stamps}`;
        this.out.push({ type: "custom", customType: CONTRACT_ENTRY, id, data: contract });
        this.stamped = key;
      }
    }
    this.out.push(
      message(entry, {
        role: "user",
        content: userContent(content),
        ...(commandMode === CLIENT_NOTICE ? { commandMode } : {}),
      }),
    );
  }

  push(entry: JsonRecord): void {
    if (this.sessionId === null && typeof entry.sessionId === "string") {
      this.sessionId = entry.sessionId;
    }
    if (this.startedAt === undefined && entry.timestamp !== undefined) {
      this.startedAt = entry.timestamp;
    }
    if (entry.isSidechain === true) return;
    const body = entry.message as JsonRecord | undefined;
    if (entry.type === "attachment") {
      const attachment = entry.attachment as JsonRecord | undefined;
      if (attachment?.type === "queued_command") {
        this.openTurn(
          entry,
          attachment.source_uuid,
          attachment.prompt,
          typeof attachment.commandMode === "string" ? attachment.commandMode : undefined,
        );
      }
      return;
    }
    if (!body || typeof body !== "object") return;
    if (entry.type === "user") {
      if (entry.isMeta === true) return;
      if (entry.isCompactSummary === true) {
        this.out.push({
          type: "compaction",
          ...ids(entry),
          summary: textOf(body.content),
        });
        return;
      }
      const results = toolResultsOf(body.content);
      if (results.length === 0) {
        this.openTurn(entry, entry.uuid, body.content);
        return;
      }
      results.forEach((result, index) => {
        this.out.push({
          type: "message",
          ...ids(entry),
          id: `${String(entry.uuid ?? "")}:${index}`,
          message: {
            role: "toolResult",
            toolCallId: result.toolUseId,
            toolName: this.toolNames.get(result.toolUseId) ?? "",
            content: result.content,
            isError: result.isError,
          },
        });
      });
      return;
    }
    if (entry.type !== "assistant") return;
    const blocks = assistantBlocks(body.content);
    for (const block of blocks) {
      if (block.type === "toolCall") this.toolNames.set(String(block.id), String(block.name));
    }
    const messageId = typeof body.id === "string" && body.id ? body.id : String(entry.uuid ?? "");
    const failed = entry.isApiErrorMessage === true;
    const usage = failed ? undefined : claudeMessageUsage(body.usage);
    const existing = this.assistants.get(messageId);
    if (existing) {
      // The client writes one line per content block of the same message.
      const held = existing.message as JsonRecord;
      held.content = [...(held.content as JsonRecord[]), ...blocks];
      if (typeof body.stop_reason === "string") held.stopReason = stopReasonOf(body.stop_reason);
      if (usage) held.usage = { ...(held.usage as JsonRecord | undefined), ...usage };
      return;
    }
    const record = message(entry, {
      role: "assistant",
      content: blocks,
      ...(usage ? { usage } : {}),
      ...(!failed && typeof body.model === "string" && body.model
        ? { provider: CLAUDE_PROVIDER, model: body.model }
        : {}),
      ...(failed
        ? {
            stopReason: "error",
            errorMessage: textOf(body.content) || String(entry.error ?? "error"),
          }
        : typeof body.stop_reason === "string"
          ? { stopReason: stopReasonOf(body.stop_reason) }
          : {}),
    });
    this.assistants.set(messageId, record);
    this.out.push(record);
  }
}

/**
 * A session followed as it grows, whichever backend writes it: each `read`
 * parses only the whole lines appended since the last, and answers the
 * session's entries in the Pi dialect as `readSession` maps them (a Claude
 * session's several lines of one message are one entry), leaving out the
 * served sidecar's contract stamps, which say nothing about the
 * conversation. A file shorter than what was read is read again from its
 * start. The task card's Crewmate tab reads a crewmate's sessions through
 * this (docs/task-card-tabs.md, "The Crewmate tab").
 */
export class SessionFollower {
  private dialect: SessionDialect | null = null;
  /** The byte just past the last whole line read. */
  private offset = 0;
  private pi: JsonRecord[] = [];
  private claude: ClaudeSessionMapper | null = null;
  /** Bumped whenever a read took in new lines, so a reader can tell a session moved. */
  private generation = 0;

  readonly path: string;

  // A field and an assignment, not a parameter property: the offline scripts
  // load this file through Node's type stripping, which has none.
  constructor(path: string) {
    this.path = path;
  }

  /** The session's entries so far, and a number that moves each time they change. */
  read(): { entries: readonly JsonRecord[]; generation: number } {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { entries: this.entries(), generation: this.generation };
    }
    if (size < this.offset || this.dialect === null) this.reset();
    if (this.dialect === null) {
      this.dialect = sessionDialectAt(this.path);
      if (this.dialect === null) return { entries: [], generation: this.generation };
      if (this.dialect === "claude") this.claude = new ClaudeSessionMapper([]);
    }
    if (size > this.offset) {
      const appended = wholeLinesBetween(this.path, this.offset, size);
      if (appended.bytes > 0) {
        this.offset += appended.bytes;
        this.generation += 1;
        for (const entry of parseLines(appended.text)) {
          if (this.claude) this.claude.push(entry);
          else this.pi.push(entry);
        }
      }
    }
    return { entries: this.entries(), generation: this.generation };
  }

  private entries(): readonly JsonRecord[] {
    return this.claude ? this.claude.entries() : this.pi;
  }

  private reset(): void {
    if (this.offset > 0) this.generation += 1;
    this.dialect = null;
    this.offset = 0;
    this.pi = [];
    this.claude = null;
  }
}

/** The whole lines between byte `from` and `to`; a torn last line waits for the next read. */
function wholeLinesBetween(
  path: string,
  from: number,
  to: number,
): { text: string; bytes: number } {
  const none = { text: "", bytes: 0 };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return none;
  }
  try {
    const buffer = Buffer.alloc(to - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    return end < 0 ? none : { text: buffer.toString("utf8", 0, end + 1), bytes: end + 1 };
  } catch {
    return none;
  } finally {
    closeSync(fd);
  }
}

/** A message's counters, not a turn total: later content blocks may finish its usage. */
function claudeMessageUsage(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as JsonRecord;
  const usage: JsonRecord = {};
  for (const [from, to] of [
    ["input_tokens", "input"],
    ["output_tokens", "output"],
    ["cache_read_input_tokens", "cacheRead"],
    ["cache_creation_input_tokens", "cacheWrite"],
  ] as const) {
    const count = raw[from];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) usage[to] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

/** The contract each served message was served under, from the sidecar's own order. */
function sidecarContracts(records: JsonRecord[]): {
  byUuid: Map<string, JsonRecord>;
  before: (at: number | null) => JsonRecord | undefined;
} {
  const byUuid = new Map<string, JsonRecord>();
  const stamps: { at: number; contract: JsonRecord }[] = [];
  let current: JsonRecord | undefined;
  for (const record of records) {
    if (record.kind === "contract") {
      if (typeof record.version !== "string" || typeof record.prompt_sha !== "string") continue;
      const { kind: _kind, at, ...contract } = record;
      current = contract;
      if (typeof at === "number") stamps.push({ at, contract });
      continue;
    }
    if (record.kind !== "served" || !current) continue;
    const prompt = record.prompt as JsonRecord | null | undefined;
    if (typeof prompt?.uuid === "string") byUuid.set(prompt.uuid, current);
    for (const steer of Array.isArray(record.steers) ? (record.steers as JsonRecord[]) : []) {
      if (typeof steer?.uuid === "string") byUuid.set(steer.uuid, current);
    }
  }
  return {
    byUuid,
    before: (at) =>
      at === null ? undefined : stamps.findLast((stamp) => stamp.at <= at)?.contract,
  };
}

function message(entry: JsonRecord, body: JsonRecord): JsonRecord {
  return { type: "message", ...ids(entry), message: body };
}

function ids(entry: JsonRecord): JsonRecord {
  return {
    ...(typeof entry.uuid === "string" ? { id: entry.uuid } : {}),
    ...(typeof entry.parentUuid === "string" ? { parentId: entry.parentUuid } : {}),
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
  };
}

/** A prompt's words, as Pi's content parts; a bare string stays a string. */
function userContent(content: unknown): unknown {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.flatMap((part): JsonRecord[] => {
    if (!part || typeof part !== "object") return [];
    const typed = part as JsonRecord;
    if (typed.type === "text" && typeof typed.text === "string") {
      return [{ type: "text", text: typed.text }];
    }
    if (typed.type === "image") {
      const source = typed.source as JsonRecord | undefined;
      return [{ type: "image", data: source?.data ?? "", mimeType: source?.media_type ?? "" }];
    }
    return [];
  });
}

function assistantBlocks(content: unknown): JsonRecord[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): JsonRecord[] => {
    if (!part || typeof part !== "object") return [];
    const typed = part as JsonRecord;
    if (typed.type === "text" && typeof typed.text === "string") {
      return [{ type: "text", text: typed.text }];
    }
    if (typed.type === "thinking" && typeof typed.thinking === "string") {
      return [{ type: "thinking", thinking: typed.thinking }];
    }
    if (typed.type === "tool_use" && typeof typed.name === "string") {
      const name = bareToolName(typed.name);
      const input = typed.input && typeof typed.input === "object" ? typed.input : {};
      return [
        {
          type: "toolCall",
          id: typeof typed.id === "string" ? typed.id : "",
          name,
          arguments: input,
        },
      ];
    }
    return [];
  });
}

function toolResultsOf(
  content: unknown,
): { toolUseId: string; content: JsonRecord[]; isError: boolean }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const typed = part as JsonRecord;
    if (typed.type !== "tool_result") return [];
    const inner = typed.content;
    return [
      {
        toolUseId: typeof typed.tool_use_id === "string" ? typed.tool_use_id : "",
        content:
          typeof inner === "string"
            ? [{ type: "text", text: inner }]
            : (userContent(inner) as JsonRecord[]),
        isError: typed.is_error === true,
      },
    ];
  });
}

/** The client's stop reasons in the Pi dialect's words; an unknown one passes through. */
function stopReasonOf(reason: string): string {
  if (reason === "end_turn") return "stop";
  if (reason === "tool_use") return "toolUse";
  if (reason === "max_tokens") return "length";
  return reason;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as JsonRecord).type === "text"
        ? String((part as JsonRecord).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function timeOf(entry: JsonRecord): number | null {
  const value = entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A served sidecar opens on one of its own records, never on a conversation line. */
function isSidecarLine(line: string): boolean {
  const first = parseLine(line);
  return first?.kind === "contract" || first?.kind === "served";
}

/** A file's first non-blank line, read only as far as it goes; null when unreadable. */
function firstLineAt(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let head = Buffer.alloc(0);
    for (let position = 0; ; ) {
      const chunk = Buffer.alloc(FIRST_LINE_CHUNK);
      const read = readSync(fd, chunk, 0, chunk.length, position);
      position += read;
      head = Buffer.concat([head, chunk.subarray(0, read)]);
      const text = head.toString("utf8");
      const line = firstLineOf(text);
      // The first line is whole once a newline follows it, or the file ends.
      if (read === 0 || (line && text.indexOf("\n", text.indexOf(line)) >= 0)) return line;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function firstLineOf(raw: string): string {
  for (const line of raw.split("\n", 64)) {
    if (line.trim()) return line;
  }
  return "";
}

function parseLine(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

/** Every complete JSON line; a torn line (a crash mid-append) is skipped. */
function parseLines(raw: string): JsonRecord[] {
  return raw.split("\n").flatMap((line) => {
    const entry = parseLine(line);
    return entry ? [entry] : [];
  });
}
