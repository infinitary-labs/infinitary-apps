import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DeviceGrant,
  PAIRING_LINK_ALSO_MAX,
  STEPPED_DOWN_LINES,
  type SteppedDown,
} from "@shared/devices";
import type { OtherHome } from "@shared/standby";
import type { WebSocket } from "ws";
import { HomeLink } from "../devices/homeLink";
import { FIRST_HOME_NUMBER } from "../devices/homeNumber";
import { writePrivate } from "../devices/identity";
import type { ReturningIdentity } from "../devices/pairing";
import type { HomeHandOver } from "../homeMove/outgoing";
import { MOVED_AWAY_DIR } from "../homeMove/record";
import type { AppDatabase } from "../storage/db";

/** What a home's welcome said, heard at one copy's addresses. */
export type HeardHome = { homeNumber: number; takeOver: string | null; name: string | null };

/** One computer that keeps a copy of this home's record, as the home knows it. */
export type WatchedCopy = {
  deviceId: string;
  name: string;
  /** Where a first mate there would answer, should it take over. */
  addresses: string[];
  /** When its copy is from, as last known here. */
  copyAt: number | null;
  inReach: boolean;
};

/** The file beside a stepped-down home's set-aside record that lists what never reached the copy. */
export const NEVER_SENT_FILE = "never-sent.json";

export type StepDownOptions = {
  /**
   * Who this home dials the copies as: the Mac it was before it took over,
   * which every copy from before lists, or else the way back it made
   * (`DevicePairing.returningIdentity`); null while it has neither.
   */
  returning: () => ReturningIdentity | null;
  /** This home's own key's pin, which a home that took over shows too. */
  homeKey: () => string;
  homeNumber: () => number;
  /** Which takeover made this home; null for one a move or a first start made. */
  takeOver: () => string | null;
  copies: () => WatchedCopy[];
  /** Tells when a copy's reach changed. */
  onReach: (listener: () => void) => () => void;
  /** Dials with `grant` only to hear a home's welcome; null when nothing answered as a home. */
  hear: (grant: DeviceGrant) => Promise<HeardHome | null>;
  /** What changed here since `since`, which no copy holds. */
  neverSent: (since: number | null) => SteppedDown["lines"];
  /** The data folder, where a home that steps down sets its record aside. */
  userData: string;
  /** Stops the first mate here and opens this computer as a Mac of the home that took over. */
  stepDown: (handOver: HomeHandOver) => void;
  /** Another home answers with this one's number: acts that cannot be undone wait for the captain. */
  twoHomes: (other: { deviceId: string; name: string } | null) => void;
  log: (line: string) => void;
  now?: () => number;
  /** Waits before looking again while a copy is out of reach, each next one, staying at the last. */
  lookMs?: readonly number[];
};

/** Waits before looking again while a copy stays out of reach: each next one, staying at the last. */
const LOOK_MS = [1_000, 5_000, 15_000, 60_000] as const;

/**
 * An old home that returns (docs/devices.md, "An old home that returns"):
 * a computer that kept a copy may have taken over while this home was out
 * of its reach. While any copy is out of reach, and at start, the home dials
 * each copy where a first mate there would answer, as its own way back,
 * pinned to its own key, only to hear a welcome. A home there with a higher
 * number took over: this one lists what it saved after that copy, sets its
 * record aside and opens as a Mac of it, which keeps a copy from then on. A
 * home there with this home's own number is a second home: both wait before
 * any act that cannot be undone until the captain keeps one. Nothing here
 * takes over; it only steps down.
 */
export class StepDownWatch {
  private timer: NodeJS.Timeout | null = null;
  private tries = 0;
  private looking: Promise<void> | null = null;
  private again = false;
  private stopReach: (() => void) | null = null;
  private disposed = false;
  private steppedDown = false;
  /** The second home heard, while the captain has not kept one. */
  private second: { copy: WatchedCopy; heard: HeardHome } | null = null;

  constructor(private readonly options: StepDownOptions) {}

  start(): void {
    if (this.disposed || this.stopReach) return;
    this.stopReach = this.options.onReach(() => {
      this.tries = 0;
      this.look();
    });
    this.look();
  }

  dispose(): void {
    this.disposed = true;
    this.stopReach?.();
    this.stopReach = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The second home heard, while the captain has not kept one. */
  twoHomes(): { deviceId: string; name: string } | null {
    return this.second
      ? { deviceId: this.second.copy.deviceId, name: this.second.copy.name }
      : null;
  }

  /**
   * The captain's choice between two homes with one number: `here` keeps
   * this one, which takes the next number so the other steps down when it
   * hears it; the other's id steps this one down to it.
   */
  keep(choice: "here" | string, raise: (homeNumber: number) => void): boolean {
    const second = this.second;
    if (!second) return false;
    if (choice === "here") {
      raise(Math.max(this.options.homeNumber(), second.heard.homeNumber) + 1);
      this.second = null;
      this.options.twoHomes(null);
      return true;
    }
    if (choice !== second.copy.deviceId) return false;
    return this.down(second.copy, second.heard);
  }

  /**
   * A window heard another home with this home's number and another
   * takeover, which this home may not reach itself (docs/devices.md, "Two
   * homes with one number"): acts that cannot be undone wait and the captain
   * is asked, as for one this home heard. A copy that answers there is named
   * by its own id; the watch clears it only on hearing it answer otherwise.
   * True when it is held as the second home.
   */
  reported(other: OtherHome): boolean {
    if (this.disposed || this.steppedDown) return false;
    if (other.homeNumber !== this.options.homeNumber()) return false;
    if (other.takeOver === this.options.takeOver()) return false;
    if (this.second && this.second.heard.takeOver === other.takeOver) return true;
    // Only the first address is where the other home answered; the rest
    // list every copy it keeps, which may be another copy in reach here.
    const answered = other.addresses[0];
    const known = this.options.copies().find((copy) => copy.addresses.includes(answered ?? ""));
    const name = other.name ?? known?.name ?? other.addresses[0] ?? "";
    const copy: WatchedCopy = {
      deviceId: known?.deviceId ?? `home-${other.takeOver ?? other.homeNumber}`,
      name: name.slice(0, 160) || "Computer",
      addresses: other.addresses,
      copyAt: known?.copyAt ?? null,
      inReach: false,
    };
    this.options.log(`a window heard ${copy.name} answer as a home with this home's number`);
    this.second = {
      copy,
      heard: { homeNumber: other.homeNumber, takeOver: other.takeOver, name: other.name },
    };
    this.options.twoHomes({ deviceId: copy.deviceId, name: copy.name });
    return true;
  }

  /** Looks now, once at a time; a look asked meanwhile runs after it. */
  look(): void {
    if (this.disposed || this.steppedDown) return;
    if (this.looking) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.looking = this.lookOnce()
      .catch((error: unknown) =>
        this.options.log(`could not look for a home that took over: ${String(error)}`),
      )
      .finally(() => {
        this.looking = null;
        if (this.again) {
          this.again = false;
          this.look();
        } else this.later();
      });
  }

  private later(): void {
    if (this.disposed || this.steppedDown) return;
    const copies = this.options.copies();
    if (!copies.some((copy) => !copy.inReach && copy.addresses.length > 0)) return;
    const waits = this.options.lookMs ?? LOOK_MS;
    const wait = waits[Math.min(this.tries, waits.length - 1)] ?? 60_000;
    this.tries += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.look();
    }, wait);
    this.timer.unref?.();
  }

  private async lookOnce(): Promise<void> {
    const returning = this.options.returning();
    if (!returning) return;
    const own = this.options.homeNumber();
    const ownTakeOver = this.options.takeOver();
    let secondSeen: { copy: WatchedCopy; heard: HeardHome } | null = null;
    // Whether the second home heard before still answers as one; unknown while it cannot be heard.
    const before = this.second;
    let secondStays = before !== null;
    for (const copy of this.options.copies()) {
      if (this.disposed || this.steppedDown) return;
      const isSecond = copy.deviceId === before?.copy.deviceId;
      // A copy this home reaches has not taken over: it refuses while its home answers it.
      if (copy.inReach) {
        if (isSecond) secondStays = false;
        continue;
      }
      if (copy.addresses.length === 0) continue;
      const [at, ...also] = copy.addresses as [string, ...string[]];
      const heard = await this.options
        .hear({
          at,
          ...(also.length ? { also: also.slice(0, PAIRING_LINK_ALSO_MAX) } : {}),
          homeKey: this.options.homeKey(),
          deviceId: returning.deviceId,
          kind: "mac",
          key: returning.key,
          cert: returning.cert,
        })
        .catch(() => null);
      if (!heard) continue;
      if (heard.homeNumber > own) {
        this.down(copy, heard);
        return;
      }
      const second = heard.homeNumber === own && heard.takeOver !== ownTakeOver;
      if (second) secondSeen = { copy, heard };
      else if (isSecond) secondStays = false;
    }
    // A second home a window reported while this look ran is not this look's to clear.
    if (before && this.second === before && !secondStays && !secondSeen) {
      this.options.log(`${this.second.copy.name} no longer answers as a second home`);
      this.second = null;
      this.options.twoHomes(null);
    }
    if (secondSeen && this.second?.copy.deviceId !== secondSeen.copy.deviceId) {
      this.options.log(`${secondSeen.copy.name} answers as a home with this home's number`);
      this.second = secondSeen;
      this.options.twoHomes({ deviceId: secondSeen.copy.deviceId, name: secondSeen.copy.name });
    }
  }

  /** Lists what never reached that copy, and opens this computer as a Mac of the home there. */
  private down(copy: WatchedCopy, heard: HeardHome): boolean {
    const returning = this.options.returning();
    if (!returning || this.steppedDown) return false;
    this.steppedDown = true;
    const now = this.options.now ?? Date.now;
    const name = (heard.name ?? copy.name).slice(0, 160) || copy.name;
    const move = `took-over-${heard.takeOver ?? heard.homeNumber}`;
    let lines: SteppedDown["lines"] = [];
    try {
      lines = this.options.neverSent(copy.copyAt);
    } catch (error) {
      this.options.log(`could not list what never reached ${copy.name}: ${String(error)}`);
    }
    const steppedDown: SteppedDown = { from: name, at: now(), since: copy.copyAt, lines };
    try {
      const aside = join(this.options.userData, MOVED_AWAY_DIR, move);
      mkdirSync(aside, { recursive: true, mode: 0o700 });
      writePrivate(join(aside, NEVER_SENT_FILE), `${JSON.stringify(steppedDown, null, 2)}\n`);
    } catch (error) {
      this.options.log(`could not keep what never reached ${copy.name}: ${String(error)}`);
    }
    const [at, ...also] = copy.addresses as [string, ...string[]];
    this.options.log(`${name} took over as home ${heard.homeNumber}; this home steps down`);
    this.options.stepDown({
      move,
      homeNumber: heard.homeNumber,
      name,
      grant: {
        at,
        ...(also.length ? { also: also.slice(0, PAIRING_LINK_ALSO_MAX) } : {}),
        homeKey: this.options.homeKey(),
        deviceId: returning.deviceId,
        kind: "mac",
        key: returning.key,
        cert: returning.cert,
      },
      steppedDown,
    });
    return true;
  }
}

/**
 * What changed on this home after `since`, which no copy holds: the newest
 * task feed lines, each with its task's title. All of them when the copy's
 * time is unknown.
 */
export function neverSentLines(db: AppDatabase, since: number | null): SteppedDown["lines"] {
  const rows = db
    .prepare(
      `SELECT e.task_id AS taskId, e.at AS at, e.text AS text, t.title AS title
         FROM task_events e JOIN tasks t ON t.id = e.task_id
        WHERE e.feed = 1 AND e.at > ?
        ORDER BY e.at DESC, e.id DESC
        LIMIT ?`,
    )
    .all(since ?? 0, STEPPED_DOWN_LINES) as {
    taskId: string;
    at: number;
    text: string;
    title: string;
  }[];
  return rows.map((row) => ({
    task: row.title.slice(0, 160),
    at: row.at,
    text: row.text.slice(0, 300),
  }));
}

/**
 * Dials with `grant` once, only to hear the welcome of whatever home
 * answers there with this home's key: its number, the takeover that made
 * it, and its name. Null when nothing answered as a home. Its hello says it
 * only hears, so the home there counts nothing of it as in reach.
 */
export function hearHomeAs(
  grant: DeviceGrant,
  dial: (grant: DeviceGrant) => Promise<WebSocket>,
): Promise<HeardHome | null> {
  return new Promise((resolve) => {
    let settled = false;
    let homeNumber = FIRST_HOME_NUMBER;
    let takeOver: string | null = null;
    const link = new HomeLink({
      grant,
      as: "work",
      dial,
      nameOnly: true,
      onPush: () => {},
      homeNumber: FIRST_HOME_NUMBER,
      onHomeNumber: (heard) => {
        homeNumber = heard;
      },
      onTakeOver: (heard) => {
        takeOver = heard.id;
      },
      onState: (state) => {
        if (settled || state.contact === "reaching") return;
        settled = true;
        link.close();
        resolve(state.contact === "in-reach" ? { homeNumber, takeOver, name: state.name } : null);
      },
    });
    link.start();
  });
}
