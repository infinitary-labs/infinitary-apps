import { type CrewColors, drawCrewmate, type Rgb } from "../crew/crewmate";
import { type CrewmateFrame, CrewOrbit, DEFAULT_ORBIT, PLANES_GLYPH_PX } from "../crew/orbit";
import { GROWING_RING } from "../crew/orbitalPlanes";
import {
  createSim,
  drawFrame,
  fitBacking,
  resolvePointerSetup,
  type Sim,
} from "../firstmatePainter";
import type { MachineSnapshot } from "../machine";
import { prefersReducedMotion } from "../reducedMotion";

// The stage part (INF-5609's approved plan; docs/card-authoring.md, "The
// app's own stage"): the home stage's own first mate and crewmate, drawn by
// the center's painters (../firstmatePainter, ../crew/crewmate) and its orbit
// model (../crew/orbit), small, inside the app's own first-run cards. The
// generator bundles this file into the app part `stage`
// (scripts/generate-runbook-parts.ts), which every reader puts in place of
// `<script data-inf-part="stage"></script>`; only the app's own cards may
// name it (`appPartProblem`).
//
// A body marks where the stage draws, and the part fills each mark with
// canvases sized to the mark's width:
// - `data-inf-stage="firstmate"`: the first mate, the mark's width square.
// - `data-inf-stage="crewmate"`: one working crewmate turning in place.
// - `data-inf-stage="sendoff"`: the first mate sending one crewmate out to its
//   orbit, once, as the center does when work starts; the crewmate then orbits.
// Elements marked `data-inf-stage-still` are the drawings a reader without
// the part shows instead, and the part hides them; a mark that is `hidden`
// until then is shown.
//
// The captain chose calm motion for these cards: drift and blinks only, so
// the words stay the focus. The first mate here has no state machine - no
// greeting, fidgets or reply emotes - and its eyes do not follow the pointer
// or answer a press. Reduced motion draws one settled frame, the crewmate
// already on its orbit. Every mark redraws in the new colors when the theme
// changes, and nothing draws while its mark is out of view or hidden.

/** The stage's proportions: the shares of a mark's width each figure takes. */
export const CARD_STAGE = {
  /** The send-off's first mate, as a share of the stage's width. */
  sendoffFirstmate: 0.56,
  /** The orbit's radius, as a share of the stage's width. */
  sendoffOrbit: 0.37,
  /** The orbiting crewmate's glyph, as a share of the stage's width. */
  sendoffGlyph: 0.11,
  /** A lone crewmate's glyph, as a share of its mark's width. */
  crewmateGlyph: 0.8,
  /** How long the first mate is seen at rest before it sends the crewmate out, ms. */
  sendoffDelayMs: 500,
  /** A working crewmate's own spin, radians a second, as the orbit's hot crewmate turns. */
  workingSpin: 1.5,
} as const;

/** The calm first mate's eyes look where its own gaze wanders, never at the pointer. */
const CALM_POINTER = resolvePointerSetup(false);

/** The first mate at rest: idle, no emote, no turn. Its own drift and blinks run on. */
function calmSnapshot(phase: number): MachineSnapshot {
  return {
    state: "idle",
    busy: false,
    phase,
    emoteT: 0,
    variant: null,
    clip: "none",
    blendT: 1,
    crystalActive: false,
    folding: false,
  };
}

function parseRgb(color: string, fallback: Rgb): Rgb {
  const c = color.trim();
  if (c[0] === "#" && c.length >= 7) {
    const n = Number.parseInt(c.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : fallback;
}

/** The crew's colors from the theme's wire tokens, as the center reads them. */
function crewColors(element: Element, was?: CrewColors): CrewColors {
  const cs = getComputedStyle(element);
  return {
    accent: parseRgb(
      cs.getPropertyValue("--wire-accent") || cs.getPropertyValue("--accent"),
      was?.accent ?? [127, 220, 255],
    ),
    hot: parseRgb(
      cs.getPropertyValue("--wire-hot") || cs.getPropertyValue("--hot"),
      was?.hot ?? [255, 162, 87],
    ),
    quiet: parseRgb(cs.getPropertyValue("--fg-3"), was?.quiet ?? [148, 156, 168]),
    boost: Number.parseFloat(cs.getPropertyValue("--wire-boost")) || 1,
  };
}

/** A canvas centered on its mark, `layer` deep, drawn over by nothing it holds. */
function layer(host: HTMLElement, depth: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.zIndex = String(depth);
  // No room until its first frame sizes it: a canvas's own 300 by 150 would
  // reach past the card while its mark waits hidden.
  canvas.style.width = "0px";
  canvas.style.height = "0px";
  host.append(canvas);
  return canvas;
}

/** Sizes a canvas to `css` px square; says whether its backing changed, which clears it. */
function fitCanvas(canvas: HTMLCanvasElement, css: number): boolean {
  const side = `${css}px`;
  if (canvas.style.width !== side) {
    canvas.style.width = side;
    canvas.style.height = side;
  }
  return fitBacking(canvas, css);
}

/** A 2D context drawing in CSS px, cleared. */
function cleared(canvas: HTMLCanvasElement, css: number): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, css, css);
  return ctx;
}

/** The first mate on one canvas, at the size it is given, calm. */
class CalmFirstmate {
  private sim: Sim | null = null;
  private readonly since = performance.now();
  constructor(readonly canvas: HTMLCanvasElement) {}

  /** The painter reads the theme again on its next frame. */
  restyle(): void {
    if (this.sim) this.sim.lastRead = 0;
  }

  /** Called with the first mate's send-off cue: it glances after the crewmate. */
  sendoff(now: number, dx: number, dy: number, strength: number): void {
    if (!this.sim) return;
    const length = Math.hypot(dx, dy) || 1;
    this.sim.sendoffAt = now;
    this.sim.sendoffDir = { dx: dx / length, dy: dy / length };
    this.sim.sendoffStrength = strength;
  }

  draw(size: number, now: number): void {
    const resized = fitCanvas(this.canvas, size);
    if (!this.sim || this.sim.size !== size || resized) {
      const sendoff = this.sim;
      this.sim = createSim(size, this.canvas, 0, 0);
      fitBacking(this.canvas, size);
      if (sendoff) {
        this.sim.sendoffAt = sendoff.sendoffAt;
        this.sim.sendoffDir = sendoff.sendoffDir;
        this.sim.sendoffStrength = sendoff.sendoffStrength;
      }
    }
    drawFrame(this.sim, this.canvas, now, now, calmSnapshot(now - this.since), 0, 0, CALM_POINTER);
  }
}

type Mark = {
  host: HTMLElement;
  /** Paint one frame; `settled` is the reduced-motion still. */
  draw(now: number, settled: boolean): void;
  restyle(): void;
};

function firstmateMark(host: HTMLElement): Mark {
  const firstmate = new CalmFirstmate(layer(host, 0));
  return {
    host,
    draw: (now) => firstmate.draw(host.clientWidth, now),
    restyle: () => firstmate.restyle(),
  };
}

/** A lone working crewmate, the solid the center draws, turning in place. */
function crewmateMark(host: HTMLElement): Mark {
  const canvas = layer(host, 0);
  const seed = Math.random() * 1000;
  let spin = Math.random() * Math.PI * 2;
  let last = Number.NaN;
  let colors: CrewColors | null = null;
  return {
    host,
    draw(now, settled) {
      const width = host.clientWidth;
      const glyph = width * CARD_STAGE.crewmateGlyph;
      // Room for its halo, which reaches past the solid.
      const side = Math.ceil(width * 2);
      fitCanvas(canvas, side);
      const ctx = cleared(canvas, side);
      if (!ctx) return;
      colors ??= crewColors(host);
      if (!settled && Number.isFinite(last)) {
        spin += CARD_STAGE.workingSpin * Math.min((now - last) / 1000, 0.05);
      }
      last = now;
      drawCrewmate(ctx, crewmateAt(0, 0, glyph, spin, seed), side / 2, side / 2, colors, now);
    },
    restyle() {
      colors = crewColors(host, colors ?? undefined);
    },
  };
}

/** A whole, working crewmate frame at a place, for the lone crewmate. */
function crewmateAt(x: number, y: number, size: number, spin: number, seed: number): CrewmateFrame {
  return {
    id: "crewmate",
    status: "working",
    phase: "orbiting",
    leaveMode: null,
    x,
    y,
    depth: 1,
    size,
    alpha: 1,
    unfold: 1,
    spark: 0,
    trail: [],
    work: 1,
    spin,
    nudge: 0,
    flash: 0,
    flicker: 0,
    seed,
  };
}

/**
 * The send-off: the center's own orbit model sends one working crewmate out
 * of the first mate and on to its orbit, and the first mate glances after it.
 * The model runs at the center's scale; its frames are drawn at the stage's.
 */
function sendoffMark(host: HTMLElement, settled: boolean): Mark {
  const far = layer(host, 0);
  const firstmate = new CalmFirstmate(layer(host, 1));
  const near = layer(host, 2);
  const start = performance.now();
  // The orbit opens where one crewmate's orbit sits, so the small stage never widens.
  const orbit = new CrewOrbit(
    start,
    { ...DEFAULT_ORBIT, radius: GROWING_RING.startRadiusPx },
    Math.random,
    "adaptive",
  );
  orbit.spawn("crewmate", "working", settled ? start : start + CARD_STAGE.sendoffDelayMs, settled);
  let colors: CrewColors | null = null;
  return {
    host,
    draw(now, still) {
      const width = host.clientWidth;
      const frame = orbit.update(now, still);
      for (const cue of orbit.takeCues()) {
        if (cue.kind === "sendoff") firstmate.sendoff(now, cue.dx, cue.dy, cue.strength);
      }
      firstmate.draw(Math.round(width * CARD_STAGE.sendoffFirstmate), now);
      fitCanvas(far, width);
      fitCanvas(near, width);
      const back = cleared(far, width);
      const front = cleared(near, width);
      if (!back || !front) return;
      colors ??= crewColors(host);
      const place = (width * CARD_STAGE.sendoffOrbit) / GROWING_RING.startRadiusPx;
      const grow = (width * CARD_STAGE.sendoffGlyph) / PLANES_GLYPH_PX;
      for (const crewmate of frame.crew) {
        // As the center layers it: the far leg goes behind the first mate,
        // and a spark still inside its core stays in front.
        const ctx = crewmate.depth >= 0.5 || crewmate.spark > 0.7 ? front : back;
        const { streak: _streak, ...drawn } = crewmate;
        drawCrewmate(
          ctx,
          {
            ...drawn,
            x: crewmate.x * place,
            y: crewmate.y * place,
            size: crewmate.size * grow,
            trail: crewmate.trail.map((ghost) => ({ x: ghost.x * place, y: ghost.y * place })),
          },
          width / 2,
          width / 2,
          colors,
          now,
        );
      }
    },
    restyle() {
      firstmate.restyle();
      colors = crewColors(host, colors ?? undefined);
    },
  };
}

/** Whether a mark is drawn on screen: in the document, laid out and not hidden. */
function shown(host: HTMLElement): boolean {
  return host.offsetParent !== null && getComputedStyle(host).visibility !== "hidden";
}

/** Fills every stage mark in the document and runs them until the card goes. */
export function mountCardStage(doc: Document = document): void {
  const hosts = [...doc.querySelectorAll<HTMLElement>("[data-inf-stage]")];
  if (!hosts.length) return;
  for (const still of doc.querySelectorAll<HTMLElement>("[data-inf-stage-still]")) {
    still.style.display = "none";
  }
  const settledAtStart = prefersReducedMotion();
  const marks: Mark[] = [];
  for (const host of hosts) {
    host.hidden = false;
    const kind = host.dataset.infStage;
    if (kind === "firstmate") marks.push(firstmateMark(host));
    else if (kind === "crewmate") marks.push(crewmateMark(host));
    else if (kind === "sendoff") marks.push(sendoffMark(host, settledAtStart));
  }
  const inView = new Set<HTMLElement>(marks.map((mark) => mark.host));
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (prefersReducedMotion()) return;
    const now = performance.now();
    for (const mark of marks) {
      if (inView.has(mark.host) && shown(mark.host)) mark.draw(now, false);
    }
    if (inView.size) raf = requestAnimationFrame(tick);
  };
  /** Moving, the next frame draws; reduced, every mark draws its one settled frame now. */
  const run = () => {
    if (prefersReducedMotion()) {
      cancelAnimationFrame(raf);
      raf = 0;
      const now = performance.now();
      for (const mark of marks) mark.draw(now, true);
    } else if (!raf && inView.size) raf = requestAnimationFrame(tick);
  };
  if (typeof IntersectionObserver === "function") {
    // Each mark pauses on its own while it is out of view.
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const host = entry.target as HTMLElement;
        if (entry.isIntersecting) inView.add(host);
        else inView.delete(host);
      }
      run();
    });
    for (const mark of marks) watch.observe(mark.host);
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (prefersReducedMotion()) run();
    }).observe(doc.body);
  }
  const restyle = () => {
    for (const mark of marks) mark.restyle();
    if (prefersReducedMotion()) run();
  };
  const bridge = (window as { inf?: { onTheme?: (listener: () => void) => void } }).inf;
  bridge?.onTheme?.(restyle);
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", run);
  run();
}
