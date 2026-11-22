import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  STANDBY_APPLY_ORDER,
  STANDBY_DROP_ORDER,
  STANDBY_FULL_ORDER,
  STANDBY_HELLO_ORDER,
  STANDBY_HOME_ORDER,
  STANDBY_LACKS_ORDER,
  STANDBY_LOCK_ORDER,
  STANDBY_PIECE_ORDER,
  type StandbyChange,
  type StandbyFile,
  type StandbyHello,
  type StandbyHome,
  type StandbyOrderChannel,
  standbyHomeSchema,
  standbyOrders,
} from "@shared/standby";
import { z } from "zod";
import { writePrivate } from "../devices/identity";
import { hashFile } from "../homeMove/record";
import { CopyAccess } from "./copyAccess";

/** The folder in the work folder where a computer keeps its copy of the first mate's record. */
export const STANDBY_DIR = "standby";
/** The copy itself, laid out as the record is in the home's data folder. */
export const STANDBY_COPY = "copy";
const STATE_FILE = "state.json";
/** What taking over needs beside the record, as the home last said it (`inf:standby:home`). */
const HOME_FILE = "home.json";
/** An apply in flight, written before any file of the copy changes, so a restart finishes it. */
const REDO_FILE = "redo.json";
/** A full copy whose last part came, before it is swapped in. */
const FULL_FILE = "full.json";
const BLOBS = "blobs";
const INCOMING = "incoming";
const OLD_COPY = "copy-old";

const stateSchema = z.object({
  version: z.literal(1),
  stream: z.string().uuid().nullable(),
  seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative().nullable(),
});
type State = z.infer<typeof stateSchema>;

const NO_COPY: State = { version: 1, stream: null, seq: 0, at: null };

/** Where the copy kept in `workDir` stands, for this computer's own status. */
export function readStandbyState(workDir: string): {
  stream: string | null;
  seq: number;
  at: number | null;
} {
  const file = join(workDir, STANDBY_DIR, STATE_FILE);
  try {
    const state = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return { stream: state.stream, seq: state.seq, at: state.at };
  } catch {
    return { stream: null, seq: 0, at: null };
  }
}

/**
 * What taking over needs beside the record, as the home last told this
 * computer, or null when it never did (a home from before) or it is unread.
 */
export function readStandbyHome(workDir: string): StandbyHome | null {
  try {
    return standbyHomeSchema.parse(
      JSON.parse(readFileSync(join(workDir, STANDBY_DIR, HOME_FILE), "utf8")),
    );
  } catch {
    return null;
  }
}

export type StandbyKeeperOptions = {
  /** The work folder; the copy is kept in `standby/` inside it, never in the app's data folder. */
  workDir: string;
  /** Where a first mate here would answer should it take over, told to the home in each hello. */
  addresses?: () => string[];
  log: (line: string) => void;
  /**
   * Where this computer listens for the other copies, which its hello tells
   * the home (`./peers.ts`); asked at each hello, so it listens from the
   * moment the home asks. Absent, the hello says nothing of it.
   */
  listens?: () => Promise<readonly string[]>;
  /** Told once the copy changed, or went with the home's drop. */
  onCopy?: (what: "changed" | "dropped") => void;
  /**
   * Who else opens the copy's files on this computer (`./copyAccess.ts`):
   * each order waits until their reads closed, since Windows refuses to
   * rename or remove what another reader holds open. Its own when absent.
   */
  access?: CopyAccess;
};

type ApplyOrder = {
  stream: string;
  from: number;
  through: number;
  at: number;
  changes: StandbyChange[];
};

/** A change the copy cannot take as it is: the copy is dropped and the home sends a full one. */
class Refused extends Error {}

/**
 * A computer that keeps a copy of the first mate's record (docs/devices.md,
 * "Keeping a copy on another computer"). It holds the copy in its work
 * folder and only ever writes it: nothing here opens it as a first mate.
 * Each change is applied whole - written first to `redo.json`, so a restart
 * finishes it - and a full copy is built beside the copy and swapped in at
 * once, so the copy on disk is always as of one change of the home's.
 */
export class StandbyKeeper {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  /** Each copy file's hash, by its size and time, so a full copy does not read it twice. */
  private readonly hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  /** The files of a full copy named so far, by its stream. */
  private incoming: { stream: string; part: number } | null = null;
  private readonly access: CopyAccess;

  constructor(private readonly options: StandbyKeeperOptions) {
    this.dir = join(options.workDir, STANDBY_DIR);
    this.access = options.access ?? new CopyAccess();
    this.recover();
  }

  answer(channel: StandbyOrderChannel, args: unknown): Promise<unknown> {
    switch (channel) {
      case STANDBY_HELLO_ORDER:
        standbyOrders[STANDBY_HELLO_ORDER].request.parse(args);
        return this.inTurn(() => this.hello());
      case STANDBY_PIECE_ORDER:
        return this.inTurn(async () =>
          this.piece(standbyOrders[STANDBY_PIECE_ORDER].request.parse(args)[0]),
        );
      case STANDBY_LACKS_ORDER:
        return this.inTurn(() =>
          this.lacks(standbyOrders[STANDBY_LACKS_ORDER].request.parse(args)[0].files),
        );
      case STANDBY_FULL_ORDER:
        return this.inTurn(async () => {
          const done = await this.full(standbyOrders[STANDBY_FULL_ORDER].request.parse(args)[0]);
          if (done.swapped) this.tell("changed");
          return { ok: done.ok };
        });
      case STANDBY_APPLY_ORDER:
        return this.inTurn(async () => {
          const applied = this.apply(standbyOrders[STANDBY_APPLY_ORDER].request.parse(args)[0]);
          if (applied.ok) this.tell("changed");
          return applied;
        });
      case STANDBY_HOME_ORDER: {
        const [home] = standbyOrders[STANDBY_HOME_ORDER].request.parse(args);
        return this.inTurn(async () => {
          mkdirSync(this.dir, { recursive: true, mode: 0o700 });
          writePrivate(this.at(HOME_FILE), `${JSON.stringify(home)}\n`);
          return { ok: true };
        });
      }
      case STANDBY_DROP_ORDER:
        standbyOrders[STANDBY_DROP_ORDER].request.parse(args);
        return this.inTurn(async () => {
          const had = existsSync(this.dir);
          rmSync(this.dir, { recursive: true, force: true });
          this.hashes.clear();
          this.incoming = null;
          this.tell("dropped");
          return { dropped: had };
        });
      case STANDBY_LOCK_ORDER:
        // The computer's lock is not the copy's: `StandbyLockKeeper` answers it.
        return Promise.reject(new Error("The copy does not keep the lock."));
    }
  }

  /** What the copy did, told to whoever listens for the other copies; never the order's failure. */
  private tell(what: "changed" | "dropped"): void {
    try {
      this.options.onCopy?.(what);
    } catch (error) {
      this.options.log(`could not tell that the copy changed: ${String(error)}`);
    }
  }

  /** One order at a time, in the order they came, each once no other reader holds the copy open. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const held = () => this.access.write(work);
    const next = this.queue.then(held, held);
    this.queue = next.catch(() => {});
    return next;
  }

  private at(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  private copyPath(path: string): string {
    return join(this.dir, STANDBY_COPY, ...path.split("/"));
  }

  private state(): State {
    try {
      return stateSchema.parse(JSON.parse(readFileSync(this.at(STATE_FILE), "utf8")));
    } catch {
      return NO_COPY;
    }
  }

  private writeState(state: State): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivate(this.at(STATE_FILE), `${JSON.stringify(state)}\n`);
  }

  private async hello(): Promise<StandbyHello> {
    const state = this.state();
    let listens: readonly string[] = [];
    try {
      listens = (await this.options.listens?.()) ?? [];
    } catch (error) {
      this.options.log(`could not listen for the other copies: ${String(error)}`);
    }
    const addresses = this.options.addresses?.().slice(0, 9) ?? [];
    return {
      stream: state.stream,
      seq: state.seq,
      at: state.at,
      ...(this.options.listens ? { listens: [...listens] } : {}),
      ...(addresses.length ? { addresses } : {}),
    };
  }

  /** What a restart finds half done: a full copy swapped part way, or an apply. */
  private recover(): void {
    try {
      const fullFile = this.at(FULL_FILE);
      if (existsSync(fullFile)) {
        const marked = stateSchema.parse(JSON.parse(readFileSync(fullFile, "utf8")));
        this.swapIn(marked);
      }
      const redoFile = this.at(REDO_FILE);
      if (existsSync(redoFile)) {
        const redo = standbyOrders[STANDBY_APPLY_ORDER].request.parse([
          JSON.parse(readFileSync(redoFile, "utf8")),
        ])[0];
        const state = this.state();
        // Only an apply from where the copy stands is finished; any other is stale.
        if (state.stream === redo.stream && state.seq === redo.from) this.applyWhole(redo);
        else rmSync(redoFile, { force: true });
      }
    } catch (error) {
      this.options.log(`the copy could not be recovered and is dropped: ${String(error)}`);
      this.dropCopy();
    }
  }

  private dropCopy(): void {
    rmSync(this.at(REDO_FILE), { force: true });
    rmSync(this.at(FULL_FILE), { force: true });
    this.writeState(NO_COPY);
  }

  private piece(order: { sha256: string; size: number; offset: number; data: string }): {
    complete: boolean;
  } {
    const blobs = this.at(BLOBS);
    const done = join(blobs, order.sha256);
    if (existsSync(done)) return { complete: true };
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    const part = `${done}.part`;
    const data = Buffer.from(order.data, "base64");
    if (order.offset + data.length > order.size) throw new Error("A piece runs past its blob.");
    const fd = openSync(part, existsSync(part) ? "r+" : "w+", 0o600);
    try {
      writeSync(fd, data, 0, data.length, order.offset);
      if (order.offset + data.length < order.size) return { complete: false };
      ftruncateSync(fd, order.size);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const sha256 = createHash("sha256").update(readFileSync(part)).digest("hex");
    if (sha256 !== order.sha256) {
      rmSync(part, { force: true });
      throw new Error("A blob arrived unlike its hash and is asked again.");
    }
    renameSync(part, done);
    return { complete: true };
  }

  private async hashOf(abs: string): Promise<string | null> {
    let facts: ReturnType<typeof statSync>;
    try {
      facts = statSync(abs);
    } catch {
      return null;
    }
    const known = this.hashes.get(abs);
    if (known && known.size === facts.size && known.mtimeMs === facts.mtimeMs) return known.sha256;
    const sha256 = await hashFile(abs);
    this.hashes.set(abs, { size: facts.size, mtimeMs: facts.mtimeMs, sha256 });
    return sha256;
  }

  private async lacks(files: StandbyFile[]): Promise<{ lacks: number[] }> {
    const lacks: number[] = [];
    for (const [index, file] of files.entries()) {
      if (existsSync(join(this.at(BLOBS), file.sha256))) continue;
      if ((await this.hashOf(this.copyPath(file.path))) === file.sha256) continue;
      lacks.push(index);
    }
    return { lacks };
  }

  private async full(order: {
    stream: string;
    seq: number;
    at: number;
    part: number;
    last: boolean;
    files: StandbyFile[];
  }): Promise<{ ok: boolean; swapped?: true }> {
    const incoming = this.at(INCOMING);
    if (order.part === 0) {
      rmSync(incoming, { recursive: true, force: true });
      mkdirSync(incoming, { recursive: true, mode: 0o700 });
      this.incoming = { stream: order.stream, part: 0 };
    } else if (
      !this.incoming ||
      this.incoming.stream !== order.stream ||
      this.incoming.part !== order.part - 1
    )
      return { ok: false };
    this.incoming.part = order.part;
    for (const file of order.files) {
      const to = join(incoming, ...file.path.split("/"));
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      const blob = join(this.at(BLOBS), file.sha256);
      if (existsSync(blob)) {
        copyFileSync(blob, to, constants.COPYFILE_FICLONE);
        continue;
      }
      const there = this.copyPath(file.path);
      if ((await this.hashOf(there)) !== file.sha256) {
        this.incoming = null;
        return { ok: false };
      }
      copyFileSync(there, to, constants.COPYFILE_FICLONE);
    }
    if (!order.last) return { ok: true };
    this.incoming = null;
    const marked: State = { version: 1, stream: order.stream, seq: order.seq, at: order.at };
    writePrivate(this.at(FULL_FILE), `${JSON.stringify(marked)}\n`);
    this.swapIn(marked);
    return { ok: true, swapped: true };
  }

  /** Puts the full copy in place of the old one, whichever step a restart stopped at. */
  private swapIn(marked: State): void {
    const incoming = this.at(INCOMING);
    const copy = this.at(STANDBY_COPY);
    const old = this.at(OLD_COPY);
    if (existsSync(incoming)) {
      if (existsSync(copy)) {
        rmSync(old, { recursive: true, force: true });
        renameSync(copy, old);
      }
      renameSync(incoming, copy);
    }
    rmSync(this.at(REDO_FILE), { force: true });
    this.writeState(marked);
    rmSync(old, { recursive: true, force: true });
    rmSync(this.at(BLOBS), { recursive: true, force: true });
    rmSync(this.at(FULL_FILE), { force: true });
    this.hashes.clear();
  }

  private apply(order: ApplyOrder): { ok: boolean; stream: string | null; seq: number } {
    const state = this.state();
    if (state.stream !== order.stream || state.seq !== order.from)
      return { ok: false, stream: state.stream, seq: state.seq };
    let seq = order.from;
    for (const change of order.changes) {
      if (change.seq <= seq || change.seq > order.through)
        throw new Error("Changes arrive in order.");
      seq = change.seq;
    }
    if (order.through <= order.from) throw new Error("Changes arrive in order.");
    writePrivate(this.at(REDO_FILE), `${JSON.stringify(order)}\n`);
    try {
      this.applyWhole(order);
    } catch (error) {
      // A change that does not fit, or a write that failed partway: the
      // copy is no longer as of one change, so it waits for a full copy.
      this.options.log(
        `a change did not fit the copy, which waits for a full copy: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.dropCopy();
      return { ok: false, stream: null, seq: 0 };
    }
    const after = this.state();
    return { ok: true, stream: after.stream, seq: after.seq };
  }

  /** Every change of one apply, then the place it reached; asked again after a restart, the same. */
  private applyWhole(order: ApplyOrder): void {
    const used: string[] = [];
    for (const change of order.changes) this.applyOne(change, used);
    this.writeState({ version: 1, stream: order.stream, seq: order.through, at: order.at });
    rmSync(this.at(REDO_FILE), { force: true });
    for (const sha256 of used) rmSync(join(this.at(BLOBS), sha256), { force: true });
  }

  private blobOf(sha256: string, used: string[]): Buffer {
    const blob = join(this.at(BLOBS), sha256);
    if (!existsSync(blob)) throw new Refused(`the blob ${sha256} it names is not here`);
    used.push(sha256);
    return readFileSync(blob);
  }

  private applyOne(change: StandbyChange, used: string[]): void {
    const file = this.copyPath(change.path);
    switch (change.kind) {
      case "pages": {
        const pages: { pgno: number; data: Buffer }[] = change.pages
          ? change.pages.map((page) => ({
              pgno: page.pgno,
              data: Buffer.from(page.data, "base64"),
            }))
          : unpackPages(
              change.blob ? this.blobOf(change.blob, used) : Buffer.alloc(0),
              change.pageSize,
            );
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const fd = openSync(file, existsSync(file) ? "r+" : "w+", 0o600);
        try {
          for (const page of pages) {
            if (page.data.length !== change.pageSize) throw new Refused("a page of another size");
            writeSync(fd, page.data, 0, page.data.length, (page.pgno - 1) * change.pageSize);
          }
          ftruncateSync(fd, change.dbPages * change.pageSize);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return;
      }
      case "file": {
        const data =
          change.data !== undefined
            ? Buffer.from(change.data, "base64")
            : this.blobOf(change.sha256, used);
        if (data.length !== change.size)
          throw new Refused(`${change.path} arrived at another size`);
        writeWhole(file, data);
        return;
      }
      case "append": {
        const data = Buffer.from(change.data, "base64");
        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          throw new Refused(`${change.path} is not in the copy to add to`);
        }
        // Asked again after a restart that had already added it: nothing more.
        if (size === change.offset + data.length) return;
        if (size !== change.offset) throw new Refused(`${change.path} is not the size it was`);
        const fd = openSync(file, "r+");
        try {
          writeSync(fd, data, 0, data.length, change.offset);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return;
      }
      case "gone":
        // A folder the home removed goes with everything in it.
        rmSync(file, { recursive: true, force: true });
        return;
    }
  }
}

function writeWhole(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.standby-tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, data, 0, data.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/** Pages packed as each page's number in four bytes, then its image. */
export function packPages(pages: Map<number, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [pgno, data] of pages) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(pgno, 0);
    parts.push(head, data);
  }
  return Buffer.concat(parts);
}

export function unpackPages(packed: Buffer, pageSize: number): { pgno: number; data: Buffer }[] {
  const pages: { pgno: number; data: Buffer }[] = [];
  for (let at = 0; at + 4 + pageSize <= packed.length; at += 4 + pageSize)
    pages.push({ pgno: packed.readUInt32BE(at), data: packed.subarray(at + 4, at + 4 + pageSize) });
  return pages;
}
