import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Where fenced words from outside went, and when (INF-952;
 * docs/task-retention.md, "Words from outside"): for each conversation that
 * received some - a task's, or the first mate's - the hours in which it did.
 * The pass that replaces due words reads only those conversations, once an
 * hour's words are all due, so it never walks every saved session to find
 * them. It holds no words, only who and when, the files from outside saved
 * into a task's hand-over folder (by kept name, kind and time), and the
 * captain's last request to delete everything read before it.
 *
 * One file, `userData/integrations/outside-reads.json`, 0600 in a 0700
 * folder, written whole. An unreadable file reads as empty: what it named
 * still goes when the captain deletes everything.
 */

const FILE = "outside-reads.json";

/** One hour, the grain the ledger counts in: words go at most this long after they are due. */
export const READ_HOUR_MS = 60 * 60 * 1000;

/** The first mate's conversation; every other key is a task's id. */
export const FIRSTMATE_READER = "firstmate";

const fileSchema = z.object({
  /** The captain's last delete: everything read before it is due. */
  deleteBefore: z.number().nullable(),
  /** Each conversation's hours (`at / READ_HOUR_MS`, floored) that hold words not yet replaced. */
  hours: z.record(z.string().min(1).max(64), z.array(z.number().int().nonnegative())),
  /** Each task's files from outside in its hand-over folder: kept name, its kind's label, and when. */
  files: z
    .record(
      z.string().min(1).max(64),
      z.array(z.object({ file: z.string().min(1).max(255), label: z.string(), at: z.number() })),
    )
    .default({}),
});

/** One file from outside a task's hand-over folder holds (`OutsideReads.saved`). */
export type OutsideFile = { file: string; label: string; at: number };
type LedgerFile = z.infer<typeof fileSchema>;

export class OutsideReads {
  private state: LedgerFile;

  constructor(private readonly root: string) {
    this.state = this.read();
  }

  /** Words reached a conversation at `at`. */
  note(reader: string, at: number): void {
    const hour = Math.floor(at / READ_HOUR_MS);
    const hours = this.state.hours[reader] ?? [];
    if (hours.includes(hour)) return;
    this.state.hours[reader] = [...hours, hour].sort((a, b) => a - b);
    this.write();
  }

  /**
   * A pass could not finish this conversation (it was working): the next
   * sweep reads it again, every file of it, whatever their age.
   */
  retry(reader: string): void {
    this.note(reader, 0);
  }

  /** A file from outside was saved into a task's hand-over folder at `at`. */
  saved(reader: string, file: string, label: string, at: number): void {
    const files = (this.state.files[reader] ?? []).filter((entry) => entry.file !== file);
    this.state.files[reader] = [...files, { file, label, at }];
    this.write();
  }

  filesOf(reader: string): readonly OutsideFile[] {
    return this.state.files[reader] ?? [];
  }

  /** These files are gone from the task's hand-over folder. */
  removed(reader: string, files: readonly string[]): void {
    const kept = this.state.files[reader];
    if (!kept || files.length === 0) return;
    const left = kept.filter((entry) => !files.includes(entry.file));
    if (left.length) this.state.files[reader] = left;
    else delete this.state.files[reader];
    this.write();
  }

  /** Every conversation holding an hour whose words were all read by `cutoff`, or a file saved before it. */
  due(cutoff: number): string[] {
    const readers = new Set(
      Object.entries(this.state.hours)
        .filter(([, hours]) => hours.some((hour) => (hour + 1) * READ_HOUR_MS <= cutoff))
        .map(([reader]) => reader),
    );
    for (const [reader, files] of Object.entries(this.state.files))
      if (files.some((entry) => entry.at <= cutoff)) readers.add(reader);
    return [...readers];
  }

  /** The earliest moment in a conversation's due hours, so a pass reads only files written since. */
  earliestDue(reader: string, cutoff: number): number | undefined {
    const hour = this.state.hours[reader]?.find((entry) => (entry + 1) * READ_HOUR_MS <= cutoff);
    return hour === undefined ? undefined : hour * READ_HOUR_MS;
  }

  /** A pass replaced everything read by `cutoff` in this conversation. */
  settle(reader: string, cutoff: number): void {
    const hours = this.state.hours[reader];
    if (!hours) return;
    const left = hours.filter((hour) => (hour + 1) * READ_HOUR_MS > cutoff);
    if (left.length === hours.length) return;
    if (left.length) this.state.hours[reader] = left;
    else delete this.state.hours[reader];
    this.write();
  }

  /** A conversation that no longer exists. */
  forget(reader: string): void {
    if (!(reader in this.state.hours) && !(reader in this.state.files)) return;
    delete this.state.hours[reader];
    delete this.state.files[reader];
    this.write();
  }

  deleteBefore(): number | null {
    return this.state.deleteBefore;
  }

  /** The captain asked to delete everything read before `at`. */
  setDeleteBefore(at: number): void {
    this.state.deleteBefore = Math.max(at, this.state.deleteBefore ?? 0);
    this.write();
  }

  private read(): LedgerFile {
    try {
      return fileSchema.parse(JSON.parse(readFileSync(join(this.root, FILE), "utf8")));
    } catch {
      return { deleteBefore: null, hours: {}, files: {} };
    }
  }

  /** Write whole, never readable by anyone else even mid-write. */
  private write(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
