// The stage clock: the one time source the home character and its crew read.
// Stage time advances by real time times a rate, so everything painted from
// it - the character's turning, the crew's travel and spin, spawns,
// departures, packets, nudges, flickers and emotes - slows and stops together
// and stays one coherent picture. DOM-free and time-injected like the
// character's machine (./machine.ts); the shared instance is a module ref
// like liveVoiceLevel, never store state.
//
// The captain's three levels (FI3-398): full speed away from the formation, a
// tenth inside it, and a complete pause while the pointer is on a crewmate.
// Every change is eased, never a cut. At rate 1 stage time is real time minus
// a constant, so a stage nobody has slowed is bit-identical to the raw frame
// time, and at rate 0 it does not move at all.

export const STAGE_CLOCK = {
  /** The rate inside the formation's zone: the captain's "a tenth of normal". */
  slow: 0.1,
  /** Time constants of the ease, in seconds: about a third of a second down, 0.7 s back up. */
  dropSeconds: 0.11,
  riseSeconds: 0.23,
  /** A pointer resting this long inside the zone, off every crewmate, lets the stage go. */
  restMs: 3000,
  /** The ease lands on its target once it is this close. */
  settle: 0.01,
};

export class StageClock {
  /** The eased rate: 1 is real time, 0 a complete pause. */
  rate = 1;
  /** What the rate eases toward; whoever watches the pointer sets it. */
  target = 1;
  private stage = 0;
  /** Real time minus stage time while the stage runs at full speed. */
  private lag = 0;
  private last: number | null = null;

  /**
   * Advance to a frame's real time and return its stage time. Asking twice
   * for the same frame time answers the same, so two loops share one frame.
   */
  advance(realNow: number): number {
    if (this.last === null) {
      this.last = realNow;
      this.stage = realNow - this.lag;
      return this.stage;
    }
    const dt = realNow - this.last;
    if (dt <= 0) return this.stage;
    this.last = realNow;
    if (this.rate === 1 && this.target === 1) {
      this.stage = realNow - this.lag;
      return this.stage;
    }
    // The exact integral of the eased rate over the frame, so the stage time
    // does not depend on how the frames happened to fall.
    const tau =
      (this.target < this.rate ? STAGE_CLOCK.dropSeconds : STAGE_CLOCK.riseSeconds) * 1000;
    const gap = this.rate - this.target;
    const decay = Math.exp(-dt / tau);
    this.stage += this.target * dt + gap * tau * (1 - decay);
    this.rate = this.target + gap * decay;
    if (Math.abs(this.rate - this.target) < STAGE_CLOCK.settle) this.rate = this.target;
    this.lag = realNow - this.stage;
    return this.stage;
  }

  /**
   * Reduced motion has no rate: its one settled frame is already still, so
   * the stage simply runs at full speed from where it stands.
   */
  settle(): void {
    this.rate = 1;
    this.target = 1;
  }

  /** Stage time at a real time between frames, for stamping an event. Advances nothing. */
  read(realNow: number): number {
    if (this.last === null || (this.rate === 1 && this.target === 1)) return realNow - this.lag;
    return this.stage + Math.max(0, realNow - this.last) * this.rate;
  }
}

/** The one clock the home stage shares. */
export const stageClock = new StageClock();

/** Stage time now: the stamp for anything the stage will animate. */
export function stageNow(): number {
  return stageClock.read(performance.now());
}

export type StageAttention = {
  /** Someone is out to inspect: the formation has crew. */
  crew: boolean;
  /** The pointer is inside the formation's zone. */
  inZone: boolean;
  /** The pointer is on a crewmate (or its name has the keyboard). */
  onCrewmate: boolean;
  /** Ms since the pointer last moved. */
  restedMs: number;
};

/**
 * The rate the stage should ease toward. Away from the formation, or with
 * nobody out, it runs at full speed; inside the zone it slows until the
 * pointer has rested a while; on a crewmate it stops, for as long as the
 * pointer stays there.
 */
export function stageRateTarget(attention: StageAttention | null): number {
  if (!attention?.crew) return 1;
  if (attention.onCrewmate) return 0;
  if (!attention.inZone || attention.restedMs >= STAGE_CLOCK.restMs) return 1;
  return STAGE_CLOCK.slow;
}
