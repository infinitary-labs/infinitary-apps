import {
  constants,
  copyFileSync,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOME_MOVE_MANIFEST, type HomeMoveManifest } from "@shared/homeMove";
import {
  type StandbyTakeOver,
  standbyTakeOverSchema,
  type TakeOverAnswer,
  type TakeOverAsk,
  takeOverAnswerSchema,
  takeOverAskSchema,
} from "@shared/standby";
import {
  COPY_FILES_ORDER,
  COPY_PIECE_ORDER,
  COPY_WHERE_ORDER,
  type CopyOrderChannel,
  copyOrders,
} from "@shared/standbyPeers";
import type { PhoneOffer } from "@shared/standbyPhone";
import { z } from "zod";
import { writePrivate } from "../devices/identity";
import { hashFile } from "../homeMove/record";
import { readStandbyHome, readStandbyState, STANDBY_COPY, STANDBY_DIR } from "./keeper";
import { TAKE_OVER_WORDS } from "./words";

/** The window's ask, in the work folder, which the work running there answers. */
export const TAKE_OVER_ASK = "take-over-ask.json";
export const TAKE_OVER_ANSWER = "take-over-answer.json";
/**
 * How often the ask and its answer are read again beside the folder's
 * watch, which may miss a change: a file read, so a missed report delays a
 * takeover by at most this long instead of leaving it unanswered.
 */
export const TAKE_OVER_LOOK_MS = 1_000;

export type FolderWatch = (dir: string, changed: () => void) => FSWatcher;
export const folderWatch: FolderWatch = (dir, changed) => watch(dir, () => changed());
/** Which takeover made this home, in its record (`standbyTakeOverSchema`). */
export const TAKE_OVER_RECORD = "devices/take-over.json";
/** The identity an old home keeps to find the home that took over, named in its record. */
export const RETURNING_RECORD = "devices/returning.json";
const STANDBYS_RECORD = "devices/standbys.json";

/** The returning identity's entry, as its home names it in the record (`ReturningIdentity`). */
export const returningSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1).max(64),
});

export function readTakeOver(userData: string): StandbyTakeOver | null {
  try {
    return standbyTakeOverSchema.parse(
      JSON.parse(readFileSync(join(userData, ...TAKE_OVER_RECORD.split("/")), "utf8")),
    );
  } catch {
    return null;
  }
}

export function readTakeOverAsk(workDir: string): TakeOverAsk | null {
  try {
    return takeOverAskSchema.parse(JSON.parse(readFileSync(join(workDir, TAKE_OVER_ASK), "utf8")));
  } catch {
    return null;
  }
}

export function readTakeOverAnswer(workDir: string): TakeOverAnswer | null {
  try {
    return takeOverAnswerSchema.parse(
      JSON.parse(readFileSync(join(workDir, TAKE_OVER_ANSWER), "utf8")),
    );
  } catch {
    return null;
  }
}

export function writeTakeOverAsk(workDir: string, ask: TakeOverAsk): void {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writePrivate(join(workDir, TAKE_OVER_ASK), `${JSON.stringify(ask)}\n`);
}

/**
 * What a phone hears Take over is based on here (docs/devices.md, "Taking
 * over from a phone"), as this computer's own window shows it: its copy,
 * the home as this computer hears it, every other copy as the home last
 * said it, and its answer to the last ask.
 */
export function phoneOffer(options: {
  workDir: string;
  /** This computer's id on the home's list: the other copies are every one but it. */
  deviceId: string;
  home: { contact: PhoneOffer["home"]["contact"]; heardAt: number | null; slept: boolean };
  homeNumber: number;
}): PhoneOffer {
  const { workDir } = options;
  const copy = readStandbyState(workDir);
  const home = readStandbyHome(workDir);
  const answer = readTakeOverAnswer(workDir);
  return {
    copyAt: copy.stream && copy.at !== null ? copy.at : null,
    home: {
      name: home?.name ?? null,
      contact: options.home.contact,
      heardAt: options.home.heardAt,
      slept: options.home.slept && options.home.contact !== "in-reach",
    },
    homeNumber: Math.max(1, options.homeNumber),
    copies: (home?.copies ?? [])
      .filter((each) => each.deviceId !== options.deviceId)
      .slice(0, 64)
      .map((each) => ({
        name: each.name,
        copyAt: each.copyAt,
        newer: each.seq !== null && each.seq > copy.seq,
      })),
    ready: home !== null,
    asked: answer ? { state: answer.state, text: answer.text } : null,
  };
}

/**
 * A phone's Take over, already confirmed there with Face ID or the
 * passcode: written as this computer's own window writes its ask, unless
 * this ask was written before, as when a dropped link asks it again.
 * Resolves with the work's answer once it started the first mate or
 * refused; the work answers every ask, so nothing here times it out.
 */
export function askTakeOver(
  workDir: string,
  id: string,
  options: { look: () => void; now?: () => number; lookMs?: number },
): Promise<{ state: TakeOverAnswer["state"]; text: string }> {
  const settled = () => {
    const answer = readTakeOverAnswer(workDir);
    return answer?.id === id && answer.state !== "running"
      ? { state: answer.state, text: answer.text }
      : null;
  };
  const before = settled();
  if (before) return Promise.resolve(before);
  if (readTakeOverAsk(workDir)?.id !== id)
    writeTakeOverAsk(workDir, { version: 1, id, at: (options.now ?? Date.now)() });
  options.look();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const answer = settled();
      if (!answer) return;
      clearInterval(timer);
      resolve(answer);
    }, options.lookMs ?? TAKE_OVER_LOOK_MS);
  });
}

export type TakeOverHereOptions = {
  /** The work folder, which holds the copy and the window's ask. */
  workDir: string;
  /** This computer, as the home's list names it; null before it joined. */
  own: () => Promise<{ deviceId: string; name: string } | null>;
  /** The highest home number this computer heard. */
  homeNumber: () => number;
  /** Whether the home answers this computer now. */
  inReach: () => boolean;
  /** The arrive of a laid-out takeover (`IncomingHomeMove.takeOver`), and where it lays its files. */
  arrive: (order: {
    move: string;
    homeNumber: number;
    manifestSha256: string;
  }) => Promise<{ addresses: string[] }>;
  filesOf: (move: string) => string;
  /**
   * Takes up a takeover a restart cut short (`IncomingHomeMove.recover`):
   * its addresses and home number when its first mate is in place here, or
   * null once it is undone.
   */
  recover?: (move: string) => Promise<{ addresses: string[]; homeNumber: number } | null>;
  /**
   * The other copies reached over their links now (docs/devices.md,
   * "Copies that reach each other"), asked where each stands so a newer
   * one is brought in first; absent, this copy is taken as it is.
   */
  copies?: {
    inReach: () => { deviceId: string; name: string; gathers: boolean }[];
    ask: (deviceId: string, channel: CopyOrderChannel, args: unknown[]) => Promise<unknown>;
  };
  /** The first mate started here: this computer's own work dials it from now on. */
  started: (addresses: string[], homeNumber: number) => void;
  log: (line: string) => void;
  now?: () => number;
  watch?: FolderWatch;
  /** How often the ask is read again beside the watch (`TAKE_OVER_LOOK_MS`). */
  lookMs?: number;
};

/**
 * A computer that keeps a copy taking over as the home (docs/devices.md,
 * "Taking over"). Only the window's ask starts it, written after the
 * captain confirmed the click on that computer (Touch ID or the password on
 * a Mac, Windows Hello or the Windows password on a Windows PC): nothing here
 * decides by itself, and no timer does. It refuses while the home answers
 * this computer, lays the copy out as a move's files, with what the home
 * last told it beside the record, and arrives as a move does, with the next
 * home number. A refusal or a failure leaves the copy as it was.
 */
export class TakeOverHere {
  private watcher: FSWatcher | null = null;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly options: TakeOverHereOptions) {}

  start(): void {
    try {
      // The ask lands by a rename from a temporary name, which the watch may
      // report by either name: any change in the folder is looked at.
      this.watcher = (this.options.watch ?? folderWatch)(this.options.workDir, () => this.look());
      this.watcher.on("error", () => {});
    } catch (error) {
      this.options.log(`could not watch for a takeover: ${String(error)}`);
    }
    // The watch may miss the ask's rename; reading it again finds it all the same.
    this.timer = setInterval(() => this.look(), this.options.lookMs ?? TAKE_OVER_LOOK_MS);
    this.timer.unref?.();
    this.look();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * An ask not yet answered is taken up, once. One still answered as
   * running when nothing runs here was cut short by a restart: it is
   * settled or undone, and answered.
   */
  look(): void {
    if (this.running || this.disposed) return;
    const ask = readTakeOverAsk(this.options.workDir);
    if (!ask) return;
    const answered = readTakeOverAnswer(this.options.workDir);
    if (answered?.id === ask.id && answered.state !== "running") return;
    const run = answered?.id === ask.id ? this.recover(ask) : this.run(ask);
    this.running = run.finally(() => {
      this.running = null;
      // Another ask written meanwhile.
      this.look();
    });
  }

  private answer(id: string, state: TakeOverAnswer["state"], text: string): void {
    writePrivate(
      join(this.options.workDir, TAKE_OVER_ANSWER),
      `${JSON.stringify({ version: 1, id, state, text: text.slice(0, 600) })}\n`,
    );
  }

  private async run(ask: TakeOverAsk): Promise<void> {
    const { workDir } = this.options;
    const words = TAKE_OVER_WORDS;
    const now = this.options.now ?? Date.now;
    this.answer(ask.id, "running", words.running);
    const home = readStandbyHome(workDir);
    const copy = readStandbyState(workDir);
    const own = await this.options.own();
    const refused = this.options.inReach()
      ? words.homeInReach(home?.name ?? null)
      : !copy.stream || copy.at === null || !existsSync(join(workDir, STANDBY_DIR, STANDBY_COPY))
        ? words.noCopy
        : !home
          ? words.homeNeverTold
          : !own
            ? words.notJoined
            : null;
    if (refused || !home || !own || !copy.stream) {
      this.answer(ask.id, "refused", refused ?? words.noCopy);
      return;
    }
    const move = ask.id;
    const files = this.options.filesOf(move);
    const homeNumber = Math.max(home.homeNumber, this.options.homeNumber()) + 1;
    const ownCopy = join(workDir, STANDBY_DIR, STANDBY_COPY);
    try {
      rmSync(files, { recursive: true, force: true });
      // A newer copy on another computer in reach is brought in first; the
      // copy here stays as it is: its files are cloned where the disk can,
      // copied where not.
      const newer = await this.newest(copy as Where, homeNumber);
      const brought = newer ? await this.bringIn(newer, ownCopy, files) : null;
      const paths = brought ? brought.paths : lay(ownCopy, files);
      const at = (path: string) => join(files, ...path.split("/"));
      // The new home keeps no copy of itself, and names the old one's way back a copy to keep.
      keepCopiesBut(at(STANDBYS_RECORD), own.deviceId, at(RETURNING_RECORD));
      const takeOver: StandbyTakeOver = {
        version: 1,
        id: ask.id,
        at: now(),
        homeNumber,
        deviceId: own.deviceId,
        name: own.name.slice(0, 64) || "Computer",
        stream: brought?.stream ?? copy.stream,
        seq: brought?.seq ?? copy.seq,
      };
      mkdirSync(dirname(at(TAKE_OVER_RECORD)), { recursive: true, mode: 0o700 });
      writePrivate(at(TAKE_OVER_RECORD), `${JSON.stringify(takeOver)}\n`);
      if (!paths.includes(TAKE_OVER_RECORD)) paths.push(TAKE_OVER_RECORD);
      const listed: HomeMoveManifest["files"] = [];
      for (const path of paths) {
        if (!existsSync(at(path))) continue;
        listed.push({ path, size: statSync(at(path)).size, sha256: await hashFile(at(path)) });
      }
      const manifest: HomeMoveManifest = {
        version: 1,
        files: listed,
        projects: home.projects.map((project) => ({ ...project })),
        from: home.from,
        name: home.name,
        signIns: home.signIns,
      };
      writePrivate(join(files, HOME_MOVE_MANIFEST), `${JSON.stringify(manifest)}\n`);
      const manifestSha256 = await hashFile(join(files, HOME_MOVE_MANIFEST));
      const arrived = await this.options.arrive({ move, homeNumber, manifestSha256 });
      this.options.started(arrived.addresses, homeNumber);
      this.options.log(`took over as the home from the copy, as home ${homeNumber}`);
      this.answer(
        ask.id,
        "started",
        brought ? words.startedNewer(home.name, brought.name) : words.started(home.name),
      );
    } catch (error) {
      this.options.log(`could not take over: ${String(error)}`);
      rmSync(dirname(files), { recursive: true, force: true });
      this.answer(
        ask.id,
        "refused",
        error instanceof Refused
          ? error.message
          : words.failed(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Settles or undoes a takeover a restart cut short, and answers it. */
  private async recover(ask: TakeOverAsk): Promise<void> {
    const words = TAKE_OVER_WORDS;
    try {
      const recovered = this.options.recover ? await this.options.recover(ask.id) : null;
      rmSync(dirname(this.options.filesOf(ask.id)), { recursive: true, force: true });
      if (!recovered) {
        this.answer(ask.id, "refused", words.cutShort);
        return;
      }
      const { homeNumber } = recovered;
      this.options.started(recovered.addresses, homeNumber);
      this.options.log(`took over as the home after a restart, as home ${homeNumber}`);
      this.answer(ask.id, "started", words.restarted);
    } catch (error) {
      this.options.log(`could not settle a takeover cut short: ${String(error)}`);
      this.answer(
        ask.id,
        "refused",
        words.failed(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * The newest copy among the others in reach, when it is newer than this
   * one (docs/devices.md, "Bringing in a newer copy"). A copy that heard a
   * home number as high as the one this takeover would claim heard another
   * takeover, so this one is refused.
   */
  private async newest(
    own: Where,
    claim: number,
  ): Promise<{ deviceId: string; name: string; where: Where } | null> {
    const copies = this.options.copies;
    if (!copies) return null;
    let newest: { deviceId: string; name: string; where: Where; gathers: boolean } | null = null;
    for (const other of copies.inReach()) {
      let where: z.infer<(typeof copyOrders)[typeof COPY_WHERE_ORDER]["response"]>;
      try {
        where = copyOrders[COPY_WHERE_ORDER].response.parse(
          await copies.ask(other.deviceId, COPY_WHERE_ORDER, []),
        );
      } catch (error) {
        this.options.log(`could not ask ${other.deviceId} where its copy stands: ${String(error)}`);
        continue;
      }
      if (where.homeNumber >= claim) throw new Refused(TAKE_OVER_WORDS.otherTookOver(other.name));
      if (newerThan(where, newest?.where ?? own)) newest = { ...other, where };
    }
    if (!newest) return null;
    if (!newest.gathers) throw new Refused(TAKE_OVER_WORDS.newerCannotGive(newest.name));
    return newest;
  }

  /**
   * Brings in the other copy's files as the move's files: a file the same
   * here is cloned from this copy, any other is read from that computer
   * piece by piece and checked against its hash. A copy that moved on while
   * it was read still hears its home, so taking over is refused.
   */
  private async bringIn(
    from: { deviceId: string; name: string; where: Where },
    ownCopy: string,
    to: string,
  ): Promise<{ paths: string[]; stream: string | null; seq: number; name: string }> {
    const copies = this.options.copies;
    if (!copies) throw new Refused(TAKE_OVER_WORDS.newerCannotGive(from.name));
    const moved = () => new Refused(TAKE_OVER_WORDS.newerMoved(from.name));
    const listed: { path: string; size: number; sha256: string }[] = [];
    let first: { stream: string | null; seq: number } | null = null;
    for (let page: number | null = 0; page !== null; ) {
      const answer = copyOrders[COPY_FILES_ORDER].response.parse(
        await copies.ask(from.deviceId, COPY_FILES_ORDER, [{ from: page }]),
      );
      first ??= { stream: answer.stream, seq: answer.seq };
      if (answer.stream !== first.stream || answer.seq !== first.seq) throw moved();
      listed.push(...answer.files);
      page = answer.next;
    }
    if (!first || first.stream !== from.where.stream || first.seq !== from.where.seq) throw moved();
    const paths: string[] = [];
    for (const file of listed) {
      const dest = join(to, ...file.path.split("/"));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      const here = join(ownCopy, ...file.path.split("/"));
      if (
        existsSync(here) &&
        statSync(here).size === file.size &&
        (await hashFile(here)) === file.sha256
      )
        copyFileSync(here, dest, constants.COPYFILE_FICLONE);
      else await this.fetch(from.deviceId, file, dest);
      if ((await hashFile(dest)) !== file.sha256) throw moved();
      paths.push(file.path);
    }
    const after = copyOrders[COPY_WHERE_ORDER].response.parse(
      await copies.ask(from.deviceId, COPY_WHERE_ORDER, []),
    );
    if (after.stream !== first.stream || after.seq !== first.seq) throw moved();
    this.options.log(`brought in the newer copy on ${from.deviceId}, at change ${first.seq}`);
    return { paths, stream: first.stream, seq: first.seq, name: from.name };
  }

  private async fetch(
    deviceId: string,
    file: { path: string; size: number },
    dest: string,
  ): Promise<void> {
    const copies = this.options.copies;
    if (!copies) return;
    const handle = await open(dest, "w", 0o600);
    try {
      for (let offset = 0; offset < file.size; ) {
        const { data } = copyOrders[COPY_PIECE_ORDER].response.parse(
          await copies.ask(deviceId, COPY_PIECE_ORDER, [{ path: file.path, offset }]),
        );
        const bytes = Buffer.from(data, "base64");
        if (bytes.length === 0) break;
        await handle.write(bytes, 0, bytes.length, offset);
        offset += bytes.length;
      }
    } finally {
      await handle.close();
    }
  }
}

type Where = { stream: string | null; seq: number; at: number | null };

/** Whether copy `a` holds changes `b` lacks: a later save, or more of one stream. */
function newerThan(a: Where, b: Where): boolean {
  if (a.stream === null || a.at === null) return false;
  if (b.stream === null || b.at === null) return true;
  return a.stream === b.stream ? a.seq > b.seq : a.at > b.at;
}

/** A copy refused for taking over: its words say why. */
class Refused extends Error {}

/**
 * Lays the copy out in `to` as a move's files, file by file, cloned on a
 * disk that can and copied where not, and answers each record path.
 */
function lay(from: string, to: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, path);
      else if (entry.isFile()) {
        const dest = join(to, ...path.split("/"));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        copyFileSync(abs, dest, constants.COPYFILE_FICLONE);
        paths.push(path);
      }
    }
  };
  walk(from, "");
  return paths;
}

/**
 * The copies the new home keeps: every one the old home named but this
 * computer, and the old home's own way back, so a returned old home keeps a
 * copy once it found the new one.
 */
function keepCopiesBut(file: string, own: string, returningFile: string): void {
  let standbys: {
    version: 1;
    standbys: { deviceId: string; copyAt: number | null }[];
    dropping?: unknown;
  };
  try {
    standbys = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(standbys.standbys)) throw new Error("not a list");
  } catch {
    standbys = { version: 1, standbys: [] };
  }
  standbys.standbys = standbys.standbys.filter((each) => each.deviceId !== own);
  try {
    const returning = returningSchema.parse(JSON.parse(readFileSync(returningFile, "utf8")));
    if (!standbys.standbys.some((each) => each.deviceId === returning.deviceId))
      standbys.standbys.push({ deviceId: returning.deviceId, copyAt: null });
  } catch {
    // An old home from before keeps no way back.
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writePrivate(file, `${JSON.stringify(standbys)}\n`);
}
