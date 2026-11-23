import { createHash, type Hash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  type FSWatcher,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { copyFile, open, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  STANDBY_APPLY_ORDER,
  STANDBY_DROP_ORDER,
  STANDBY_FILES_PER_ORDER,
  STANDBY_FULL_ORDER,
  STANDBY_HELLO_ORDER,
  STANDBY_HOME_ORDER,
  STANDBY_LACKS_ORDER,
  STANDBY_PIECE_ORDER,
  type StandbyChange,
  type StandbyFile,
  type StandbyHeard,
  type StandbyHello,
  type StandbyHome,
  type StandbyView,
  standbyHelloSchema,
  standbyOrders,
} from "@shared/standby";
import { PLACED_COPY_CHUNK_BYTES } from "@shared/work";
import Database from "better-sqlite3";
import { z } from "zod";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";
import { DeviceOutOfReachError } from "../connection/connection";
import { writePrivate } from "../devices/identity";
import {
  CLAUDE_FOLDERS,
  CLAUDE_PREFIX,
  DATABASE_SIDECARS,
  hashFile,
  listRecord,
  listRecordInTurns,
  RECORD_ROOTS,
} from "../homeMove/record";
import type { AppDatabase } from "../storage/db";
import { packPages } from "./keeper";
import { STANDBYS_FILE, type Standbys, standbysSchema } from "./named";
import { readWal, type WalPlace } from "./wal";

/** A database of the record whose changes cross as pages: its place in the record and its writer here. */
export type PagesDatabase = { path: string; connection: () => AppDatabase | null };

/** What the home's side of keeping copies needs from the core. */
export type StandbyStreamHost = {
  userData: string;
  claudeDir: string | null;
  /** This computer's own folder for the stream's kept changes, outside the record. */
  stagingDir: string;
  /** The databases whose changes cross as pages; any other database crosses whole when it changes. */
  pagesDatabases: () => PagesDatabase[];
  ask: (deviceId: string, channel: string, args: unknown) => Promise<unknown>;
  inReach: (deviceId: string) => boolean;
  /** The computer is connected and its version lists `standby-copy`. */
  speaksCopy: (deviceId: string) => boolean;
  /** Hears each computer come into reach and go; answers its own unsubscribe. */
  onReach: (listener: (deviceId: string) => void) => () => void;
  /**
   * The computer's version lists `standby-take-over`, so it is told what
   * taking over needs beside the record; none from before.
   */
  speaksTakeOver?: (deviceId: string) => boolean;
  /**
   * What taking over needs that the record does not hold (docs/devices.md,
   * "Taking over"), less what the stream itself says; null while it cannot
   * be read.
   */
  homeFacts?: () => Promise<Omit<StandbyHome, "stream" | "seq" | "at" | "copies"> | null>;
  /** A computer's name as the list says it. */
  nameOf?: (deviceId: string) => string;
  emit: (views: StandbyView[]) => void;
  /**
   * Where the named computers would answer changed (`addresses`): a copy
   * named or dropped, or a hello that said new addresses, so the home tells
   * every device again.
   */
  addressesChanged?: () => void;
  log: (line: string) => void;
  now?: () => number;
};

/**
 * When each copy was last whole, as this home last knew it, kept beside the
 * record and never in it: writing it is no change for a copy to follow, so
 * it is kept as often as a copy's time moves, and a home that stopped without
 * closing still knows it when it starts again.
 */
export const STANDBY_TIMES_FILE = "devices/standby-times.json";

const timesSchema = z.record(z.string().min(1).max(64), z.number().int().nonnegative());

/** One change of the stream as the home keeps it until every copy has it. */
type Entry =
  | {
      kind: "pages";
      seq: number;
      at: number;
      path: string;
      pageSize: number;
      dbPages: number;
      /** The kept file of its packed pages, and their bytes. */
      bytes: number;
    }
  /** A file of the record changed, appeared or went: its content is read when it is sent. */
  | { kind: "touch"; seq: number; at: number; path: string; bytes: number };

type Follower = {
  deviceId: string;
  /** The last change of this stream its copy holds; null until a hello or full copy says. */
  ack: number | null;
  /** When the home saved that change. */
  ackAt: number | null;
  phase: "hello" | "copying" | "sending" | "idle" | "away" | "needs-update";
  done?: number;
  total?: number;
  copyAt: number | null;
  /** What it holds of each plain file, so a file that only grew sends what it added. */
  sent: Map<string, Known>;
  /** How long to wait after the next failure: it doubles each time, and a copy in sync starts it over. */
  retryMs: number;
  /** Set when the computer comes into reach or goes out of it: the one thing that ends a wait after a failure early. */
  reachChanged: boolean;
  stopped: boolean;
  wake: (() => void) | null;
};

const PIECE = PLACED_COPY_CHUNK_BYTES;

/** How much of a file's end the home remembers, to tell a file that only grew from one written anew. */
const TAIL_BYTES = 4096;

/**
 * What a copy holds of one plain file: its size and hash, its last bytes,
 * and the hash's state at its end, so what the file adds later is hashed
 * alone, never the whole file again. The state is only ever copied, never
 * finished.
 */
type Known = { size: number; sha256: string; tail: Buffer; hash: Hash };

/** A file's end after `chunk`, kept apart from the buffer it came in. */
function tailAfter(tail: Buffer, chunk: Buffer): Buffer {
  return Buffer.from(Buffer.concat([tail, chunk.subarray(-TAIL_BYTES)]).subarray(-TAIL_BYTES));
}

function knownOf(data: Buffer): Known {
  const hash = createHash("sha256").update(data);
  return {
    size: data.length,
    sha256: hash.copy().digest("hex"),
    tail: tailAfter(Buffer.alloc(0), data),
    hash,
  };
}

/** A plain file read in pieces, so a long one never holds up the home's turn. */
async function knownFile(abs: string): Promise<Known> {
  const hash = createHash("sha256");
  const handle = await open(abs, "r");
  let size = 0;
  let tail: Buffer = Buffer.alloc(0);
  try {
    const buffer = Buffer.alloc(PIECE);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      tail = tailAfter(tail, chunk);
      size += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.copy().digest("hex"), tail, hash };
}

/**
 * How often the whole record is looked over beside the watch: a system may
 * drop watch events under load, and this reads only each file's size and
 * time.
 */
const RESCAN_MS = 60_000;
/**
 * How long the home first waits before asking a computer that cannot keep a
 * copy yet, or one that refused, again; each failure in a row doubles it, to
 * at most the look over's interval.
 */
const ASK_AGAIN_MS = 2_000;

/**
 * The home's side of keeping copies (docs/devices.md, "Keeping a copy on
 * another computer"). Every change the home saves becomes the next change
 * of one numbered stream, right after the save: each database's committed
 * pages, read from its write-ahead log, and each file of the record that
 * changed. The home keeps the changes on its own disk until every copy has
 * them, but never more than a full copy's size; each named computer is sent
 * them in order, at its own pace, and one too far behind takes a full copy.
 * Nothing here holds up a save: reading the logs is the only work done in
 * the save's own turn, and every send happens after.
 */
export class StandbyStream {
  private stream = randomUUID();
  private seq = 0;
  private entries: Entry[] = [];
  private keptBytes = 0;
  /** A full copy's size as last measured: the most the home keeps of the stream. */
  private recordBytes = 0;
  private readonly places = new Map<string, WalPlace | null>();
  /** Whether a database's log may begin again, once its last checkpoint took every frame. */
  private readonly mayRestart = new Map<string, boolean>();
  /** Frames read since each database's last checkpoint, and SQLite's own threshold for one. */
  private readonly sinceCheckpoint = new Map<string, number>();
  private readonly thresholds = new Map<string, number>();
  private readonly connections = new Map<string, AppDatabase>();
  private readonly followers = new Map<string, Follower>();
  private readonly dirty = new Set<string>();
  private watchers: FSWatcher[] = [];
  /**
   * A watch on each database's own log: a folder's watch on a Mac names a
   * file added or removed in it, never one written, so a save to a log at
   * the data folder's top would wait for the look over.
   */
  private readonly logWatchers = new Map<string, FSWatcher>();
  /** Each other database touched since the last flush, taken once for every copy. */
  private readNow = new Map<string, Promise<{ data: Buffer; sha256: string } | null>>();
  /** Each plain file as last read, by its size and time, so a full copy for one more computer reads only what changed. */
  private readonly known = new Map<string, Known & { mtimeMs: number }>();
  private flushing = false;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  /** The look over now running, and the one asked for since, which starts once it ends. */
  private lookingOver: Promise<void> = Promise.resolve();
  private nextLook: Promise<void> | null = null;
  private snapshot = new Map<string, { size: number; mtimeMs: number }>();
  private stopReach: (() => void) | null = null;
  private disposed = false;
  private active = false;
  /** Each wait for the copies in reach to hold every change so far (`settled`). */
  private readonly settling = new Set<() => void>();
  /** What each copy was last told of the home, so the same is not told again. */
  private readonly told = new Map<string, string>();

  constructor(private readonly host: StandbyStreamHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private file(): string {
    return join(this.host.userData, ...STANDBYS_FILE.split("/"));
  }

  private read(): Standbys {
    try {
      return standbysSchema.parse(JSON.parse(readFileSync(this.file(), "utf8")));
    } catch {
      return { version: 1, standbys: [], dropping: [] };
    }
  }

  private write(standbys: Standbys): void {
    // What a welcome would list of them: a copy that said nowhere lists
    // nothing; a phone also hears each copy that said where it listens.
    const said = (each: Standbys) =>
      JSON.stringify([
        each.standbys.map((one) => one.addresses ?? []).filter((at) => at.length > 0),
        each.standbys
          .filter((one) => (one.listens ?? []).length > 0)
          .map((one) => [one.deviceId, one.listens]),
      ]);
    const before = said(this.read());
    mkdirSync(dirname(this.file()), { recursive: true, mode: 0o700 });
    writePrivate(this.file(), `${JSON.stringify(standbys, null, 2)}\n`);
    if (said(standbys) === before) return;
    try {
      this.host.addressesChanged?.();
    } catch {
      // Telling is the host's; the list is kept all the same.
    }
  }

  named(): string[] {
    return this.read().standbys.map((each) => each.deviceId);
  }

  /** Every computer this list still names: those keeping a copy and those whose copy is still to go. */
  listed(): string[] {
    const standbys = this.read();
    return [...new Set([...standbys.standbys.map((each) => each.deviceId), ...standbys.dropping])];
  }

  /** Starts following what is named, once the core is up. */
  start(): void {
    if (this.disposed) return;
    this.stopReach ??= this.host.onReach((deviceId) => {
      const follower = this.followers.get(deviceId);
      if (follower) follower.reachChanged = true;
      follower?.wake?.();
      if (this.read().dropping.includes(deviceId)) void this.dropThere(deviceId);
    });
    const standbys = this.read();
    const times = this.readTimes();
    for (const each of standbys.standbys) {
      const kept = times[each.deviceId] ?? null;
      this.follow(
        each.deviceId,
        each.copyAt === null || kept === null ? (kept ?? each.copyAt) : Math.max(kept, each.copyAt),
      );
    }
    for (const deviceId of standbys.dropping) void this.dropThere(deviceId);
    this.emit();
  }

  /** The captain's Keep a copy here, or Stop keeping a copy. */
  name(deviceId: string, on: boolean): void {
    const standbys = this.read();
    const has = standbys.standbys.some((each) => each.deviceId === deviceId);
    if (on && !has) {
      standbys.standbys.push({ deviceId, copyAt: null });
      standbys.dropping = standbys.dropping.filter((each) => each !== deviceId);
      this.write(standbys);
      this.keepTime(deviceId, null);
      this.follow(deviceId, null);
    } else if (!on && has) {
      standbys.standbys = standbys.standbys.filter((each) => each.deviceId !== deviceId);
      if (!standbys.dropping.includes(deviceId)) standbys.dropping.push(deviceId);
      this.write(standbys);
      this.unfollow(deviceId);
      void this.dropThere(deviceId);
    }
    this.emit();
  }

  /**
   * A computer that is no longer one that runs work for this home leaves the
   * list, with nothing more asked of it: a removal takes its copy there
   * (`cleanUp`), and a computer the first mate moved to drops its own copy
   * once the first mate starts there.
   */
  forget(deviceId: string): void {
    const standbys = this.read();
    if (
      !standbys.standbys.some((each) => each.deviceId === deviceId) &&
      !standbys.dropping.includes(deviceId)
    )
      return;
    standbys.standbys = standbys.standbys.filter((each) => each.deviceId !== deviceId);
    standbys.dropping = standbys.dropping.filter((each) => each !== deviceId);
    this.write(standbys);
    this.keepTime(deviceId, null);
    this.unfollow(deviceId);
    this.emit();
  }

  private async dropThere(deviceId: string): Promise<void> {
    if (!this.host.speaksCopy(deviceId)) return;
    try {
      standbyOrders[STANDBY_DROP_ORDER].response.parse(
        await this.host.ask(deviceId, STANDBY_DROP_ORDER, []),
      );
    } catch {
      return;
    }
    const standbys = this.read();
    standbys.dropping = standbys.dropping.filter((each) => each !== deviceId);
    this.write(standbys);
  }

  private readTimes(): Record<string, number> {
    try {
      return timesSchema.parse(
        JSON.parse(
          readFileSync(join(this.host.userData, ...STANDBY_TIMES_FILE.split("/")), "utf8"),
        ),
      );
    } catch {
      return {};
    }
  }

  private keepTime(deviceId: string, copyAt: number | null): void {
    const times = this.readTimes();
    if ((times[deviceId] ?? null) === copyAt) return;
    if (copyAt === null) delete times[deviceId];
    else times[deviceId] = copyAt;
    const file = join(this.host.userData, ...STANDBY_TIMES_FILE.split("/"));
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writePrivate(file, `${JSON.stringify(times)}\n`);
    } catch (error) {
      this.host.log(`could not keep when a copy is from: ${String(error)}`);
    }
  }

  /** Where a copy said it listens for the others, kept only when it moved: each write is a change every copy takes. */
  private keepListens(deviceId: string, listens: readonly string[] | undefined): void {
    if (listens === undefined) return;
    const standbys = this.read();
    const each = standbys.standbys.find((one) => one.deviceId === deviceId);
    if (!each || JSON.stringify(each.listens ?? []) === JSON.stringify(listens)) return;
    each.listens = [...listens];
    this.write(standbys);
  }

  private keepCopyAt(deviceId: string, copyAt: number | null): void {
    const standbys = this.read();
    const each = standbys.standbys.find((one) => one.deviceId === deviceId);
    if (!each || each.copyAt === copyAt) return;
    each.copyAt = copyAt;
    this.write(standbys);
  }

  /**
   * Where each named computer's first mate would answer should it take over,
   * as its hello last said, one list per computer: every device is told
   * them in its welcome.
   */
  addresses(): string[][] {
    return this.read().standbys.map((each) => each.addresses ?? []);
  }

  /**
   * Where each named computer listens for the other copies, as its hello
   * last said: a phone is told them, so it reaches a copy while the home is
   * out of reach (docs/devices.md, "Taking over from a phone").
   */
  listening(): { deviceId: string; listens: string[] }[] {
    return this.read().standbys.map((each) => ({
      deviceId: each.deviceId,
      listens: [...(each.listens ?? [])],
    }));
  }

  /** Each named computer as this home last knew it: where it would answer, and when its copy is from. */
  kept(): { deviceId: string; addresses: string[]; copyAt: number | null }[] {
    return this.read().standbys.map((each) => ({
      deviceId: each.deviceId,
      addresses: each.addresses ?? [],
      copyAt: this.view(each.deviceId)?.copyAt ?? each.copyAt,
    }));
  }

  private keepAddresses(deviceId: string, addresses: string[]): void {
    const standbys = this.read();
    const each = standbys.standbys.find((one) => one.deviceId === deviceId);
    if (!each) return;
    const before = each.addresses ?? [];
    if (before.length === addresses.length && before.every((at, i) => addresses[i] === at)) return;
    each.addresses = addresses;
    this.write(standbys);
  }

  /**
   * Resolves once every copy in reach that follows this stream holds every
   * change saved so far (docs/devices.md, "Before an act that cannot be
   * undone"): the home asks it before a merge, a push or a secret use, and
   * before telling a computer that runs work what it kept, so a computer that
   * takes over finds the act recorded. It waits for no copy out of reach, one
   * still taking its full copy, or one that drops meanwhile, and keeps no
   * timer of its own.
   */
  settled(): Promise<void> {
    if (!this.active || this.disposed) return Promise.resolve();
    try {
      this.flush();
    } catch (error) {
      this.host.log(`could not read the record's changes before an act: ${String(error)}`);
    }
    const target = this.seq;
    const stream = this.stream;
    const holds = () =>
      this.active &&
      !this.disposed &&
      this.stream === stream &&
      [...this.followers.values()].some(
        (follower) =>
          !follower.stopped &&
          follower.ack !== null &&
          follower.ack < target &&
          follower.phase !== "away" &&
          follower.phase !== "needs-update" &&
          this.host.inReach(follower.deviceId),
      );
    if (!holds()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (holds()) return;
        this.settling.delete(check);
        resolve();
      };
      this.settling.add(check);
    });
  }

  private checkSettled(): void {
    for (const check of [...this.settling]) check();
  }

  /** Every copy as this home sees it now, for a computer taking over to show beside its own. */
  private heard(): StandbyHeard[] {
    return [...this.followers.values()].map((follower) => ({
      deviceId: follower.deviceId,
      name: (this.host.nameOf?.(follower.deviceId) ?? follower.deviceId).slice(0, 64) || "Computer",
      state: this.viewOf(follower).state,
      copyAt: follower.copyAt,
      seq: follower.ack,
    }));
  }

  /**
   * Tells a copy what taking over needs beside the record, when it changed
   * since it was last told. Nothing it fails to tell holds the copy up.
   */
  private async tellHome(follower: Follower): Promise<void> {
    if (!this.host.homeFacts || !this.host.speaksTakeOver?.(follower.deviceId)) return;
    const facts = await this.host.homeFacts();
    if (!facts || follower.stopped || this.disposed) return;
    const copies = this.heard();
    // The same facts are not told again; where each copy stands only once its state moved.
    const key = JSON.stringify({
      facts,
      copies: copies.map(({ deviceId, state }) => ({ deviceId, state })),
    });
    if (this.told.get(follower.deviceId) === key) return;
    const home: StandbyHome = {
      ...facts,
      stream: this.stream,
      seq: this.seq,
      at: this.now(),
      copies,
    };
    try {
      standbyOrders[STANDBY_HOME_ORDER].response.parse(
        await this.host.ask(follower.deviceId, STANDBY_HOME_ORDER, [home]),
      );
      this.told.set(follower.deviceId, key);
    } catch (error) {
      if (!(error instanceof DeviceOutOfReachError))
        this.host.log(
          `could not tell ${follower.deviceId} what taking over needs: ${String(error)}`,
        );
    }
  }

  /** Tells each copy in sync what taking over needs, where it changed. */
  private tellEveryHome(): void {
    for (const follower of this.followers.values())
      if (follower.phase === "idle" && this.host.inReach(follower.deviceId))
        void this.tellHome(follower);
  }

  views(): StandbyView[] {
    return [...this.followers.values()].map((follower) => this.viewOf(follower));
  }

  view(deviceId: string): StandbyView | undefined {
    const follower = this.followers.get(deviceId);
    return follower ? this.viewOf(follower) : undefined;
  }

  private viewOf(follower: Follower): StandbyView {
    const base = { deviceId: follower.deviceId, copyAt: follower.copyAt };
    switch (follower.phase) {
      case "needs-update":
        return { ...base, state: "needs-update" };
      case "away":
        return { ...base, state: "away" };
      case "copying":
        return {
          ...base,
          state: "copying",
          ...(follower.done !== undefined ? { done: follower.done } : {}),
          ...(follower.total !== undefined ? { total: follower.total } : {}),
        };
      default: {
        if (follower.ack === null) return { ...base, state: "copying" };
        const behind = this.seq - follower.ack;
        return behind > 0
          ? { ...base, state: "catching-up", behind }
          : { ...base, state: "in-sync" };
      }
    }
  }

  private emit(): void {
    this.checkSettled();
    if (!this.disposed) this.host.emit(this.views());
  }

  /** Begins watching the record and reading the logs, once any computer is named. */
  private activate(): void {
    if (this.active || this.disposed) return;
    this.active = true;
    rmSync(this.host.stagingDir, { recursive: true, force: true });
    mkdirSync(join(this.host.stagingDir, "log"), { recursive: true, mode: 0o700 });
    this.stream = randomUUID();
    this.seq = 0;
    this.entries = [];
    this.keptBytes = 0;
    for (const db of this.host.pagesDatabases()) this.bind(db);
    // The stream starts at each log's end: a copy starts from a full copy taken then.
    for (const db of this.host.pagesDatabases()) this.readLog(db, false);
    this.snapshot = this.listSnapshot();
    this.watch();
    this.rescanTimer = setInterval(() => void this.rescan(), RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    for (const path of [...this.logWatchers.keys()]) this.unwatchLog(path);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    // SQLite folds its log back by itself again.
    for (const [path, connection] of this.connections) {
      try {
        connection.pragma(`wal_autocheckpoint = ${this.thresholds.get(path) ?? 1000}`);
      } catch {
        // A closed writer takes nothing back.
      }
    }
    this.connections.clear();
    this.places.clear();
    this.entries = [];
    this.keptBytes = 0;
    rmSync(this.host.stagingDir, { recursive: true, force: true });
  }

  /**
   * Takes over folding a database's log back: SQLite would otherwise fold it
   * and begin it again at any write, and frames not yet read would be lost.
   * The stream folds it right after reading every frame, once as many frames
   * gathered as SQLite's own threshold.
   */
  private bind(db: PagesDatabase): AppDatabase | null {
    const connection = db.connection();
    if (!connection) return null;
    if (this.connections.get(db.path) === connection) return connection;
    try {
      if (!this.thresholds.has(db.path))
        this.thresholds.set(
          db.path,
          Number(connection.pragma("wal_autocheckpoint", { simple: true })) || 1000,
        );
      connection.pragma("wal_autocheckpoint = 0");
      this.connections.set(db.path, connection);
      return connection;
    } catch {
      return null;
    }
  }

  private abs(path: string): string {
    const parts = path.split("/");
    if (parts[0] === CLAUDE_PREFIX && this.host.claudeDir) {
      const folder = CLAUDE_FOLDERS[Number(parts[1])] ?? "";
      return join(
        this.host.claudeDir,
        "projects",
        encodeClaudeProjectDir(join(this.host.userData, folder)),
        ...parts.slice(2),
      );
    }
    return join(this.host.userData, ...parts);
  }

  /**
   * Reads one database's log from where the stream last stopped, keeping its
   * committed pages as the next change, and folds the log back once it is
   * long enough and fully read. With `keep` false it only finds the log's end.
   */
  private readLog(db: PagesDatabase, keep: boolean): void {
    const connection = this.bind(db);
    const wal = `${this.abs(db.path)}-wal`;
    let place = this.places.get(db.path) ?? null;
    let reading = readWal(wal, place);
    if (reading.kind === "restarted") {
      if (place && this.mayRestart.get(db.path) && reading.place) {
        // The log began again after a checkpoint that took every frame read.
        place = null;
        this.mayRestart.set(db.path, false);
        reading = readWal(wal, null);
      } else if (keep && place) {
        this.host.log(`${db.path}'s log began again unread; every copy takes a full copy`);
        this.restartStream();
        return;
      } else {
        place = null;
        reading = readWal(wal, null);
      }
    }
    if (reading.kind !== "frames") {
      this.places.set(db.path, null);
      return;
    }
    // The place moves on only once the pages are kept: a change lost here would leave the copies a gap.
    if (reading.pages.size > 0 && keep)
      if (!this.keepPages(db.path, reading.place.pageSize, reading.dbPages, reading.pages)) return;
    this.places.set(db.path, reading.place);
    if (reading.pages.size > 0) {
      this.mayRestart.set(db.path, false);
      this.sinceCheckpoint.set(
        db.path,
        (this.sinceCheckpoint.get(db.path) ?? 0) + reading.pages.size,
      );
    }
    const threshold = this.thresholds.get(db.path) ?? 1000;
    if (connection && (this.sinceCheckpoint.get(db.path) ?? 0) >= threshold) {
      try {
        // Same turn as the read: nothing here writes between them.
        const [result] = connection.pragma("wal_checkpoint(PASSIVE)") as {
          busy: number;
          log: number;
          checkpointed: number;
        }[];
        this.sinceCheckpoint.set(db.path, 0);
        this.mayRestart.set(db.path, result !== undefined && result.log === result.checkpointed);
      } catch (error) {
        this.host.log(`could not fold ${db.path}'s log back: ${String(error)}`);
      }
    }
  }

  private keepPages(
    path: string,
    pageSize: number,
    dbPages: number,
    pages: Map<number, Buffer>,
  ): boolean {
    const seq = this.seq + 1;
    const packed = packPages(pages);
    try {
      writeFileSync(join(this.host.stagingDir, "log", `${seq}`), packed, { mode: 0o600 });
    } catch (error) {
      // A change that cannot be kept cannot be sent: every copy takes a full copy instead.
      this.host.log(
        `could not keep a change of ${path}, so every copy takes a full copy: ${String(error)}`,
      );
      this.restartStream();
      return false;
    }
    this.seq = seq;
    this.push({
      kind: "pages",
      seq,
      at: this.now(),
      path,
      pageSize,
      dbPages,
      bytes: packed.length,
    });
    return true;
  }

  private push(entry: Entry): void {
    this.entries.push(entry);
    this.keptBytes += entry.bytes;
    this.trim();
  }

  /** Lets go of changes every copy has, and of the oldest once more than a full copy is kept. */
  private trim(): void {
    const acks = [...this.followers.values()].map((follower) => follower.ack ?? -1);
    const lowest = acks.length ? Math.min(...acks) : this.seq;
    const bound = Math.max(this.recordBytes, PIECE);
    while (this.entries.length) {
      const first = this.entries[0];
      if (!first) break;
      if (first.seq > lowest && this.keptBytes <= bound) break;
      this.entries.shift();
      this.keptBytes -= first.bytes;
      rmSync(join(this.host.stagingDir, "log", `${first.seq}`), { force: true });
    }
  }

  /** A log read part way was lost: a new stream, and every copy takes a full copy. */
  private restartStream(): void {
    for (const entry of this.entries)
      rmSync(join(this.host.stagingDir, "log", `${entry.seq}`), { force: true });
    this.entries = [];
    this.keptBytes = 0;
    this.stream = randomUUID();
    this.seq = 0;
    this.places.clear();
    for (const db of this.host.pagesDatabases()) this.readLog(db, false);
    for (const follower of this.followers.values()) {
      follower.ack = null;
      follower.phase = "hello";
      follower.wake?.();
    }
  }

  /** Whether a place in the record crosses as a whole file when it changes. */
  private isPagesPath(path: string): boolean {
    return this.host.pagesDatabases().some((db) => db.path === path);
  }

  private recordPathOf(abs: string): string | null {
    const inData = relative(this.host.userData, abs);
    if (!inData.startsWith("..") && inData !== "") {
      const path = inData.split(sep).join("/");
      const sidecar = DATABASE_SIDECARS.find((suffix) => path.endsWith(suffix));
      const bare = sidecar ? path.slice(0, -sidecar.length) : path;
      if (!RECORD_ROOTS.some((root) => bare === root || bare.startsWith(`${root}/`))) return null;
      const parts = path.split("/");
      if (
        parts[0] === "crewmates" &&
        parts.length >= 3 &&
        (parts[2] === "temp" || parts[2] === "move")
      )
        return null;
      return path;
    }
    if (!this.host.claudeDir) return null;
    for (const [index, folder] of CLAUDE_FOLDERS.entries()) {
      const dir = join(
        this.host.claudeDir,
        "projects",
        encodeClaudeProjectDir(join(this.host.userData, folder)),
      );
      const inClaude = relative(dir, abs);
      if (!inClaude.startsWith("..") && inClaude !== "")
        return `${CLAUDE_PREFIX}/${index}/${inClaude.split(sep).join("/")}`;
    }
    return null;
  }

  private watch(): void {
    const at = (dir: string, recursive: boolean) => {
      if (!existsSync(dir)) return;
      try {
        const watcher = watch(dir, { recursive, persistent: false }, (_event, name) => {
          if (name === null) {
            void this.rescan();
            return;
          }
          this.touched(join(dir, name.toString()));
        });
        watcher.on("error", () => void this.rescan());
        this.watchers.push(watcher);
      } catch (error) {
        this.host.log(
          `could not watch ${dir}; the record is looked over instead: ${String(error)}`,
        );
      }
    };
    at(this.host.userData, false);
    at(join(this.host.userData, "devices"), false);
    for (const root of RECORD_ROOTS) {
      const dir = join(this.host.userData, ...root.split("/"));
      try {
        if (lstatSync(dir).isDirectory()) at(dir, true);
      } catch {
        // Not there yet: the look over finds it once it is.
      }
    }
    if (this.host.claudeDir)
      for (const folder of CLAUDE_FOLDERS)
        at(
          join(
            this.host.claudeDir,
            "projects",
            encodeClaudeProjectDir(join(this.host.userData, folder)),
          ),
          true,
        );
    this.watchLogs();
  }

  /** Watches each database's log that has none yet; one replaced or gone is watched again at the next flush. */
  private watchLogs(): void {
    for (const db of this.host.pagesDatabases()) {
      if (this.logWatchers.has(db.path)) continue;
      const wal = `${this.abs(db.path)}-wal`;
      if (!existsSync(wal)) continue;
      try {
        const watcher = watch(wal, { persistent: false }, (event) => {
          if (event === "rename") this.unwatchLog(db.path);
          this.dirty.add(db.path);
          this.schedule();
        });
        watcher.on("error", () => {
          this.unwatchLog(db.path);
          this.schedule();
        });
        this.logWatchers.set(db.path, watcher);
      } catch {
        // Gone between the look and the watch: the folder's watch names it once it is back.
      }
    }
  }

  private unwatchLog(path: string): void {
    this.logWatchers.get(path)?.close();
    this.logWatchers.delete(path);
  }

  /** A path the watch named: the next change once this turn ends. */
  private touched(abs: string): void {
    let path = this.recordPathOf(abs);
    if (path === null) return;
    const sidecar = DATABASE_SIDECARS.find((suffix) => path?.endsWith(suffix));
    if (sidecar) path = path.slice(0, -sidecar.length);
    if (sidecar === "-shm") return;
    this.dirty.add(path);
    this.schedule();
  }

  private schedule(): void {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      try {
        this.flush();
      } catch (error) {
        // Whatever this turn read may be lost: every copy takes a full copy rather than miss it.
        this.host.log(
          `could not read the record's changes, so every copy takes a full copy: ${String(error)}`,
        );
        if (this.active && !this.disposed) this.restartStream();
      }
    });
  }

  /** Every change since the last flush becomes the next changes of the stream. */
  flush(): void {
    if (!this.active || this.disposed) return;
    const before = this.seq;
    this.readNow = new Map();
    this.watchLogs();
    for (const db of this.host.pagesDatabases()) this.readLog(db, true);
    const paths = [...this.dirty];
    this.dirty.clear();
    for (const path of paths) {
      if (this.isPagesPath(path)) continue;
      // A folder the watch named is followed through the files in it; one removed is a change.
      if (isFolder(this.abs(path))) continue;
      this.push({ kind: "touch", seq: ++this.seq, at: this.now(), path, bytes: path.length });
      const abs = this.abs(path);
      try {
        const facts = statSync(abs);
        if (facts.isFile()) this.snapshot.set(path, { size: facts.size, mtimeMs: facts.mtimeMs });
        else this.snapshot.delete(path);
      } catch {
        this.snapshot.delete(path);
      }
    }
    if (this.seq !== before) {
      for (const follower of this.followers.values()) follower.wake?.();
      this.emit();
    }
  }

  private listSnapshot(): Map<string, { size: number; mtimeMs: number }> {
    const found = new Map<string, { size: number; mtimeMs: number }>();
    for (const entry of listRecord(this.host.userData, this.host.claudeDir, { kinds: false })) {
      if (this.isPagesPath(entry.path)) continue;
      found.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs });
    }
    return found;
  }

  /**
   * Looks the whole record over for what the watch did not name, a few
   * hundred files a turn so a large record never holds up the home's turn;
   * asked again while one runs, it looks again once that one ends.
   */
  rescan(): Promise<void> {
    if (!this.active || this.disposed) return Promise.resolve();
    if (!this.nextLook) {
      const next = this.lookingOver.then(async () => {
        this.nextLook = null;
        await this.lookOver();
      });
      this.nextLook = next.catch((error: unknown) => {
        this.host.log(`could not look the record over: ${String(error)}`);
      });
      this.lookingOver = this.nextLook;
    }
    return this.nextLook;
  }

  private async lookOver(): Promise<void> {
    if (!this.active || this.disposed) return;
    const now = new Map<string, { size: number; mtimeMs: number }>();
    for (const entry of await listRecordInTurns(this.host.userData, this.host.claudeDir, {
      kinds: false,
    })) {
      if (this.isPagesPath(entry.path)) continue;
      now.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs });
    }
    if (!this.active || this.disposed) return;
    for (const [path, facts] of now) {
      const before = this.snapshot.get(path);
      if (!before || before.size !== facts.size || before.mtimeMs !== facts.mtimeMs)
        this.dirty.add(path);
    }
    for (const path of this.snapshot.keys()) if (!now.has(path)) this.dirty.add(path);
    this.snapshot = now;
    if (this.dirty.size) this.schedule();
    // A home that stops without closing knows when each copy was last whole, at most a look old.
    for (const follower of this.followers.values())
      if (follower.phase === "idle") this.keepTime(follower.deviceId, follower.copyAt);
    this.tellEveryHome();
  }

  private follow(deviceId: string, copyAt: number | null): void {
    if (this.followers.has(deviceId) || this.disposed) return;
    this.activate();
    const follower: Follower = {
      deviceId,
      ack: null,
      ackAt: null,
      phase: "hello",
      copyAt,
      sent: new Map(),
      retryMs: ASK_AGAIN_MS,
      reachChanged: false,
      stopped: false,
      wake: null,
    };
    this.followers.set(deviceId, follower);
    void this.run(follower);
  }

  private unfollow(deviceId: string): void {
    const follower = this.followers.get(deviceId);
    if (!follower) return;
    follower.stopped = true;
    follower.wake?.();
    this.followers.delete(deviceId);
    this.told.delete(deviceId);
    this.checkSettled();
    if (this.followers.size === 0) this.deactivate();
    else this.trim();
  }

  private sleep(follower: Follower, ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      timer?.unref?.();
      function done() {
        if (timer) clearTimeout(timer);
        follower.wake = null;
        resolve();
      }
      follower.wake = done;
    });
  }

  private setPhase(follower: Follower, phase: Follower["phase"]): void {
    if (follower.phase === phase) return;
    const was = follower.phase;
    follower.phase = phase;
    if (phase === "away" && was !== "away") this.keepCopyAt(follower.deviceId, follower.copyAt);
    this.emit();
    // The other copies hear that this one went or came back.
    if ((phase === "away") !== (was === "away")) this.tellEveryHome();
  }

  /** One computer's copy, followed from a hello to in sync, again and again, until it is unnamed. */
  private async run(follower: Follower): Promise<void> {
    while (!follower.stopped && !this.disposed) {
      if (!this.host.inReach(follower.deviceId)) {
        this.setPhase(follower, "away");
        await this.sleep(follower, null);
        continue;
      }
      if (!this.host.speaksCopy(follower.deviceId)) {
        this.setPhase(follower, "needs-update");
        await this.sleep(follower, ASK_AGAIN_MS);
        continue;
      }
      follower.reachChanged = false;
      try {
        await this.serve(follower);
      } catch (error) {
        if (follower.stopped || this.disposed) return;
        follower.ack = null;
        this.told.delete(follower.deviceId);
        this.checkSettled();
        // An order whose answer was lost may or may not have been applied:
        // until the copy says, each changed file crosses whole, never as an append or not at all.
        follower.sent.clear();
        if (error instanceof DeviceOutOfReachError) this.setPhase(follower, "away");
        else {
          this.host.log(`keeping a copy on ${follower.deviceId}: ${String(error)}`);
          this.setPhase(follower, "hello");
        }
        // The whole wait, though the home saves meanwhile: only a stop or a change of reach ends it.
        const until = Date.now() + follower.retryMs;
        follower.retryMs = Math.min(follower.retryMs * 2, RESCAN_MS);
        while (!follower.stopped && !this.disposed && !follower.reachChanged && Date.now() < until)
          await this.sleep(follower, until - Date.now());
      }
    }
  }

  /** Brings one copy up to date, then sends each change as it comes, until it drops. */
  private async serve(follower: Follower): Promise<void> {
    if (follower.ack === null) {
      this.setPhase(follower, "hello");
      const hello: StandbyHello = standbyHelloSchema.parse(
        await this.host.ask(follower.deviceId, STANDBY_HELLO_ORDER, []),
      );
      this.keepListens(follower.deviceId, hello.listens);
      if (hello.addresses?.length) this.keepAddresses(follower.deviceId, hello.addresses);
      const oldest = (this.entries[0]?.seq ?? this.seq + 1) - 1;
      if (hello.stream === this.stream && hello.seq >= oldest && hello.seq <= this.seq) {
        follower.ack = hello.seq;
        follower.ackAt = hello.at;
      } else {
        follower.copyAt = hello.at ?? follower.copyAt;
        await this.fullCopy(follower);
      }
    }
    for (;;) {
      if (follower.stopped || this.disposed) return;
      const ack = follower.ack;
      if (ack === null) return;
      if (ack >= this.seq) {
        follower.retryMs = ASK_AGAIN_MS;
        follower.copyAt = this.now();
        this.setPhase(follower, "idle");
        this.emit();
        await this.tellHome(follower);
        if (follower.ack !== null && follower.ack < this.seq) continue;
        await this.sleep(follower, null);
        if (!this.host.inReach(follower.deviceId)) {
          follower.ack = null;
          return;
        }
        continue;
      }
      const oldest = (this.entries[0]?.seq ?? this.seq + 1) - 1;
      if (ack < oldest) {
        follower.ack = null;
        await this.fullCopy(follower);
        continue;
      }
      this.setPhase(follower, "sending");
      await this.sendBatch(follower, ack);
      this.trim();
      this.emit();
    }
  }

  private async sendBatch(follower: Follower, ack: number): Promise<void> {
    const changes: StandbyChange[] = [];
    let bytes = 0;
    // The batch is chosen once: a file touched again later in it is read
    // once, at its last touch, and nothing past the batch is passed over.
    const batch: Entry[] = [];
    const lastTouch = new Map<string, number>();
    for (const entry of this.entries) {
      if (entry.seq <= ack) continue;
      if (bytes >= PIECE || batch.length >= STANDBY_FILES_PER_ORDER) break;
      batch.push(entry);
      if (entry.kind === "touch") lastTouch.set(entry.path, entry.seq);
      bytes += entry.bytes;
    }
    bytes = 0;
    const sentNow = new Map<string, Known | null>();
    let last = ack;
    let lastAt = follower.ackAt ?? this.now();
    for (const entry of batch) {
      // Stopping early is safe: an entry left out is sent in the next batch,
      // and a later touch of the same file is still ahead of the copy.
      if (bytes >= PIECE) break;
      last = entry.seq;
      lastAt = entry.at;
      if (entry.kind === "pages") {
        const packed = readFileSync(join(this.host.stagingDir, "log", `${entry.seq}`));
        const base = {
          kind: "pages" as const,
          seq: entry.seq,
          at: entry.at,
          path: entry.path,
          pageSize: entry.pageSize,
          dbPages: entry.dbPages,
        };
        if (packed.length <= PIECE / 2) {
          changes.push({ ...base, pages: unpackToWire(packed, entry.pageSize) });
          bytes += packed.length;
        } else {
          const sha256 = await this.sendBlob(follower.deviceId, packed);
          changes.push({ ...base, blob: sha256 });
        }
        continue;
      }
      if (lastTouch.get(entry.path) !== entry.seq) continue;
      const change = await this.fileChange(follower, entry, sentNow);
      if (change) {
        changes.push(change);
        bytes += "data" in change && change.data ? change.data.length : 0;
      }
    }
    const answer = standbyOrders[STANDBY_APPLY_ORDER].response.parse(
      await this.host.ask(follower.deviceId, STANDBY_APPLY_ORDER, [
        { stream: this.stream, from: ack, through: last, at: lastAt, changes },
      ]),
    );
    if (!answer.ok) {
      follower.ack = null;
      throw new Error("its copy is not where the home thought; it is asked where it is");
    }
    follower.ack = answer.seq;
    follower.ackAt = lastAt;
    for (const [path, sent] of sentNow) {
      if (sent) follower.sent.set(path, sent);
      else follower.sent.delete(path);
    }
  }

  /** What a touched file is now, as a change: gone, added to, or whole. */
  private async fileChange(
    follower: Follower,
    entry: Extract<Entry, { kind: "touch" }>,
    sentNow: Map<string, Known | null>,
  ): Promise<StandbyChange | null> {
    const base = { seq: entry.seq, at: entry.at, path: entry.path };
    const abs = this.abs(entry.path);
    let size: number;
    try {
      const facts = lstatSync(abs);
      if (!facts.isFile()) throw new Error("not a file");
      size = facts.size;
    } catch {
      sentNow.set(entry.path, null);
      return { kind: "gone", ...base };
    }
    if (looksLikeDatabase(abs)) {
      let reading = this.readNow.get(entry.path);
      if (!reading) {
        reading = this.contentOf(entry.path).then((content) =>
          content
            ? {
                data: content.data,
                sha256: createHash("sha256").update(content.data).digest("hex"),
              }
            : null,
        );
        this.readNow.set(entry.path, reading);
      }
      const content = await reading;
      sentNow.set(entry.path, null);
      if (content === null) return { kind: "gone", ...base };
      return this.wholeChange(follower, base, content.data, content.sha256);
    }
    const before = follower.sent.get(entry.path);
    if (before && size > before.size && size - before.size <= PIECE / 2) {
      const grown = await this.grown(abs, before, size);
      if (grown) {
        sentNow.set(entry.path, grown.known);
        return {
          kind: "append",
          ...base,
          offset: before.size,
          data: grown.added.toString("base64"),
        };
      }
    }
    if (size <= PIECE / 2) {
      let data: Buffer;
      try {
        data = await readFile(abs);
      } catch {
        sentNow.set(entry.path, null);
        return { kind: "gone", ...base };
      }
      const known = knownOf(data);
      if (before?.sha256 === known.sha256) return null;
      sentNow.set(entry.path, known);
      return this.wholeChange(follower, base, data, known.sha256);
    }
    // A long file written anew: its own copy, read in pieces, so what is hashed is what crosses.
    const own = join(this.host.stagingDir, "now", randomUUID());
    mkdirSync(dirname(own), { recursive: true, mode: 0o700 });
    try {
      try {
        await copyFile(abs, own, constants.COPYFILE_FICLONE);
      } catch {
        sentNow.set(entry.path, null);
        return { kind: "gone", ...base };
      }
      const known = await knownFile(own);
      if (before?.sha256 === known.sha256) return null;
      sentNow.set(entry.path, known);
      await this.sendFileBlob(follower.deviceId, own, known.sha256, known.size);
      return { kind: "file", ...base, sha256: known.sha256, size: known.size };
    } finally {
      rmSync(own, { force: true });
    }
  }

  /**
   * What a file that only grew added since the copy's size, read alone: its
   * remembered last bytes must still be there, or the file was written anew.
   */
  private async grown(
    abs: string,
    before: Known,
    size: number,
  ): Promise<{ added: Buffer; known: Known } | null> {
    const from = before.size - before.tail.length;
    const buffer = Buffer.alloc(size - from);
    try {
      const handle = await open(abs, "r");
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        if (bytesRead !== buffer.length) return null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    if (!buffer.subarray(0, before.tail.length).equals(before.tail)) return null;
    const added = buffer.subarray(before.tail.length);
    const hash = before.hash.copy().update(added);
    return {
      added,
      known: { size, sha256: hash.copy().digest("hex"), tail: tailAfter(before.tail, added), hash },
    };
  }

  /** A whole file's content as a change: inline when it is small, or sent before as a blob. */
  private async wholeChange(
    follower: Follower,
    base: { seq: number; at: number; path: string },
    data: Buffer,
    sha256: string,
  ): Promise<StandbyChange> {
    if (data.length <= PIECE / 2)
      return { kind: "file", ...base, sha256, size: data.length, data: data.toString("base64") };
    await this.sendBlob(follower.deviceId, data);
    return { kind: "file", ...base, sha256, size: data.length };
  }

  /**
   * A file of the record as it is now, or null when it is gone. A database
   * is read through its own backup, in this process: SQLite keeps its locks
   * across its own handles, while a plain read of the database file here
   * would drop them.
   */
  private async contentOf(path: string): Promise<{ data: Buffer; database: boolean } | null> {
    const abs = this.abs(path);
    let facts: ReturnType<typeof lstatSync>;
    try {
      facts = lstatSync(abs);
    } catch {
      return null;
    }
    if (!facts.isFile()) return null;
    if (looksLikeDatabase(abs)) {
      const copy = join(this.host.stagingDir, "db", `${randomUUID()}`);
      mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
      try {
        const db = new Database(abs, { readonly: true, fileMustExist: true });
        try {
          await db.backup(copy);
        } finally {
          db.close();
        }
        return { data: readFileSync(copy), database: true };
      } catch {
        return null;
      } finally {
        rmSync(copy, { force: true });
      }
    }
    try {
      return { data: readFileSync(abs), database: false };
    } catch {
      return null;
    }
  }

  /** A blob in pieces, by its hash; answers the hash. */
  private async sendBlob(deviceId: string, data: Buffer): Promise<string> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    let offset = 0;
    do {
      const piece = data.subarray(offset, offset + PIECE);
      const answer = standbyOrders[STANDBY_PIECE_ORDER].response.parse(
        await this.host.ask(deviceId, STANDBY_PIECE_ORDER, [
          { sha256, size: data.length, offset, data: piece.toString("base64") },
        ]),
      );
      offset += piece.length;
      if (answer.complete) break;
    } while (offset < data.length);
    return sha256;
  }

  private async sendFileBlob(
    deviceId: string,
    abs: string,
    sha256: string,
    size: number,
  ): Promise<void> {
    const handle = await open(abs, "r");
    try {
      let offset = 0;
      do {
        const buffer = Buffer.alloc(Math.min(PIECE, size - offset));
        const { bytesRead } = buffer.length
          ? await handle.read(buffer, 0, buffer.length, offset)
          : { bytesRead: 0 };
        const answer = standbyOrders[STANDBY_PIECE_ORDER].response.parse(
          await this.host.ask(deviceId, STANDBY_PIECE_ORDER, [
            { sha256, size, offset, data: buffer.subarray(0, bytesRead).toString("base64") },
          ]),
        );
        offset += bytesRead;
        if (answer.complete || bytesRead === 0) break;
      } while (offset < size);
    } finally {
      await handle.close();
    }
  }

  /**
   * One full copy: in one turn, every log read to its end and each database
   * taken whole as of that change; then every file of the record. Only what
   * the copy lacks crosses; it is put in place at once, as of that change.
   */
  private async fullCopy(follower: Follower): Promise<void> {
    this.setPhase(follower, "copying");
    const dir = join(this.host.stagingDir, "full", follower.deviceId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      // One turn: nothing writes between the logs' end and each database taken whole.
      this.flush();
      const seq = this.seq;
      const stream = this.stream;
      const at = this.now();
      const taken: { path: string; abs: string }[] = [];
      for (const db of this.host.pagesDatabases()) {
        const abs = this.abs(db.path);
        if (!existsSync(abs)) continue;
        const reader = new Database(abs, { readonly: true, fileMustExist: true });
        let whole: Buffer;
        try {
          whole = reader.serialize();
        } finally {
          reader.close();
        }
        const to = join(dir, `${taken.length}.db`);
        writeFileSync(to, whole, { mode: 0o600 });
        taken.push({ path: db.path, abs: to });
      }
      const listed = (
        await listRecordInTurns(this.host.userData, this.host.claudeDir, { kinds: false })
      ).filter((entry) => !this.isPagesPath(entry.path));
      this.recordBytes =
        listed.reduce((sum, entry) => sum + entry.size, 0) +
        taken.reduce((sum, each) => sum + statSync(each.abs).size, 0);
      const files: (StandbyFile & { abs: string; database: boolean; known?: Known })[] = [];
      for (const each of taken) {
        files.push({
          path: each.path,
          abs: each.abs,
          size: statSync(each.abs).size,
          sha256: await hashFile(each.abs),
          database: true,
        });
      }
      const sent = new Map<string, Known>();
      for (const entry of listed) {
        if (looksLikeDatabase(entry.abs)) {
          const content = await this.contentOf(entry.path);
          if (!content) continue;
          const abs = join(dir, `${files.length}.file`);
          writeFileSync(abs, content.data, { mode: 0o600 });
          files.push({
            path: entry.path,
            abs,
            size: content.data.length,
            sha256: createHash("sha256").update(content.data).digest("hex"),
            database: true,
          });
          continue;
        }
        let known: Known;
        try {
          const facts = statSync(entry.abs);
          const kept = this.known.get(entry.path);
          if (kept && kept.size === facts.size && kept.mtimeMs === facts.mtimeMs) known = kept;
          else {
            known = await knownFile(entry.abs);
            this.known.set(entry.path, { ...known, mtimeMs: facts.mtimeMs });
          }
        } catch {
          continue;
        }
        files.push({
          path: entry.path,
          abs: entry.abs,
          size: known.size,
          sha256: known.sha256,
          database: false,
          known,
        });
      }
      const total = files.reduce((sum, file) => sum + file.size, 0);
      follower.total = total;
      follower.done = 0;
      this.emit();
      for (let start = 0; start < files.length; start += STANDBY_FILES_PER_ORDER) {
        const part = files.slice(start, start + STANDBY_FILES_PER_ORDER);
        const { lacks } = standbyOrders[STANDBY_LACKS_ORDER].response.parse(
          await this.host.ask(follower.deviceId, STANDBY_LACKS_ORDER, [
            { files: part.map(({ path, size, sha256 }) => ({ path, size, sha256 })) },
          ]),
        );
        const lacking = new Set(lacks);
        for (const [index, file] of part.entries()) {
          if (lacking.has(index)) {
            if (!file.database) {
              // Its own copy, so the hash and what crosses are one content, whatever the file is by now.
              const own = join(dir, `${start + index}.file`);
              try {
                copyFileSync(file.abs, own, constants.COPYFILE_FICLONE);
              } catch {
                writeFileSync(own, Buffer.alloc(0), { mode: 0o600 });
              }
              file.abs = own;
              file.known = await knownFile(own);
              file.size = file.known.size;
              file.sha256 = file.known.sha256;
            }
            await this.sendFileBlob(follower.deviceId, file.abs, file.sha256, file.size);
          }
          if (file.known) sent.set(file.path, file.known);
          follower.done += file.size;
          this.emit();
        }
      }
      const parts = Math.max(1, Math.ceil(files.length / STANDBY_FILES_PER_ORDER));
      for (let part = 0; part < parts; part++) {
        const slice = files.slice(
          part * STANDBY_FILES_PER_ORDER,
          (part + 1) * STANDBY_FILES_PER_ORDER,
        );
        const answer = standbyOrders[STANDBY_FULL_ORDER].response.parse(
          await this.host.ask(follower.deviceId, STANDBY_FULL_ORDER, [
            {
              stream,
              seq,
              at,
              part,
              last: part === parts - 1,
              files: slice.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
            },
          ]),
        );
        if (!answer.ok) throw new Error("its full copy did not take; it is taken again");
      }
      if (stream !== this.stream) {
        follower.ack = null;
        return;
      }
      follower.ack = seq;
      follower.ackAt = at;
      follower.sent = sent;
      follower.copyAt = at;
      this.keepTime(follower.deviceId, at);
      follower.done = undefined;
      follower.total = undefined;
      this.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The size of a full copy, as last measured: what a computer needs room for twice. */
  fullCopyBytes(): number {
    if (this.recordBytes > 0) return this.recordBytes;
    return listRecord(this.host.userData, this.host.claudeDir, { kinds: false }).reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
  }

  /** Stops everything: no watch, no send; SQLite folds its logs back by itself again. */
  dispose(): void {
    if (this.disposed) return;
    for (const follower of this.followers.values()) {
      if (follower.phase !== "away") this.keepCopyAt(follower.deviceId, follower.copyAt);
      follower.stopped = true;
      follower.wake?.();
    }
    this.followers.clear();
    this.deactivate();
    this.disposed = true;
    this.checkSettled();
    this.stopReach?.();
  }
}

/**
 * Whether a file is a database by its name or the files SQLite keeps beside
 * it, without opening it: a plain read of a database file in a process that
 * holds it would drop SQLite's locks there.
 */
function looksLikeDatabase(abs: string): boolean {
  if (/\.(db|sqlite|sqlite3)$/.test(abs)) return true;
  return DATABASE_SIDECARS.some((suffix) => existsSync(`${abs}${suffix}`));
}

function unpackToWire(packed: Buffer, pageSize: number): { pgno: number; data: string }[] {
  const pages: { pgno: number; data: string }[] = [];
  for (let at = 0; at + 4 + pageSize <= packed.length; at += 4 + pageSize)
    pages.push({
      pgno: packed.readUInt32BE(at),
      data: packed.subarray(at + 4, at + 4 + pageSize).toString("base64"),
    });
  return pages;
}

function isFolder(abs: string): boolean {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
}
