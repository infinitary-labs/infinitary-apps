// The black hole's rush: while the Firstmate winds itself into the pretend
// black hole (../blackhole.ts), every crewmate on the orbits races around
// at many times its speed, then coasts back to its usual pace as the disk
// unwinds. The captain's ask: "when firstmate character is doing the
// blackhole fidget animation, it should drastically speed up all the orbital
// crewmates like crazy"; the settings are the ones the captain tuned on the
// playable preview (Build it, 2026-10-01).
//
// The character publishes when its black hole began and when it stopped;
// the orbit (./orbit.ts) reads the level each frame. Both run on stage time
// (../stageClock.ts), so the pointer's slowdown and pause apply to the rush
// as to everything else. DOM-free and time-injected; the shared instance is
// a module ref like the stage clock, never store state.

import { BH_SCHEDULE } from "../blackhole";
import { clamp01, easeInOut } from "../face";

export const CREW_RUSH = {
  /** The crew's travel at the height of the rush, times normal. */
  peak: 36,
  /** From the start of the wind-up to the top speed, ms. */
  rampMs: 1600,
  /** From the start of the unwind (or the moment it is cut short) back to normal, ms. */
  settleMs: 2000,
  /** The share of the travel boost a crewmate's own spin takes, so its solid still reads. */
  spinShare: 0.25,
  /** A speed streak covers the arc travelled in this long, s. */
  streakSeconds: 0.06,
  /** The longest speed streak, rad. */
  streakMaxRad: 1.5,
} as const;

/** A streak shorter than this is not drawn, rad. */
const STREAK_MIN_RAD = 0.02;

/**
 * How far behind a crewmate its speed streak reaches along its own orbit, in
 * radians, at an angular speed (rad/s, the rush included) and a rush level.
 * Zero when the streak would be too short to see.
 */
export function streakArc(radPerSec: number, level: number): number {
  const arc =
    Math.min(CREW_RUSH.streakMaxRad, Math.abs(radPerSec) * CREW_RUSH.streakSeconds) * level;
  return arc < STREAK_MIN_RAD ? 0 : arc;
}

export class CrewRush {
  /** Stage time the latest black hole began, or null before the first. */
  private startAt: number | null = null;
  /** Its wind-up and unwind, ms after it began. */
  private windMs = 0;
  private unwindMs = 0;
  /** Stage time the settle began early because the black hole was cut short. */
  private cutAt: number | null = null;
  /** The level when this black hole began: a rush still settling carries on from there. */
  private from = 0;
  private active = false;

  /**
   * The black hole is playing: it began at stage time `startAt` and lasts
   * `durationMs`. Called every frame it plays; a start that moves (a pinned
   * emote's clock) moves the rush with it.
   */
  playing(startAt: number, durationMs: number, now: number): void {
    if (!this.active) {
      this.from = this.level(now);
      this.active = true;
      this.cutAt = null;
    }
    this.startAt = startAt;
    this.windMs = BH_SCHEDULE.windAt * durationMs;
    this.unwindMs = BH_SCHEDULE.unwindAt * durationMs;
  }

  /**
   * The black hole is not playing. Ending on its own changes nothing - the
   * settle began with the unwind - but one cut short (attention, a turn
   * starting) starts the settle now.
   */
  stopped(now: number): void {
    if (!this.active) return;
    this.active = false;
    if (this.startAt !== null && now - this.startAt < this.unwindMs) this.cutAt = now;
  }

  /** 0 at the crew's normal pace, 1 at the top speed. */
  level(now: number): number {
    if (this.startAt === null) return 0;
    const since = now - this.startAt;
    const settleFrom = this.cutAt === null ? this.unwindMs : this.cutAt - this.startAt;
    const up = (t: number) =>
      this.from + (1 - this.from) * easeInOut(clamp01((t - this.windMs) / CREW_RUSH.rampMs));
    if (since < settleFrom) return up(since);
    return up(settleFrom) * (1 - easeInOut(clamp01((since - settleFrom) / CREW_RUSH.settleMs)));
  }
}

/** The one rush the home stage shares: the character writes it, the orbit reads it. */
export const crewRush = new CrewRush();
