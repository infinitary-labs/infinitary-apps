import {
  type KeptOutsideData,
  type OutsideDataDeleted,
  outsideDataDeletedNote,
} from "@shared/savedOutsideData";
import { type AppPaths, crewmateSessionsDir } from "../paths";
import {
  type LegacyCalls,
  type Scrubbed,
  scrubText,
  scrubValue,
} from "../storage/outsideDataScrub";
import type { TaskRecord } from "../storage/taskStore";
import {
  ClaudeFiles,
  conversationFiles,
  type DueKind,
  dueIn,
  dueRule,
  rewrite,
  sessionIdsIn,
  textFilesUnder,
} from "./outsideDataFiles";
import { FIRSTMATE_READER, type OutsideReads } from "./outsideReads";

/**
 * Words from outside, kept no longer than their kind declares (INF-952,
 * INF-1094; docs/task-retention.md, "Words from outside").
 *
 * The integrations fence what an agent reads from a kind that declares it
 * (`@shared/outsideData`) and note which conversation received it, and when
 * (`OutsideReads`). This pass puts a short note where those words were, in
 * the files that conversation is saved in - the session the app keeps, its
 * copy of a Claude session, and the Claude client's own transcript with the
 * outputs it saved beside it - and in the rules' runs that carried them.
 * Every file and every other line stays; the captain's D2 keeps sessions,
 * and their answer on INF-952 chose replacing a passage over removing one.
 * A crewmate's conversation on a computer that runs work is replaced there,
 * through that computer, with this Mac's copy of its record (`placed`).
 *
 * `sweep` replaces what is past its kind's days, reading only the
 * conversations the ledger names; `deleteNow` replaces everything read so
 * far in every conversation, words read before the fence existed included
 * (`LegacyCalls`). A conversation in a turn is never rewritten under its
 * writer: it is let go of first, between turns, and one still working, or
 * on a computer out of reach or not updated yet, is read again on a later
 * sweep.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What one placed task's visit came to (`SavedOutsideDataOptions.placed`):
 * its conversation there and this Mac's copy changed or held nothing due,
 * it is working, its computer is no longer on the list (`gone`, so this
 * Mac's copy is all there is), or it follows once its computer is back in
 * reach or updated.
 */
export type PlacedOutsideVisit =
  | "changed"
  | "unchanged"
  | "waiting"
  | "gone"
  | { computer: string; until: "reach" | "update" };

/** What is due in one pass, as data a computer that runs work can be sent. */
export type OutsideDue = { kinds: readonly DueKind[]; legacy: readonly LegacyCalls[] };

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
  /**
   * A task whose conversation a computer that runs work holds: what is due
   * goes there, by that computer, and from this Mac's copy of its record
   * (`PlacedSessions.deleteOutside`).
   */
  placed: (record: TaskRecord, due: OutsideDue) => Promise<PlacedOutsideVisit>;
  /** The rules' runs: their prompts and events, rewritten by their one writer. */
  runs: { rewrite: (scrub: (text: string, at: number) => Scrubbed<string>) => number };
  /** The first mate's messages no turn was handed yet, rewritten by their one writer. */
  inbox: { rewrite: (scrub: (payload: unknown) => Scrubbed<unknown>) => number };
  now: () => number;
  log: (line: string) => void;
};

/** A conversation that follows once its computer is back in reach, or updated. */
type Later = { computer: string; until: "reach" | "update" };

type Visit = "changed" | "unchanged" | "waiting" | "gone" | Later;

export class SavedOutsideData {
  private pass: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SavedOutsideDataOptions) {}

  /**
   * The captain's delete: everything read so far goes from every
   * conversation, now, or once a working one pauses or its computer is
   * back in reach or updated.
   */
  deleteNow(): Promise<OutsideDataDeleted> {
    return this.queue(async () => {
      this.options.reads.setDeleteBefore(this.options.now());
      const readers = [FIRSTMATE_READER, ...this.options.tasks().map((task) => task.id)];
      const visits = await this.visitAll(readers, { full: true });
      const later = new Map<string, Later & { conversations: number }>();
      for (const visit of visits) {
        if (typeof visit !== "object") continue;
        const key = `${visit.until}:${visit.computer}`;
        const counted = later.get(key) ?? { ...visit, conversations: 0 };
        counted.conversations += 1;
        later.set(key, counted);
      }
      return {
        conversations: visits.filter((visit) => visit === "changed").length,
        waiting: visits.filter((visit) => visit === "waiting").length,
        ...(later.size > 0 ? { elsewhere: [...later.values()] } : {}),
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
    const cutoffs = this.cutoffs();
    const cutoff = this.cutoff();
    if (cutoff === undefined) return [];
    const due: OutsideDue = {
      kinds: this.options.kept().map((kind) => ({
        label: kind.label,
        until: cutoffs.get(kind.label) ?? Number.NEGATIVE_INFINITY,
        note: outsideDataDeletedNote(kind.what),
      })),
      legacy: this.options.legacy(),
    };
    const claude = new ClaudeFiles(this.options.claudeConfigDir(), mode.full);
    const visits: Visit[] = [];
    for (const reader of readers) {
      let visit: Visit;
      try {
        visit = await this.visit(reader, due, claude, mode.full, cutoff);
      } catch (error) {
        this.options.log(
          `[outside-data] ${reader}: ${error instanceof Error ? error.message : String(error)}`,
        );
        visit = "waiting";
      }
      if (visit === "changed" || visit === "unchanged") this.options.reads.settle(reader, cutoff);
      else if (visit === "gone") this.options.reads.forget(reader);
      // A conversation still working, one this pass could not finish, and
      // one whose computer it could not ask are read again, whole, on the next sweep.
      else this.options.reads.retry(reader);
      visits.push(visit);
    }
    return visits;
  }

  private async visit(
    reader: string,
    due: OutsideDue,
    claude: ClaudeFiles,
    full: boolean,
    cutoff: number,
  ): Promise<Visit> {
    const rule = dueRule(due.kinds);
    const legacy = due.legacy;
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
      if (record.deviceId) {
        // Its conversation is on the computer that runs it: that computer replaces it there.
        const there = await this.options.placed(record, due);
        if (there !== "gone") return there;
        // That computer is no longer on the list, so this Mac's copy is all that is left.
      }
      files = conversationFiles(
        {
          dir: crewmateSessionsDir(this.options.paths, record.id),
          ...(record.sessionFile ? { token: record.sessionFile } : {}),
          cwd: record.worktreeDir,
        },
        claude,
      );
    }
    if (this.options.conversations.busy(reader)) return "waiting";
    const since = full ? undefined : this.options.reads.earliestDue(reader, cutoff);
    const dueFiles: string[] = [];
    for (const file of files) {
      const found = await dueIn(file, rule, legacy, since);
      if (found) dueFiles.push(file);
    }
    let changed = records;
    if (dueFiles.length > 0) {
      if (!(await this.options.conversations.release(reader))) return "waiting";
      // From here to the last rename nothing yields, so no turn opens these files between them.
      if (this.options.conversations.held(reader)) return "waiting";
      for (const file of dueFiles) changed += rewrite(file, rule, legacy);
    }
    return changed ? "changed" : "unchanged";
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
