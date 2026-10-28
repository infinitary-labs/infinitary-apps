// The crew's part in the warp fidgets (../warp.ts): while the first mate
// plays one, every crewmate circling it rides along - the tunnel's tilted
// orbits open into one flat ring, the sphere's crew dive in one after
// another and come back out, the corkscrew's peel off into a spiral line
// behind the first mate - and all of them travel their orbits faster, a
// lead that stays where the warp leaves it, so each crewmate comes home to
// its own seat. Crew on other computers stay in their own groups (the
// captain's answer on the prototype card, INF-1750), as they do during the
// black hole (./rush.ts).
//
// The character publishes when its warp began and when it stopped; the
// orbit (./orbit.ts) and the crew canvases (./CrewOrbit.tsx) read the frame
// each frame. Both run on stage time (../stageClock.ts). DOM-free and
// time-injected; the shared instance is a module ref like the rush's.

import { clamp01, easeInOut } from "../face";
import {
  helixAt,
  sphereRadius,
  WARP,
  type WarpFrame,
  type WarpVariant,
  warpEnvelope,
  warpJitter,
  warpSpeed,
  warpTravel,
} from "../warp";
import type { CrewmateFrame } from "./orbit";

/** A warp cut short (attention, Reduce Motion) lets the crew go home over this long, ms. */
export const WARP_RELEASE_MS = 600;

export class CrewWarp {
  private variant: WarpVariant | null = null;
  private startAt = 0;
  private coreR = 81;
  private heat = 0;
  private active = false;
  /** Stage time and progress at which a warp was cut short, else null. */
  private cut: { at: number; et: number } | null = null;

  /**
   * A warp is playing: it began at stage time `startAt`. Called every frame
   * it plays, with the first mate's radius and ember; a start that moves (a
   * pinned emote's clock) moves the crew with it.
   */
  playing(variant: WarpVariant, startAt: number, coreR: number, heat: number): void {
    this.variant = variant;
    this.startAt = startAt;
    this.coreR = coreR;
    this.heat = heat;
    this.active = true;
    this.cut = null;
  }

  /** No warp is playing. One cut short lets the crew go home over WARP_RELEASE_MS. */
  stopped(now: number): void {
    if (!this.active) return;
    this.active = false;
    const et = (now - this.startAt) / WARP.durationMs;
    if (et < 1 && this.variant) this.cut = { at: now, et };
    else this.variant = null;
  }

  /** The warp this frame, or null when the crew are on their own. */
  frame(now: number): WarpFrame | null {
    const variant = this.variant;
    if (!variant) return null;
    let et = (now - this.startAt) / WARP.durationMs;
    let release = 1;
    if (!this.active) {
      if (!this.cut) return null;
      release = 1 - easeInOut(clamp01((now - this.cut.at) / WARP_RELEASE_MS));
      et = this.cut.et;
      if (release <= 0) {
        this.variant = null;
        this.cut = null;
        return null;
      }
    } else if (et >= 1 || et < 0) return null;
    return {
      variant,
      et,
      k: warpEnvelope(et) * release,
      sp: warpSpeed(et) * release,
      tv: warpTravel(et),
      t: now / 1000,
      coreR: this.coreR,
      heat: this.heat,
    };
  }
}

/** The one warp the home stage shares: the character writes it, the orbit and the crew canvases read it. */
export const crewWarp = new CrewWarp();

/** Points in a rider's light trail. */
const TRAIL_POINTS = 6;

/**
 * Move one orbiting crewmate for the warp, in screen space, after the orbit
 * placed it on its seat: `index` is its place among the `count` riders. The
 * tunnel's flat ring is the orbit's own (it flattens the projection); here
 * it gets its tremble, its place in front and a trail streaming outward. The
 * sphere's riders dive in one after another and come back out; the
 * corkscrew's peel off into the spiral behind the first mate. Every move is
 * scaled by the envelope, so at its end each crewmate is back on its seat.
 */
export function warpCrewmate(f: CrewmateFrame, index: number, count: number, w: WarpFrame): void {
  const { k, sp, et } = w;
  if (k <= 0.001) return;
  if (w.variant === "tunnel") {
    const [jx, jy] = warpJitter(w.t * 0.5, f.seed);
    f.x += jx * 2.9 * sp;
    f.y += jy * 2.9 * sp;
    if (k > 0.5) f.depth = 0.5 + Math.abs(f.depth - 0.5);
    const d = Math.hypot(f.x, f.y) || 1;
    trail(f, f.x / d, f.y / d, 21 * sp);
    return;
  }
  if (w.variant === "corkscrew") {
    const ki = easeInOut(clamp01(k * 1.7 - (index / Math.max(count, 1)) * 0.7));
    if (ki <= 0) return;
    const h = helixAt(index, count, w);
    f.x += (h.x - f.x) * ki;
    f.y += (h.y - f.y) * ki;
    f.depth += ((h.z + 1) / 2 - f.depth) * ki;
    f.size *= 1 + 0.25 * h.z * ki;
    f.alpha *= 1 - 0.4 * ki * clamp01(-h.z);
    trail(f, -1, 0, 19 * sp * ki);
    return;
  }
  // The sphere: in one after another, then out one after another.
  const n = Math.max(1, count - 1);
  const dive = 0.11;
  const t0 = 0.17 + (0.22 * index) / n;
  const t1 = 0.56 + (0.2 * index) / n;
  if (et < t0) return;
  const r0 = Math.hypot(f.x, f.y);
  const a0 = Math.atan2(f.y, f.x);
  const rs = Math.max(sphereRadius(et, w.coreR), 1);
  const going = et < t1;
  const u = clamp01((et - (going ? t0 : t1)) / dive);
  if (going && u >= 1) {
    f.alpha = 0;
    return;
  }
  if (!going && u >= 1) return;
  // Each spirals in toward the centre, a little more than a quarter turn, then out the same way.
  const turn = 1.8;
  const place = (e: number): { x: number; y: number; r: number } => {
    const rr = r0 * (going ? 1 - e : e);
    const aa = a0 + turn * (going ? e : e - 1);
    return { x: Math.cos(aa) * rr, y: Math.sin(aa) * rr, r: rr };
  };
  const at = place(easeInOut(u));
  const inside = clamp01(1 - at.r / rs);
  f.x = at.x;
  f.y = at.y;
  f.depth = 1;
  f.size *= 1 - 0.8 * inside;
  f.alpha *= !going && u <= 0 ? 0 : 1 - inside * 0.85;
  f.streak = [{ x: at.x, y: at.y }];
  for (let g = 1; g < TRAIL_POINTS; g++) {
    const p = place(easeInOut(clamp01(u - g * 0.035)));
    f.streak.push({ x: p.x, y: p.y });
  }
}

/** A straight light trail behind a rider, along (dx, dy), `len` px long. */
function trail(f: CrewmateFrame, dx: number, dy: number, len: number): void {
  if (len < 1) return;
  f.streak = [];
  for (let i = 0; i < TRAIL_POINTS; i++) {
    const s = (i / (TRAIL_POINTS - 1)) * len;
    f.streak.push({ x: f.x + dx * s, y: f.y + dy * s });
  }
}
