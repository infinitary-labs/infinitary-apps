// Face motion for the Firstmate character: easing curves shared by the emote
// clips, plus the blink and gaze controllers that make the eyes read as alive.
// Everything here is DOM-free and driven by caller-supplied time.

export const TAU = Math.PI * 2;

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
export const easeInOut = (t: number): number => t * t * (3 - 2 * t);
export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** A one-shot bump: 0 -> 1 -> 0 across [at, at+w] of a normalized clip. */
export function pulse(t: number, at: number, w: number): number {
  const u = (t - at) / w;
  if (u <= 0 || u >= 1) return 0;
  return Math.sin(u * Math.PI);
}

/** Smooth band: eases 0->1 at `a` (width wa), holds, eases back at `b`. */
export function band(t: number, a: number, wa: number, b: number, wb: number): number {
  return clamp01((t - a) / wa) * (1 - clamp01((t - b) / wb));
}

/** Cheap smooth pseudo-noise in [-1, 1]. */
export function noise1(t: number): number {
  return Math.sin(t * 1.7) * 0.5 + Math.sin(t * 2.9 + 1.3) * 0.3 + Math.sin(t * 4.7 + 4.1) * 0.2;
}

/** Critically-damp-ish scalar spring (freq in Hz, zeta damping ratio). */
export class Spring {
  x: number;
  v = 0;
  constructor(
    x = 0,
    public freq = 3,
    private zeta = 0.8,
  ) {
    this.x = x;
  }
  step(target: number, dt: number): number {
    // Semi-implicit Euler is only stable while w*dt stays small; a dropped
    // frame (callers clamp dt at 50ms) with a quick spring breaks that and
    // the position runs away. Sub-stepping keeps every spring stable at any
    // tuned response, and is a no-op at a normal frame time.
    const w = TAU * this.freq;
    const n = Math.max(1, Math.ceil((dt * w) / 0.5));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-2 * this.zeta * w * this.v - w * w * (this.x - target)) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Blink controller: lid 0 = open, 1 = closed; occasional double blink. */
export class Blinker {
  private next = 1.5 + Math.random() * 3;
  private t = -1; // -1 = not blinking
  private again = false;
  /** Advance by dt seconds; `suppressed` holds blinks off (listening). */
  update(dt: number, suppressed: boolean): number {
    if (this.t < 0) {
      if (!suppressed) {
        this.next -= dt;
        if (this.next <= 0) {
          this.t = 0;
          this.again = Math.random() < 0.22;
        }
      }
      return 0;
    }
    this.t += dt;
    const dur = 0.16; // one blink in seconds
    if (this.t >= dur) {
      if (this.again) {
        this.again = false;
        this.t = 0;
        return 0;
      }
      this.t = -1;
      this.next = 2.4 + Math.random() * 4.2;
      return 0;
    }
    return Math.sin((this.t / dur) * Math.PI);
  }
}

/** The gaze spring's resting response, in Hz - the calm wander pace. */
export const GAZE_REST_HZ = 2.2;

/**
 * Gaze controller: wanders when free, springs to a directed look target, and
 * can be drawn toward an external point of interest (the pointer) by weight.
 * The pull blends over whatever the gaze would otherwise do - wander or a
 * held look - so letting go glides back through the same spring instead of
 * snapping. Gaze units: roughly [-1, 1] on each axis, where 1 is the full
 * deflection the renderer maps onto the eye offset.
 */
export class Gaze {
  private sx = new Spring(0, GAZE_REST_HZ, 0.9);
  private sy = new Spring(0, GAZE_REST_HZ, 0.9);
  private tx = 0;
  private ty = 0;
  private next = 1 + Math.random() * 2;
  private hold: { x: number; y: number } | null = null;
  private pull: { x: number; y: number; w: number } | null = null;
  update(dt: number): { x: number; y: number } {
    let tx: number;
    let ty: number;
    if (this.hold) {
      tx = this.hold.x;
      ty = this.hold.y;
    } else {
      this.next -= dt;
      if (this.next <= 0) {
        this.next = 1.2 + Math.random() * 2.6;
        const a = Math.random() * TAU;
        const r = Math.random() * 0.7;
        this.tx = Math.cos(a) * r;
        this.ty = Math.sin(a) * r * 0.6;
        if (Math.random() < 0.3) {
          this.tx = 0;
          this.ty = 0;
        }
      }
      tx = this.tx;
      ty = this.ty;
    }
    if (this.pull) {
      tx += (this.pull.x - tx) * this.pull.w;
      ty += (this.pull.y - ty) * this.pull.w;
    }
    this.sx.step(tx, dt);
    this.sy.step(ty, dt);
    return { x: this.sx.x, y: this.sy.x };
  }
  look(x: number, y: number): void {
    this.hold = { x, y };
  }
  free(): void {
    this.hold = null;
  }
  /**
   * Draw the gaze toward an external point by `weight` (0 = no pull, 1 = the
   * point wins outright over the wander or held look).
   */
  attract(x: number, y: number, weight: number): void {
    const w = clamp01(weight);
    this.pull = w > 0 ? { x, y, w } : null;
  }
  /** Retune the follow speed in Hz - quicker while tracking, calm at rest. */
  setResponse(freq: number): void {
    this.sx.freq = freq;
    this.sy.freq = freq;
  }
}

export type PointerGazeOptions = {
  /** Pointer distance, in character sizes, at which the deflection saturates. */
  reach: number;
  /** Deflection at saturation, in gaze units (1 = the wander's full range). */
  gain: number;
  /** Vertical deflection relative to horizontal - the eyes sit in a wide cell. */
  yScale: number;
  /** Seconds a resting pointer keeps the gaze before interest fades. */
  holdSeconds: number;
  /** Seconds the pull takes to let go - after the hold, or when the pointer leaves. */
  releaseSeconds: number;
  /** Seconds the pull takes to take hold when the pointer moves. */
  captureSeconds: number;
  /** Spring response while the pointer holds the gaze, in Hz. */
  trackHz: number;
};

export const DEFAULT_POINTER_GAZE: PointerGazeOptions = {
  reach: 1,
  gain: 1.2,
  yScale: 0.85,
  holdSeconds: 2.5,
  releaseSeconds: 1.2,
  captureSeconds: 0.25,
  trackHz: 3.2,
};

export type PointerPull = {
  x: number;
  y: number;
  /** 0..1 - how much the pointer holds the gaze right now. */
  weight: number;
  /** Where the pointer stands: moving/recently moved, resting past the hold, or gone. */
  phase: "engaged" | "resting" | "absent";
};

/**
 * Pointer-directed gaze: maps the pointer's offset from the character into a
 * bounded look target and an attention weight. Attention rises quickly when
 * the pointer moves, stays while it rests for `holdSeconds`, then eases away
 * so the wander (or the state's own look) takes over again; a pointer that
 * leaves the window lets go on the same ease. DOM-free: the host feeds
 * `move` offsets already normalized by the character's size.
 */
export class PointerGaze {
  private px = 0;
  private py = 0;
  private present = false;
  private sinceMove = Number.POSITIVE_INFINITY;
  private w = 0;
  private tx = 0;
  private ty = 0;
  private opts: PointerGazeOptions;

  constructor(opts: Partial<PointerGazeOptions> = {}) {
    this.opts = { ...DEFAULT_POINTER_GAZE, ...opts };
  }

  configure(opts: Partial<PointerGazeOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** The pointer moved to (dx, dy) from the character's center, in character sizes. */
  move(dx: number, dy: number): void {
    this.px = dx;
    this.py = dy;
    this.present = true;
    this.sinceMove = 0;
  }

  /** The pointer left the window, or the window lost it. */
  leave(): void {
    this.present = false;
  }

  /** Advance by dt seconds and return the pull to apply this frame. */
  update(dt: number): PointerPull {
    this.sinceMove += dt;
    const o = this.opts;
    const engaged = this.present && this.sinceMove < o.holdSeconds;
    // Ease attention toward its goal; ~95% of the way within the stated seconds.
    const tau = (engaged ? o.captureSeconds : o.releaseSeconds) / 3;
    this.w += ((engaged ? 1 : 0) - this.w) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
    if (this.w < 1e-3) this.w = 0;
    // Direction toward the pointer, deflection saturating smoothly with distance.
    const d = Math.hypot(this.px, this.py);
    if (d > 1e-6) {
      const k = d / Math.max(o.reach, 1e-3);
      const s = (k / Math.sqrt(1 + k * k)) * o.gain;
      this.tx = (this.px / d) * s;
      this.ty = (this.py / d) * s * o.yScale;
    } else {
      this.tx = 0;
      this.ty = 0;
    }
    return {
      x: this.tx,
      y: this.ty,
      weight: this.w,
      phase: engaged ? "engaged" : this.present ? "resting" : "absent",
    };
  }
}
