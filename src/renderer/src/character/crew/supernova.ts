// The crew's part in the supernova fidget (../supernova.ts): the flash
// lights every crewmate circling the first mate at once, and the blast's
// front kicks each one outward as it passes - a damped swing, weaker
// farther out - that ends on the crewmate's own seat. Crew on other
// computers stay in their own groups and stay still, as they do during the
// warps (./warp.ts).
//
// The character publishes when its supernova began and when it stopped;
// the orbit (./orbit.ts) and the crew canvases (./CrewOrbit.tsx) read the
// frame each frame. Both run on stage time (../stageClock.ts). DOM-free and
// time-injected; the shared instance is a module ref like the warp's.

import { clamp01, easeInOut } from "../face";
import { SUPERNOVA, type SupernovaFrame, snFlash, snFrontAt } from "../supernova";
import type { CrewmateFrame } from "./orbit";
import { WARP_RELEASE_MS } from "./warp";

/** The peak of sin(pi x) e^(-2.4 x) on 0..1, so the swing's peak is the whole kick. */
const SWING_PEAK = 0.394;

export class CrewSupernova {
  private startAt = 0;
  private coreR = 81;
  private heat = 0;
  private active = false;
  private playedAt: number | null = null;
  /** Stage time and progress at which a supernova was cut short, else null. */
  private cut: { at: number; et: number } | null = null;

  /**
   * The supernova is playing: it began at stage time `startAt`. Called every
   * frame it plays, with the first mate's radius and ember; a start that
   * moves (a pinned emote's clock) moves the blast with it.
   */
  playing(startAt: number, coreR: number, heat: number): void {
    this.startAt = startAt;
    this.coreR = coreR;
    this.heat = heat;
    this.active = true;
    this.playedAt = startAt;
    this.cut = null;
  }

  /** No supernova is playing. One cut short lets the crew go home over a warp's release. */
  stopped(now: number): void {
    if (!this.active) return;
    this.active = false;
    const et = (now - this.startAt) / SUPERNOVA.durationMs;
    if (et < 1) this.cut = { at: now, et };
    else this.playedAt = null;
  }

  frame(now: number): SupernovaFrame | null {
    if (this.playedAt === null) return null;
    let et = (now - this.startAt) / SUPERNOVA.durationMs;
    let release = 1;
    if (!this.active) {
      if (!this.cut) return null;
      release = 1 - easeInOut(clamp01((now - this.cut.at) / WARP_RELEASE_MS));
      et = this.cut.et;
      if (release <= 0) {
        this.playedAt = null;
        this.cut = null;
        return null;
      }
    } else if (et >= 1 || et < 0) return null;
    return { et, t: now / 1000, release, coreR: this.coreR, heat: this.heat };
  }
}

/** The one supernova the home stage shares: the character writes it, the orbit and the crew canvases read it. */
export const crewSupernova = new CrewSupernova();

/**
 * How far the front's kick has a crewmate `d` px from the center out, in
 * px, at a frame. Zero before the front reaches it and once its swing has
 * settled, so every crewmate ends on its own seat.
 */
export function supernovaKick(d: number, s: SupernovaFrame): number {
  const reach = SUPERNOVA.reachPx;
  if (d >= reach || SUPERNOVA.crewKickPx <= 0) return 0;
  const x = ((s.et - snFrontAt(d / reach)) * SUPERNOVA.durationMs) / SUPERNOVA.kickMs;
  if (x <= 0 || x >= 2) return 0;
  const swing = (Math.sin(Math.PI * x) * Math.exp(-2.4 * x)) / SWING_PEAK;
  return SUPERNOVA.crewKickPx * swing * (1 - (0.5 * d) / reach) * s.release;
}

/**
 * Light and kick one crewmate circling the first mate, in screen space,
 * after the orbit placed it on its seat: the flash brightens it at once,
 * and the passing front pushes it straight out from the center and lets it
 * swing back.
 */
export function kickCrewmate(f: CrewmateFrame, s: SupernovaFrame): void {
  const d = Math.hypot(f.x, f.y);
  let lit = snFlash(s.et) * 0.7 * s.release;
  const kick = supernovaKick(d, s);
  if (kick !== 0 && d > 0) {
    f.x += (f.x / d) * kick;
    f.y += (f.y / d) * kick;
    lit = Math.max(lit, kick / SUPERNOVA.crewKickPx);
  }
  if (lit > f.flash) f.flash = Math.min(1, lit);
}
