import type { Idle, Presence } from "@shared/channels/shell";

/**
 * The captain's answer to INF-7038's question 2: with the screen lit and
 * unlocked, this long without the keyboard or mouse counts as nobody here.
 */
export const UNTOUCHED_AWAY_MS = 5 * 60_000;

/**
 * The captain's answer to INF-7038's question 3: acting on a phone counts
 * as having left a computer, unless it was touched this long before.
 */
export const TOUCHED_BEFORE_PHONE_MS = 10_000;

/** How often the reading looks at the idle time again, which bounds how late it turns. */
export const READ_IDLE_EVERY_MS = 5_000;

export type AttendanceOptions = {
  /** This computer's presence and idle time (`PresenceWatch`, ./presence.ts). */
  presence: {
    presence(): Presence;
    idle(): Idle;
    listen(listener: (presence: Presence) => void): () => void;
  };
  /** Whether this program posts a card's notification on this computer itself (`HostNotifications.supported`). */
  postsNotices: () => boolean;
  now: () => number;
  /** Runs `run` every `ms` until the answer is called. */
  every?: (run: () => void, ms: number) => () => void;
};

/**
 * Whether someone is at this computer for the phone sender, as this window's
 * program reads it (docs/phone-push.md, "When the computer sends"): no away
 * reason holds, the keyboard or mouse was touched in the last
 * `UNTOUCHED_AWAY_MS`, no act on a phone since the last touch, and this
 * program would show a card here, in a window in front or a notification
 * it posts. A computer that cannot tell (`watched` false: Linux, an isolated
 * run) says it exactly while a window is in front, the rule before presence.
 */
export class Attendance {
  private inFront = false;
  /** When the captain acted on a phone with this computer untouched, until its next touch. */
  private phoneAt: number | undefined;
  private said: boolean;
  private readonly listeners = new Set<(here: boolean) => void>();
  private stops: (() => void)[] = [];

  constructor(private readonly options: AttendanceOptions) {
    this.said = this.read();
  }

  /** Starts following presence and the idle time. */
  start(): void {
    if (this.stops.length > 0) return;
    const every =
      this.options.every ??
      ((run, ms) => {
        const timer = setInterval(run, ms);
        timer.unref?.();
        return () => clearInterval(timer);
      });
    this.stops = [
      this.options.presence.listen(() => this.check()),
      every(() => this.check(), READ_IDLE_EVERY_MS),
    ];
  }

  stop(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  here(): boolean {
    return this.said;
  }

  /** Each change of `here`. */
  listen(listener: (here: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  front(inFront: boolean): void {
    this.inFront = inFront;
    this.check();
  }

  /** The first mate said the captain's input came from a paired phone or iPad. */
  phoneActed(): void {
    if (!this.options.presence.presence().watched) return;
    const now = this.options.now();
    if (this.lastTouch(now) >= now - TOUCHED_BEFORE_PHONE_MS) return;
    this.phoneAt = now;
    this.check();
  }

  private lastTouch(now: number): number {
    return now - this.options.presence.idle().seconds * 1000;
  }

  private read(): boolean {
    const presence = this.options.presence.presence();
    if (!presence.watched) return this.inFront;
    if (presence.away) return false;
    if (!this.inFront && !this.options.postsNotices()) return false;
    const now = this.options.now();
    const touched = this.lastTouch(now);
    if (this.phoneAt !== undefined) {
      if (touched <= this.phoneAt) return false;
      this.phoneAt = undefined;
    }
    return now - touched < UNTOUCHED_AWAY_MS;
  }

  private check(): void {
    const here = this.read();
    if (here === this.said) return;
    this.said = here;
    for (const listener of [...this.listeners]) listener(here);
  }
}
