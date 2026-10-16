/**
 * The session JSONL footprint measurement (task-system P5, design section 5
 * and the captain's D2 note: "the sessions are very valuable. i think later
 * we would explore some scrubbing / pruning process that reduces the
 * storage need, but we shouldn't remove the entire session JSONL
 * altogether").
 *
 * Session JSONL is the one unbounded store by choice. This is the
 * measurement half of the retention story (`docs/task-retention.md` holds
 * the proposal): an OFFLINE, read-only walk of every session file the app
 * keeps - each crewmate's `crewmates/<taskId>/sessions/`, the Firstmate's
 * `firstmate/sessions/` and `firstmate/claude/` (copies and served sidecars),
 * and the supervision session's rolling dir - joined to the `tasks` table
 * (status, close time) and broken down by what each byte IS: a captain or
 * brief turn, assistant text, thinking, a tool call, a tool result, the
 * Claude client's copy of a tool result, an image, an attachment the client
 * added to a turn, framing. Pi's lines and the Claude client's are both
 * read. Those classes are what a scrubbing pass would decide over, so the
 * report says what such a pass could reclaim and what it must keep, per
 * task and in total.
 *
 * It DELETES NOTHING and rewrites nothing; it never prints transcript
 * content (counts and bytes only, plus task ids, keys and statuses). The
 * database is opened read-only, so it runs beside a live app or on an
 * exported userData alike.
 *
 * Run it (Node 24 strips the types):
 *   pnpm measure:sessions
 *   pnpm measure:sessions --user-data /path/to/userData --out footprint.json
 *   pnpm measure:sessions --older-than-days 30
 */

import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultUserDataDir } from "./extract-dispatch-corpus.ts";

// --------------------------------------------------------------------------
// Byte classes
// --------------------------------------------------------------------------

/**
 * Where a session file's bytes go. `turns` is what the D2 note keeps
 * (captain words, briefs, steers, assistant text: the conversation);
 * `toolResults`, `toolResultCopies`, `images` and `thinking` are what a
 * pass would weigh.
 */
export const BYTE_CLASSES = [
  /** User-role text: the brief, steers, the captain's words, [fm-op] wakes. */
  "userText",
  /** Assistant text: reports, answers, narration. */
  "assistantText",
  /** Assistant thinking blocks, their signatures included. */
  "thinking",
  /** Tool call names and arguments. */
  "toolCalls",
  /** Tool result text (file reads, command output, search hits). */
  "toolResults",
  /**
   * The Claude client's own copy of each tool result (`toolUseResult`),
   * written beside the one the model read: output, file contents, pictures.
   */
  "toolResultCopies",
  /** Image data (base64), in user turns and tool results alike. */
  "images",
  /**
   * What the Claude client attached to a turn besides the conversation: its
   * prompt and tool snapshots, reminders, listings, file snippets, and its
   * own injected (`isMeta`) lines.
   */
  "attachments",
  /** Compaction summaries Pi or the Claude client wrote. */
  "compaction",
  /** Session, model and thinking-level entries, ids, timestamps, usage, JSON framing. */
  "framing",
] as const;
export type ByteClass = (typeof BYTE_CLASSES)[number];
export type ByteBreakdown = Record<ByteClass, number>;

export function emptyBreakdown(): ByteBreakdown {
  return {
    userText: 0,
    assistantText: 0,
    thinking: 0,
    toolCalls: 0,
    toolResults: 0,
    toolResultCopies: 0,
    images: 0,
    attachments: 0,
    compaction: 0,
    framing: 0,
  };
}

function addBreakdown(into: ByteBreakdown, from: ByteBreakdown): void {
  for (const key of BYTE_CLASSES) into[key] += from[key];
}

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** A structured value's bytes as the line spells it: the JSON the writer wrote. */
const jsonBytesOf = (value: unknown): number => bytesOf(JSON.stringify(value) ?? "");

type JsonRecord = Record<string, unknown>;

const recordOf = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

function count(into: ByteBreakdown, key: ByteClass, bytes: number): number {
  into[key] += bytes;
  return bytes;
}

/**
 * A message's content in either writer's blocks: Pi's `text`, `thinking`,
 * `image` (`data`) and `toolCall`, and the Claude client's `text`,
 * `thinking`, `redacted_thinking`, `image` (`source.data`), `tool_use` and
 * `tool_result`, whose own content is tool result text and images.
 */
function contentBytes(content: unknown, into: ByteBreakdown, textClass: ByteClass): number {
  if (typeof content === "string") return count(into, textClass, bytesOf(content));
  if (!Array.isArray(content)) return 0;
  let counted = 0;
  for (const part of content) {
    const typed = recordOf(part);
    if (!typed) continue;
    if (typed.type === "text" && typeof typed.text === "string") {
      counted += count(into, textClass, bytesOf(typed.text));
    } else if (typed.type === "thinking") {
      // A signature is the thinking itself, sealed: a Claude model's arrives
      // with an empty `thinking` and everything in the signature.
      for (const key of ["thinking", "signature", "thinkingSignature"]) {
        const text = typed[key];
        if (typeof text === "string") counted += count(into, "thinking", bytesOf(text));
      }
    } else if (typed.type === "redacted_thinking" && typeof typed.data === "string") {
      counted += count(into, "thinking", bytesOf(typed.data));
    } else if (typed.type === "image") {
      const data = typeof typed.data === "string" ? typed.data : recordOf(typed.source)?.data;
      if (typeof data === "string") counted += count(into, "images", bytesOf(data));
    } else if (typed.type === "toolCall") {
      counted += count(
        into,
        "toolCalls",
        jsonBytesOf(typed.arguments ?? {}) + bytesOf(String(typed.name ?? "")),
      );
    } else if (typed.type === "tool_use" || typed.type === "server_tool_use") {
      counted += count(
        into,
        "toolCalls",
        jsonBytesOf(typed.input ?? {}) + bytesOf(String(typed.name ?? "")),
      );
    } else if (typed.type === "tool_result") {
      counted += contentBytes(typed.content, into, "toolResults");
    }
  }
  return counted;
}

/**
 * A Claude client line: its `user` and `assistant` messages, the client's
 * own copy of a tool result and of the tool inputs it sent beside them,
 * the attachments it adds to a turn, and its copies of a queued prompt.
 * A `queued_command` attachment is a steer the client folded into the
 * running turn and an `isMeta` user line is the client's own, as
 * `src/core/storage/sessionReader.ts` reads them.
 */
function claudeLineBytes(entry: JsonRecord, into: ByteBreakdown): number {
  let counted = 0;
  const message = recordOf(entry.message);
  if ((entry.type === "user" || entry.type === "assistant") && message) {
    const textClass: ByteClass =
      entry.type === "assistant"
        ? "assistantText"
        : entry.isCompactSummary === true
          ? "compaction"
          : entry.isMeta === true
            ? "attachments"
            : "userText";
    counted += contentBytes(message.content, into, textClass);
    if (entry.toolUseResult !== undefined) {
      counted += count(into, "toolResultCopies", jsonBytesOf(entry.toolUseResult));
    }
    if (entry.wireToolInputs !== undefined) {
      counted += count(into, "toolCalls", jsonBytesOf(entry.wireToolInputs));
    }
  } else if (entry.type === "attachment") {
    const attachment = recordOf(entry.attachment);
    const steer = attachment?.type === "queued_command";
    if (steer) counted += contentBytes(attachment.prompt, into, "userText");
    else if (attachment) counted += count(into, "attachments", jsonBytesOf(attachment));
    if (entry.rendered !== undefined) {
      counted += count(into, steer ? "userText" : "attachments", jsonBytesOf(entry.rendered));
    }
  } else if (entry.type === "queue-operation" && typeof entry.content === "string") {
    counted += count(into, "userText", bytesOf(entry.content));
  } else if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string") {
    counted += count(into, "userText", bytesOf(entry.lastPrompt));
  }
  return counted;
}

/** One session line's bytes, classified. Unparseable lines are framing. */
export function classifyLine(line: string): ByteBreakdown {
  const into = emptyBreakdown();
  const total = bytesOf(line);
  let entry: JsonRecord;
  try {
    entry = JSON.parse(line) as JsonRecord;
  } catch {
    into.framing = total;
    return into;
  }
  let counted = 0;
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    counted += count(into, "compaction", bytesOf(entry.summary));
  } else if (entry.type === "message" && recordOf(entry.message)) {
    const message = entry.message as JsonRecord;
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "user") counted += contentBytes(message.content, into, "userText");
    else if (role === "assistant") counted += contentBytes(message.content, into, "assistantText");
    else if (role === "toolResult") counted += contentBytes(message.content, into, "toolResults");
  } else {
    counted += claudeLineBytes(entry, into);
  }
  into.framing += Math.max(0, total - counted);
  return into;
}

// --------------------------------------------------------------------------
// Files and sessions
// --------------------------------------------------------------------------

export type FileFootprint = {
  path: string;
  bytes: number;
  lines: number;
  modifiedAt: number;
  classes: ByteBreakdown;
};

export function measureFile(path: string): FileFootprint {
  const raw = readFileSync(path, "utf8");
  const classes = emptyBreakdown();
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines += 1;
    addBreakdown(classes, classifyLine(line));
  }
  // Newlines are framing too.
  classes.framing += Math.max(0, bytesOf(raw) - BYTE_CLASSES.reduce((n, key) => n + classes[key], 0));
  return { path, bytes: bytesOf(raw), lines, modifiedAt: statSync(path).mtimeMs, classes };
}

function jsonlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

export type TaskRowLite = {
  id: string;
  key: string | null;
  status: string;
  closed_at: number | null;
};

/** The task rows the join needs, read-only; none when there is no database. */
export function readTaskRows(dbPath: string): Map<string, TaskRowLite> {
  const rows = new Map<string, TaskRowLite>();
  if (!existsSync(dbPath)) return rows;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("id")) return rows;
    const select = [
      "id",
      columns.has("key") ? "key" : "NULL AS key",
      "status",
      columns.has("closed_at") ? "closed_at" : "NULL AS closed_at",
    ].join(", ");
    for (const row of db.prepare(`SELECT ${select} FROM tasks`).all() as TaskRowLite[]) {
      rows.set(row.id, row);
    }
  } finally {
    db.close();
  }
  return rows;
}

export type CrewmateFootprint = {
  taskId: string;
  key: string | null;
  /** The record's status, or "unknown" when no row exists for the directory. */
  status: string;
  closedAt: number | null;
  /** Days since close at measurement time; null while not closed. */
  closedDays: number | null;
  files: number;
  bytes: number;
  lines: number;
  classes: ByteBreakdown;
};

export type FootprintTotals = {
  files: number;
  bytes: number;
  lines: number;
  classes: ByteBreakdown;
};

export type FootprintReport = {
  measuredAt: number;
  userData: string;
  /** Whether a database was found to join against. */
  database: boolean;
  totals: FootprintTotals;
  singletons: { firstmate: FootprintTotals; supervision: FootprintTotals };
  crewmates: CrewmateFootprint[];
  byStatus: Record<string, { tasks: number; bytes: number }>;
  /**
   * What the D2 note's pass would weigh: closed crewmate sessions older
   * than the window, their bytes, and the share that is tool results,
   * their copies, images and thinking (the drop candidates) versus turns
   * (kept).
   */
  candidates: {
    olderThanDays: number;
    tasks: number;
    bytes: number;
    droppable: { toolResults: number; toolResultCopies: number; images: number; thinking: number };
    kept: {
      userText: number;
      assistantText: number;
      toolCalls: number;
      attachments: number;
      framing: number;
    };
  };
};

function totalsOf(files: FileFootprint[]): FootprintTotals {
  const classes = emptyBreakdown();
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    addBreakdown(classes, file.classes);
    bytes += file.bytes;
    lines += file.lines;
  }
  return { files: files.length, bytes, lines, classes };
}

export type MeasureOptions = {
  userDataDir: string;
  /** The window for the candidate summary; the proposal's default is 30. */
  olderThanDays?: number;
  now?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function measureSessionFootprint(options: MeasureOptions): FootprintReport {
  const now = options.now ?? Date.now();
  const olderThanDays = options.olderThanDays ?? 30;
  const userData = resolve(options.userDataDir);
  const dbPath = join(userData, "firstmate.db");
  const tasks = readTaskRows(dbPath);

  const firstmate = totalsOf(
    ["sessions", "claude"].flatMap((dir) =>
      jsonlFilesIn(join(userData, "firstmate", dir)).map(measureFile),
    ),
  );
  const supervision = totalsOf(
    jsonlFilesIn(join(userData, "supervision", "sessions")).map(measureFile),
  );

  const crewmatesDir = join(userData, "crewmates");
  const crewmates: CrewmateFootprint[] = [];
  const dirs = existsSync(crewmatesDir)
    ? readdirSync(crewmatesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const taskId of dirs) {
    const files = jsonlFilesIn(join(crewmatesDir, taskId, "sessions")).map(measureFile);
    const totals = totalsOf(files);
    const row = tasks.get(taskId);
    const closedAt = row?.closed_at ?? null;
    crewmates.push({
      taskId,
      key: row?.key ?? null,
      status: row?.status ?? "unknown",
      closedAt,
      closedDays: closedAt === null ? null : Math.floor((now - closedAt) / DAY_MS),
      files: totals.files,
      bytes: totals.bytes,
      lines: totals.lines,
      classes: totals.classes,
    });
  }

  const byStatus: FootprintReport["byStatus"] = {};
  for (const crewmate of crewmates) {
    const entry = byStatus[crewmate.status] ?? { tasks: 0, bytes: 0 };
    entry.tasks += 1;
    entry.bytes += crewmate.bytes;
    byStatus[crewmate.status] = entry;
  }

  const candidates = crewmates.filter(
    (crewmate) => crewmate.closedDays !== null && crewmate.closedDays >= olderThanDays,
  );
  const candidateClasses = emptyBreakdown();
  for (const crewmate of candidates) addBreakdown(candidateClasses, crewmate.classes);

  const allClasses = emptyBreakdown();
  addBreakdown(allClasses, firstmate.classes);
  addBreakdown(allClasses, supervision.classes);
  for (const crewmate of crewmates) addBreakdown(allClasses, crewmate.classes);

  return {
    measuredAt: now,
    userData,
    database: tasks.size > 0 || existsSync(dbPath),
    totals: {
      files: firstmate.files + supervision.files + crewmates.reduce((n, c) => n + c.files, 0),
      bytes: firstmate.bytes + supervision.bytes + crewmates.reduce((n, c) => n + c.bytes, 0),
      lines: firstmate.lines + supervision.lines + crewmates.reduce((n, c) => n + c.lines, 0),
      classes: allClasses,
    },
    singletons: { firstmate, supervision },
    crewmates,
    byStatus,
    candidates: {
      olderThanDays,
      tasks: candidates.length,
      bytes: candidates.reduce((n, c) => n + c.bytes, 0),
      droppable: {
        toolResults: candidateClasses.toolResults,
        toolResultCopies: candidateClasses.toolResultCopies,
        images: candidateClasses.images,
        thinking: candidateClasses.thinking,
      },
      kept: {
        userText: candidateClasses.userText,
        assistantText: candidateClasses.assistantText,
        toolCalls: candidateClasses.toolCalls,
        attachments: candidateClasses.attachments,
        framing: candidateClasses.framing + candidateClasses.compaction,
      },
    },
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export type CliArgs = {
  userDataDir: string;
  out: string | null;
  olderThanDays: number;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { userDataDir: defaultUserDataDir(), out: null, olderThanDays: 30, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--user-data") args.userDataDir = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--older-than-days") {
      const days = Number.parseInt(next(), 10);
      if (!Number.isFinite(days) || days < 0) throw new Error("--older-than-days needs a whole number");
      args.olderThanDays = days;
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `measure-session-footprint: size and classify every session JSONL the app keeps (read-only)

  --user-data <dir>        the app's userData (default: this machine's)
  --out <file>             write the JSON report here
  --older-than-days <n>    the candidate window for closed crewmate sessions (default 30)
`;

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(0)}%` : "-";
}

export function summarize(report: FootprintReport): string {
  const { totals, candidates } = report;
  const lines = [
    `sessions under ${report.userData}${report.database ? "" : " (no database found; statuses unknown)"}`,
    `  ${totals.files} files, ${totals.lines} lines, ${human(totals.bytes)}`,
    `  firstmate ${human(report.singletons.firstmate.bytes)} · supervision ${human(report.singletons.supervision.bytes)} · crewmates ${human(report.crewmates.reduce((n, c) => n + c.bytes, 0))} across ${report.crewmates.length} tasks`,
    "  by class:",
    ...BYTE_CLASSES.map(
      (key) => `    ${key.padEnd(16)} ${human(totals.classes[key]).padStart(10)}  ${share(totals.classes[key], totals.bytes)}`,
    ),
    "  crewmates by status:",
    ...Object.entries(report.byStatus)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, entry]) => `    ${status.padEnd(10)} ${String(entry.tasks).padStart(5)} tasks  ${human(entry.bytes).padStart(10)}`),
    `  candidates (closed >= ${candidates.olderThanDays} days): ${candidates.tasks} tasks, ${human(candidates.bytes)}`,
    `    droppable: tool results ${human(candidates.droppable.toolResults)} · their copies ${human(candidates.droppable.toolResultCopies)} · images ${human(candidates.droppable.images)} · thinking ${human(candidates.droppable.thinking)}`,
    `    kept:      user text ${human(candidates.kept.userText)} · assistant text ${human(candidates.kept.assistantText)} · tool calls ${human(candidates.kept.toolCalls)} · attachments ${human(candidates.kept.attachments)} · framing ${human(candidates.kept.framing)}`,
    "  nothing was changed: this is a measurement (docs/task-retention.md).",
  ];
  return lines.join("\n");
}

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const report = measureSessionFootprint({
    userDataDir: args.userDataDir,
    olderThanDays: args.olderThanDays,
  });
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${args.out}`);
  }
  console.log(summarize(report));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
