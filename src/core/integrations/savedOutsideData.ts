import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  type KeptOutsideData,
  type OutsideDataDeleted,
  outsideDataDeletedNote,
} from "@shared/savedOutsideData";
import { encodeClaudeProjectDir, locateClaudeTranscript } from "../claude/claudeTranscript";
import { type AppPaths, crewmateSessionsDir } from "../paths";
import {
  type LegacyCalls,
  type Scrubbed,
  type ScrubRule,
  scrubJsonLines,
  scrubText,
  scrubValue,
} from "../storage/outsideDataScrub";
import type { TaskRecord } from "../storage/taskStore";
import { FIRSTMATE_READER, type OutsideReads } from "./outsideReads";

/**
 * Words from outside, kept no longer than their kind declares (INF-952;
 * docs/task-retention.md, "Words from outside").
 *
 * The integrations fence what an agent reads from a kind that declares it
 * (`@shared/outsideData`) and note which conversation received it, and when
 * (`OutsideReads`). This pass puts a short note where those words were, in
 * the files that conversation is saved in - the session the app keeps, its
 * copy of a Claude session, and the Claude client's own transcript with the
 * outputs it saved beside it - and in the rules' runs that carried them.
 * Every file and every other line stays; the captain's D2 keeps sessions,
 * and their answer on INF-952 chose replacing a passage over removing one.
 *
 * `sweep` replaces what is past its kind's days, reading only the
 * conversations the ledger names; `deleteNow` replaces everything read so
 * far in every conversation on this computer, words read before the fence
 * existed included (`LegacyCalls`). A conversation in a turn is never
 * rewritten under its writer: it is let go of first, between turns, and
 * one still working is read again on a later sweep.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The text files a saved conversation is kept in; anything else (a picture) has no words to find. */
const TEXT_FILES = new Set([".jsonl", ".json", ".txt", ".md", ".log"]);

/** The Claude client's session id, as the app's copies are named (`SessionRecordStore`). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** What every fenced span or fetched answer starts with, read as bytes before any file is decoded. */
const FENCE_HINT = Buffer.from("[[");
const LEGACY_HINTS = [Buffer.from("use_integration"), Buffer.from("infinitary-integrations-axi")];

export type SavedOutsideDataOptions = {
  paths: AppPaths;
  reads: OutsideReads;
  task: (taskId: string) => TaskRecord | undefined;
  tasks: () => readonly TaskRecord[];
  /** Each fenced kind and how long its words stay (`IntegrationBinding.kept`). */
  kept: () => readonly KeptOutsideData[];
  /** The names an unfenced call reached each kind by. */
  legacy: () => readonly LegacyCalls[];
  /** Where the Claude client keeps its transcripts (`~/.claude`). */
  claudeConfigDir: () => string;
  /** The first mate's Claude session ids, the current one before its first copy included. */
  firstmateClaudeSessions: () => readonly string[];
  /** The live conversations' owners: the supervisor's crewmates and the first mate. */
  conversations: {
    /** In a turn, or opening: its files are left for a later sweep, unread. */
    busy: (reader: string) => boolean;
    /** Let go of it between turns, so its next turn opens it from its files; false when it could not. */
    release: (reader: string) => Promise<boolean>;
    /** A live conversation holds its files now. */
    held: (reader: string) => boolean;
  };
  /** The rules' runs: their prompts and events, rewritten by their one writer. */
  runs: { rewrite: (scrub: (text: string, at: number) => Scrubbed<string>) => number };
  /** The first mate's messages no turn was handed yet, rewritten by their one writer. */
  inbox: { rewrite: (scrub: (payload: unknown) => Scrubbed<unknown>) => number };
  now: () => number;
  log: (line: string) => void;
};

type Visit = "changed" | "unchanged" | "waiting" | "elsewhere" | "gone";

export class SavedOutsideData {
  private pass: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SavedOutsideDataOptions) {}

  /**
   * The captain's delete: everything read so far goes from every
   * conversation on this computer, now, or once a working one pauses.
   */
  deleteNow(): Promise<OutsideDataDeleted> {
    return this.queue(async () => {
      this.options.reads.setDeleteBefore(this.options.now());
      const readers = [FIRSTMATE_READER, ...this.options.tasks().map((task) => task.id)];
      const visits = await this.visitAll(readers, { full: true });
      return {
        conversations: visits.filter((visit) => visit === "changed").length,
        waiting: visits.filter((visit) => visit === "waiting").length,
      };
    });
  }

  /** The conversations whose words are now past their days, or before the captain's delete. */
  sweep(): Promise<void> {
    return this.queue(async () => {
      const cutoff = this.cutoff();
      if (cutoff === undefined) return;
      const readers = this.options.reads.due(cutoff);
      if (readers.length) await this.visitAll(readers, { full: false });
    });
  }

  /** One pass at a time: a delete waits for a sweep under way, and the other way round. */
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pass.then(run, run);
    this.pass = next.catch(() => {});
    return next;
  }

  /** The moment before which every kept kind's words are due; the longest-kept kind decides. */
  private cutoff(): number | undefined {
    const cutoffs = [...this.cutoffs().values()];
    return cutoffs.length ? Math.min(...cutoffs) : undefined;
  }

  private cutoffs(): Map<string, number> {
    const now = this.options.now();
    const asked = this.options.reads.deleteBefore() ?? Number.NEGATIVE_INFINITY;
    return new Map(
      this.options.kept().map((kind) => [kind.label, Math.max(now - kind.days * DAY_MS, asked)]),
    );
  }

  private async visitAll(readers: readonly string[], mode: { full: boolean }): Promise<Visit[]> {
    const kept = this.options.kept();
    const cutoffs = this.cutoffs();
    const cutoff = this.cutoff();
    if (cutoff === undefined) return [];
    const rule: ScrubRule = {
      due: (label, at) => {
        const until = cutoffs.get(label);
        return until !== undefined && at <= until;
      },
      note: (label) =>
        outsideDataDeletedNote(kept.find((kind) => kind.label === label)?.what ?? label),
    };
    const legacy = this.options.legacy();
    const claude = new ClaudeFiles(this.options.claudeConfigDir(), mode.full);
    const visits: Visit[] = [];
    for (const reader of readers) {
      let visit: Visit;
      try {
        visit = await this.visit(reader, rule, legacy, claude, mode.full, cutoff);
      } catch (error) {
        this.options.log(
          `[outside-data] ${reader}: ${error instanceof Error ? error.message : String(error)}`,
        );
        visit = "waiting";
      }
      if (visit === "changed" || visit === "unchanged") this.options.reads.settle(reader, cutoff);
      else if (visit === "gone" || visit === "elsewhere") this.options.reads.forget(reader);
      // A conversation still working, or one this pass could not finish, is read again,
      // whole, on the next sweep.
      else if (visit === "waiting") this.options.reads.retry(reader);
      visits.push(visit);
    }
    return visits;
  }

  private async visit(
    reader: string,
    rule: ScrubRule,
    legacy: readonly LegacyCalls[],
    claude: ClaudeFiles,
    full: boolean,
    cutoff: number,
  ): Promise<Visit> {
    let records = 0;
    let files: string[];
    if (reader === FIRSTMATE_READER) {
      // A rule's events reach the first mate: its runs, and its messages still waiting.
      const at = this.options.now();
      records += this.options.runs.rewrite((text, firedAt) => scrubText(text, rule, firedAt));
      records += this.options.inbox.rewrite((payload) => scrubValue(payload, rule, at));
      files = this.firstmateFiles(claude);
    } else {
      const record = this.options.task(reader);
      if (!record) return "gone";
      // A task on another computer keeps its conversation there.
      if (record.deviceId) return "elsewhere";
      files = this.taskFiles(record, claude);
    }
    if (this.options.conversations.busy(reader)) return "waiting";
    const since = full ? undefined : this.options.reads.earliestDue(reader, cutoff);
    const due: string[] = [];
    for (const file of files) {
      const found = await dueIn(file, rule, legacy, since);
      if (found) due.push(file);
    }
    let changed = records;
    if (due.length > 0) {
      if (!(await this.options.conversations.release(reader))) return "waiting";
      // From here to the last rename nothing yields, so no turn opens these files between them.
      if (this.options.conversations.held(reader)) return "waiting";
      for (const file of due) changed += rewrite(file, rule, legacy);
    }
    return changed ? "changed" : "unchanged";
  }

  /** A crewmate's saved conversation: its record folder, and the Claude client's own files for it. */
  private taskFiles(record: TaskRecord, claude: ClaudeFiles): string[] {
    const dir = crewmateSessionsDir(this.options.paths, record.id);
    const files = textFilesUnder(dir);
    const token = record.sessionFile;
    if (token?.endsWith(".jsonl") && !files.includes(token) && isFile(token)) files.push(token);
    const ids = new Set(sessionIdsIn(dir));
    if (token && SESSION_ID.test(token)) ids.add(token);
    for (const id of ids) files.push(...claude.filesOf(id, record.worktreeDir));
    return files;
  }

  /** The first mate's sessions, its Claude copies, and the Claude client's own files for them. */
  private firstmateFiles(claude: ClaudeFiles): string[] {
    const { firstmateSessionsDir, firstmateClaudeDir, supervisionSessionsDir, firstmateHomeDir } =
      this.options.paths;
    const files = [
      ...textFilesUnder(firstmateSessionsDir),
      ...textFilesUnder(firstmateClaudeDir),
      ...textFilesUnder(supervisionSessionsDir),
    ];
    const ids = new Set([
      ...sessionIdsIn(firstmateClaudeDir),
      ...this.options.firstmateClaudeSessions(),
    ]);
    for (const id of ids) files.push(...claude.filesOf(id, firstmateHomeDir));
    return files;
  }
}

/**
 * Where the Claude client keeps a session: its transcript, and the folder
 * beside it with the outputs too long for the transcript and its helpers'
 * own transcripts. A full pass lists the client's folders once rather than
 * searching them for each session.
 */
class ClaudeFiles {
  private index: Map<string, string> | undefined;

  constructor(
    private readonly configDir: string,
    private readonly listAll: boolean,
  ) {}

  filesOf(sessionId: string, cwd: string): string[] {
    const transcript = this.locate(sessionId, cwd);
    if (!transcript) return [];
    return [transcript, ...textFilesUnder(join(dirname(transcript), sessionId))];
  }

  private locate(sessionId: string, cwd: string): string | null {
    if (!this.listAll) return locateClaudeTranscript({ configDir: this.configDir, cwd, sessionId });
    const direct = join(
      this.configDir,
      "projects",
      encodeClaudeProjectDir(cwd),
      `${sessionId}.jsonl`,
    );
    if (isFile(direct)) return direct;
    this.index ??= this.list();
    return this.index.get(sessionId) ?? null;
  }

  private list(): Map<string, string> {
    const index = new Map<string, string>();
    const projects = join(this.configDir, "projects");
    for (const dir of entriesOf(projects)) {
      for (const name of entriesOf(join(projects, dir))) {
        if (name.endsWith(".jsonl"))
          index.set(name.slice(0, -".jsonl".length), join(projects, dir, name));
      }
    }
    return index;
  }
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Every text file under a folder, never following a link. */
function textFilesUnder(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of entriesOf(at)) {
      const path = join(at, name);
      let kind: ReturnType<typeof lstatSync>;
      try {
        kind = lstatSync(path);
      } catch {
        continue;
      }
      if (kind.isDirectory()) walk(path);
      else if (kind.isFile() && TEXT_FILES.has(extname(name))) files.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/** The Claude session ids the app holds copies of in a record folder. */
function sessionIdsIn(dir: string): string[] {
  return entriesOf(dir)
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".served.jsonl"))
    .map((name) => basename(name, ".jsonl"))
    .filter((id) => SESSION_ID.test(id) && !id.includes("_"));
}

/** A file's words with what is due replaced, by what kind of file it is. */
function scrubFile(
  file: string,
  content: string,
  rule: ScrubRule,
  legacy: readonly LegacyCalls[],
  at: number,
): Scrubbed<string> {
  const kind = extname(file);
  if (kind === ".jsonl") return scrubJsonLines(content, rule, { at, legacy });
  if (kind === ".json") {
    try {
      const done = scrubValue(JSON.parse(content), rule, at);
      return done.replaced
        ? { value: JSON.stringify(done.value), replaced: done.replaced }
        : { value: content, replaced: 0 };
    } catch {
      // Not JSON after all: its text, as written.
    }
  }
  return scrubText(content, rule, at);
}

/** Whether a file holds anything due, reading it without changing it. */
async function dueIn(
  file: string,
  rule: ScrubRule,
  legacy: readonly LegacyCalls[],
  since: number | undefined,
): Promise<boolean> {
  let facts: Awaited<ReturnType<typeof stat>>;
  try {
    facts = await stat(file);
  } catch {
    return false;
  }
  if (since !== undefined && facts.mtimeMs < since) return false;
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return false;
  }
  const hinted =
    bytes.includes(FENCE_HINT) ||
    (legacy.length > 0 && LEGACY_HINTS.some((hint) => bytes.includes(hint)));
  if (!hinted) return false;
  return scrubFile(file, bytes.toString("utf8"), rule, legacy, facts.mtimeMs).replaced > 0;
}

/**
 * Write a file again with what is due replaced: read, replaced and renamed
 * into place in one go, keeping its mode. Answers how many it replaced.
 */
function rewrite(file: string, rule: ScrubRule, legacy: readonly LegacyCalls[]): number {
  let facts: ReturnType<typeof statSync>;
  let content: string;
  try {
    facts = statSync(file);
    content = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const done = scrubFile(file, content, rule, legacy, facts.mtimeMs);
  if (done.replaced === 0) return 0;
  const temp = `${file}.${process.pid}.outside`;
  writeFileSync(temp, done.value, { mode: facts.mode & 0o777 });
  renameSync(temp, file);
  return done.replaced;
}
