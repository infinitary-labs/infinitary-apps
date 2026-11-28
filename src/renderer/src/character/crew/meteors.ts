// The crew's part in the meteor fidgets (../meteors.ts): a meteor passing a
// crewmate circling the first mate lights it, by the captain's crew-light
// setting. Nothing moves a crewmate, and crew on other computers stay in
// their own groups and stay dark, as they do during the warps (./warp.ts).
//
// The character publishes which meteor fidget it plays, when it began, where
// it last drew the storm's points and that it stopped; the orbit (./orbit.ts)
// and the crew canvases (./CrewOrbit.tsx) read the frame each frame. Both
// run on stage time (../stageClock.ts). DOM-free and time-injected; the
// shared instance is a module ref like the warp's.

import { clamp01, easeInOut } from "../face";
import {
  METEORS,
  type MeteorFrame,
  type MeteorLight,
  type MeteorVariant,
  meteorLights,
  meteorLitAt,
  stormFlights,
} from "../meteors";
import type { CrewmateFrame } from "./orbit";
import { WARP_RELEASE_MS } from "./warp";

export class CrewMeteors {
  private variant: MeteorVariant | null = null;
  private startAt = 0;
  private coreR = 81;
  private heat = 0;
  private home: ArrayLike<number> = new Float64Array(32);
  private rank: readonly number[] = [];
  private active = false;
  /** Stage time and progress at which a meteor fidget was cut short, else null. */
  private cut: { at: number; et: number } | null = null;

  /**
   * A meteor fidget is playing: it began at stage time `startAt`. Called
   * every frame it plays, with the first mate's radius, its ember, and the
   * storm's points where it last drew them (x, y pairs from its center)
   * with their winding ranks.
   */
  playing(
    variant: MeteorVariant,
    startAt: number,
    coreR: number,
    heat: number,
    home: ArrayLike<number>,
    rank: readonly number[],
  ): void {
    this.variant = variant;
    this.startAt = startAt;
    this.coreR = coreR;
    this.heat = heat;
    this.home = home;
    this.rank = rank;
    this.active = true;
    this.cut = null;
  }

  /** No meteor fidget is playing. One cut short fades its sky over a warp's release. */
  stopped(now: number): void {
    if (!this.active) return;
    this.active = false;
    const variant = this.variant;
    const et = variant ? (now - this.startAt) / METEORS[variant].durationMs : 1;
    if (et < 1 && variant) this.cut = { at: now, et };
    else this.variant = null;
  }

  frame(now: number): MeteorFrame | null {
    const variant = this.variant;
    if (!variant) return null;
    let et = (now - this.startAt) / METEORS[variant].durationMs;
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
      t: now / 1000,
      release,
      coreR: this.coreR,
      heat: this.heat,
      home: this.home,
      rank: this.rank,
    };
  }
}

/** The one meteor fidget the home stage shares: the character writes it, the orbit and the crew canvases read it. */
export const crewMeteors = new CrewMeteors();

/** The lights a meteor frame casts on the crew, px from the first mate's center. */
export function meteorCrewLights(f: MeteorFrame): MeteorLight[] {
  const flights = f.variant === "storm" ? stormFlights(f.et, f.rank, f.home) : [];
  return meteorLights(f.variant, f.et, flights).lights;
}

/** Light one crewmate circling the first mate, in screen space, by the meteors passing it. */
export function lightCrewmate(
  c: CrewmateFrame,
  f: MeteorFrame,
  lights: readonly MeteorLight[],
): void {
  if (METEORS.crewLight <= 0) return;
  const lit = Math.min(1, meteorLitAt(lights, c.x, c.y) * METEORS.crewLight * 1.5) * f.release;
  if (lit > c.flash) c.flash = lit;
}
