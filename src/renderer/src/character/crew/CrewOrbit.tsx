import type { CrewWord } from "@shared/firstRun";
import type { Theme } from "@shared/preferences";
import type React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motionToken } from "../../design/motion";
import { litTask, useLitTaskId } from "../../plugins/point/litTask";
import { requestCharacterReceive, requestCharacterSendoff } from "../emoteSignal";
import { useAnimationLoop } from "../motion";
import { skipHiddenPaint } from "../paintHidden";
import { onPixelRatioChange } from "../pixelRatio";
import { prefersReducedMotion } from "../reducedMotion";
import { stageClock, stageRateTarget } from "../stageClock";
import { CLUSTER_LAYOUT, ComputerOrbits, HOME_COMPUTER } from "./computers";
import "./computers.css";
import { drawWarpBackdrop, type WarpFrame } from "../warp";
import { CrewSummary } from "./CrewSummary";
import {
  type CrewColors,
  drawConstellation,
  drawCrewmate,
  drawDependencyLink,
  drawPacket,
  type Rgb,
} from "./crewmate";
import { type FocusLightInput, type FocusLightState, lightFrame } from "./focusLight";
import {
  type Box,
  CREW_HOVER,
  crewHit,
  inCrewZone,
  placeCrewSummary,
  type SummaryRoom,
} from "./hover";
import { markOf, programMarks, stageMarks } from "./marks";
import { CREW_MODEL_LABEL, crewModelLabelPlacement, crewModelLabelsVisible } from "./modelLabels";
import type { CrewOrbit as CrewOrbitModel, OrbitFrame } from "./orbit";
import { CROWDED_PLANES } from "./orbitalPlanes";
import { crewRush } from "./rush";
import {
  CREW_STATE_WORD,
  crewStateWordPlacement,
  NO_STATE_WORD,
  type StateWordView,
  stepStateWord,
} from "./stateWords";
import {
  moveSummary,
  openSummary,
  poseOf,
  useSummaryFade,
  useSummaryPresence,
} from "./summaryMotion";
import type { CrewFacts } from "./useCrewBoard";
import { crewWarp } from "./warp";
import "./modelLabels.css";
import "./stateWords.css";

// The crew in orbit around the Firstmate: two canvases with the character
// between them, so a crewmate on the far leg of the ring passes BEHIND the
// Firstmate's wires and one on the near leg passes in front - the
// occlusion is what sells the ring as a ring. One loop drives both (the
// character's own loop stays its own), pausing when hidden and collapsing
// to one settled frame under reduced motion, like every character loop; a
// new pixel ratio paints that settled frame again at the new sharpness.
//
// The model (./orbit.ts) owns every position; this component only paints
// what it hands back and forwards the Firstmate-side cues it raises to the
// character's side channel (../emoteSignal.ts), the way fleet moments reach
// the emotes - never through React state. Model names are a separate DOM
// layer following these exact frames.
//
// With more than one work computer (./computers.ts) the crew canvases grow
// to the window - they already lie under the rails, their panels, the cards
// and the input, and nothing in the app moves for them - and the whole
// scene, Firstmate included, shrinks only when the window is narrower or
// shorter than it. The single-computer stage is the 560 px square it was.
//
// Both loops read the one stage clock (../stageClock.ts), and this component
// is what watches the pointer for it (FI3-398): over an occupied orbit
// the stage eases to a tenth of its speed, and on a crewmate it pauses and
// that crewmate's summary opens beside it. The crew canvases ignore the
// pointer, so pointing is a hit test (./hover.ts) against the painted frames,
// run on pointer movement only: a crewmate drifting under a still pointer
// triggers nothing. A click on the crewmate being read opens its task.

export type CrewOrbitProps = {
  model: CrewOrbitModel;
  /** Square canvas size around the character's center, px. */
  extent?: number;
  /** The Firstmate, painted between the far and near layers. */
  children?: React.ReactNode;
  /** Display names only; identity and routing remain on the task board. */
  names?: Readonly<Record<string, string>>;
  /** What each crewmate's summary says, by task id. */
  facts?: Readonly<Record<string, CrewFacts>>;
  /** A click on the crewmate being read. */
  onOpen?: (taskId: string) => void;
  /** Where a summary may sit, in window coordinates; anywhere in the window when absent. */
  summaryRoom?: () => SummaryRoom;
  /** Background crew under a card do not take focus or the pointer. */
  interactive?: boolean;
  theme?: Theme;
  /**
   * Naming the colors for someone new (./stateWords.ts): the words not yet
   * taught on this profile, and where a completed showing is written.
   * Absent once both are taught.
   */
  teach?: {
    taught: Readonly<Record<CrewWord, boolean>>;
    onTaught: (word: CrewWord) => void;
  } | null;
  /**
   * The project in light (./focusLight.ts, docs/project-focus.md): crewmates
   * of other projects dim, their names with them. Absent lights everyone.
   */
  focus?: FocusLightInput;
};

/** Clear air between a summary and the edge of where it may sit, px. */
const SUMMARY_MARGIN_PX = 8;

function writeStyle(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value)
    element.style.setProperty(property, value);
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

type Layer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
/** A crew canvas's size, CSS px, centered on the Firstmate. */
type CanvasBox = { width: number; height: number };

function layerOf(canvas: HTMLCanvasElement | null, box: CanvasBox): Layer | null {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(box.width * dpr);
  const h = Math.round(box.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}

/** Clear both layers and paint a frame's crew and packets on them. */
function paintFrame(
  near: Layer,
  far: Layer,
  box: CanvasBox,
  frame: OrbitFrame,
  colors: CrewColors,
  now: number,
  inspected: string | null,
  warp: WarpFrame | null,
): void {
  near.ctx.clearRect(0, 0, box.width, box.height);
  far.ctx.clearRect(0, 0, box.width, box.height);
  const cx = box.width / 2;
  const cy = box.height / 2;
  // A warp's wormhole and stars lie behind every crewmate and the character.
  if (warp) {
    const seated = new Set(frame.programs.flatMap((p) => p.nodes.map((n) => n.id)));
    const riders = frame.crew.filter(
      (cm) =>
        cm.phase === "orbiting" &&
        (cm.computerId ?? HOME_COMPUTER) === HOME_COMPUTER &&
        !seated.has(cm.id),
    ).length;
    drawWarpBackdrop(
      far.ctx,
      warp,
      cx,
      cy,
      { acc: colors.accent, hot: colors.hot, boost: colors.boost },
      riders,
    );
  }
  const byId = new Map(frame.crew.map((cm) => [cm.id, cm]));
  // A constellation lies flat at its mark's depth, under the crew it seats.
  for (const program of frame.programs)
    drawConstellation(program.depth >= 0.5 ? near.ctx : far.ctx, program, cx, cy, colors);
  for (const link of frame.links) {
    const from = byId.get(link.fromId);
    const to = byId.get(link.toId);
    if (!from || !to) continue;
    drawDependencyLink(
      near.ctx,
      from,
      to,
      cx,
      cy,
      colors,
      inspected === from.id || inspected === to.id,
      link.kind,
    );
  }
  for (const cm of frame.crew) {
    // The far leg goes behind the character; a spark still inside the
    // core (early travel) stays in front, where the eyes' light lives.
    const inFront = cm.depth >= 0.5 || cm.spark > 0.7;
    const ctx = inFront ? near.ctx : far.ctx;
    drawCrewmate(ctx, cm, cx, cy, colors, now);
  }
  for (const p of frame.packets) drawPacket(near.ctx, p, cx, cy, colors);
}

/** The home formation's square, and the window height it keeps for the activity line and input. */
export const CREW_FIT = { extentPx: 560, reservePx: 224 } as const;

/**
 * How far a short window shrinks the crowded formation (CSS): 1 down to a
 * window CREW_FIT.reservePx taller than the formation, then less.
 */
export function crewWindowFit(extent: number = CREW_FIT.extentPx): string {
  return `min(1, (100vh - ${CREW_FIT.reservePx}px) / ${extent}px)`;
}

/**
 * How far a multi-computer scene shrinks, from how far it reaches
 * (`OrbitFrame.scene`): the short-window fit as at home, and less when the
 * window is narrower or shorter than the wings, never under the floor.
 * `sceneFitCss` is the same rule for the stylesheet, so a still frame under
 * reduced motion keeps fitting as the window changes.
 */
export function sceneFit(
  need: { halfWidth: number; halfHeight: number },
  viewport: { width: number; height: number },
  extent: number = CREW_FIT.extentPx,
): number {
  const room = viewport.height - CREW_FIT.reservePx;
  return Math.max(
    CLUSTER_LAYOUT.minFit,
    Math.min(
      1,
      room / extent,
      viewport.width / (2 * Math.max(1, need.halfWidth)),
      room / (2 * Math.max(1, need.halfHeight)),
    ),
  );
}
export function sceneFitCss(
  need: { halfWidth: number; halfHeight: number },
  extent: number = CREW_FIT.extentPx,
): string {
  const room = `(100vh - ${CREW_FIT.reservePx}px)`;
  const width = Math.round(2 * Math.max(1, need.halfWidth));
  const height = Math.round(2 * Math.max(1, need.halfHeight));
  return `max(${CLUSTER_LAYOUT.minFit}, min(1, ${room} / ${extent}px, 100vw / ${width}px, ${room} / ${height}px))`;
}

/**
 * The crew canvases' size: the formation's square at home; with several
 * computers, the window - under the rails and the input - and never less
 * than the scene itself reaches, so a wing is never clipped.
 */
function sceneBox(
  need: { halfWidth: number; halfHeight: number } | undefined,
  viewport: { width: number; height: number },
  extent: number,
): CanvasBox {
  if (!need) return { width: extent, height: extent };
  const round = (value: number) => Math.ceil(value / 32) * 32;
  return {
    width: round(Math.max(viewport.width, 2 * need.halfWidth, extent)),
    height: round(Math.max(viewport.height - CREW_FIT.reservePx, 2 * need.halfHeight, extent)),
  };
}

/** A cluster's name under its seat, counter-scaled like every label. */
function clusterNameTransform(cluster: { x: number; labelY: number }, extent: number): string {
  const px = (value: number) => `${Math.round(value * 10) / 10}px`;
  return `translate(${px(extent / 2 + cluster.x)}, ${px(extent / 2 + cluster.labelY)}) translateX(-50%) scale(calc(1 / var(--crew-fit-scale)))`;
}

export function CrewOrbit({
  model,
  extent = CREW_FIT.extentPx,
  children,
  names,
  facts,
  onOpen,
  summaryRoom,
  interactive = true,
  theme,
  teach = null,
  focus,
}: CrewOrbitProps) {
  // A command bumps the version: the loop restarts on it, so a reduced-motion
  // still repaints the new roster.
  const version = useSyncExternalStore(model.subscribe, () => model.version);
  const computers = model instanceof ComputerOrbits && model.multiple ? model : null;
  const clusters = computers?.labeled() ?? [];
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const farRef = useRef<HTMLCanvasElement>(null);
  const nearRef = useRef<HTMLCanvasElement>(null);
  const nameRefs = useRef(new Map<string, HTMLButtonElement>());
  // A program's root and its finished or unstarted parts, each a button of
  // its own for the keyboard, placed on its painted mark (./marks.ts).
  const markRefs = useRef(new Map<string, HTMLDivElement>());
  const markKeyRef = useRef("");
  const [markIds, setMarkIds] = useState<readonly string[]>([]);
  const clusterRefs = useRef(new Map<string, HTMLDivElement>());
  const singleOrbitRef = useRef(false);
  const [singleOrbit, setSingleOrbit] = useState(false);
  // The clusters whose crew show their model names, each by the home rule:
  // one orbit shows them, a second hides them (./modelLabels.ts).
  const namedRef = useRef("");
  const [named, setNamed] = useState("");
  // The crewmate the pointer is on, and the one whose name has the keyboard.
  const [hovered, setHoveredState] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const setHovered = useCallback((id: string | null) => {
    if (hoveredRef.current === id) return;
    hoveredRef.current = id;
    setHoveredState(id);
  }, []);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (!singleOrbit && !computers) setFocused(null);
  }, [singleOrbit, computers]);
  const inspecting = interactive ? (focused ?? hovered) : null;
  const inspectingRef = useRef(inspecting);
  inspectingRef.current = inspecting;
  // The crewmate inspected is the task lit everywhere (INF-237); its rest ends it.
  useEffect(() => {
    if (inspecting) litTask.set(inspecting, "stage");
    else litTask.release("stage");
    return () => litTask.release("stage");
  }, [inspecting]);
  // A rest elsewhere - a Tasks row, a key - lights its crewmate with the
  // brackets alone: no summary, no hairline, and the stage neither slows nor pauses.
  const litId = useLitTaskId();
  const litCrewId = interactive && litId !== null && litId !== inspecting ? litId : null;
  const litCrewRef = useRef(litCrewId);
  litCrewRef.current = litCrewId;
  const litTargetRef = useRef<HTMLDivElement>(null);
  // The stage pauses the moment a crewmate is acquired; its summary opens a
  // beat later, moves to the next crewmate at once, and fades as it goes
  // (./summaryMotion).
  const { shown, leaving } = useSummaryPresence(inspecting);
  const summary = shown !== null ? (facts?.[shown] ?? null) : null;
  const layerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** The hairline's angle as last placed: the way the summary slides in. */
  const angleRef = useRef(0);
  /** The panel last placed and the crewmate it was placed for, so a new one moves it. */
  const placedFor = useRef<{ panel: HTMLElement; target: string } | null>(null);
  const shownRef = useRef<string | null>(null);
  shownRef.current = summary ? shown : null;
  /**
   * The last painted frame, its stage time, its fit and its canvas box: for
   * hit tests between frames, and to paint the reduced-motion still again.
   */
  const viewRef = useRef<{
    frame: OrbitFrame;
    now: number;
    scale: number;
    box: CanvasBox;
  } | null>(null);
  /** The pointer, in px from the formation's centre, while it is on the stage. */
  const pointerRef = useRef<{ x: number; y: number; movedAt: number } | null>(null);
  /** A crewmate dismissed with Esc stays closed until the pointer leaves it. */
  const dismissedRef = useRef<string | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  // The state word (./stateWords.ts) rides a clock of its own: the painted
  // frames are read at 5 Hz, so it works while a reduced-motion stage is one
  // still frame, and its 6 s are real seconds, whatever the stage rate.
  const teachRef = useRef(teach);
  teachRef.current = teach;
  const [word, setWord] = useState<StateWordView | null>(null);
  const wordRef = useRef<StateWordView | null>(null);
  const wordStateRef = useRef(NO_STATE_WORD);
  const wordElementRef = useRef<HTMLDivElement>(null);
  const placeWord = useCallback(() => {
    const view = viewRef.current;
    const anchor = wordElementRef.current?.parentElement;
    const cm = view?.frame.crew.find((c) => c.id === wordRef.current?.id);
    if (!anchor || !cm) return;
    const at = crewStateWordPlacement(cm, extent);
    const transform = `translate(${at.x}px, ${at.y}px)`;
    if (anchor.style.transform !== transform) anchor.style.setProperty("transform", transform);
  }, [extent]);
  const wordLive = teach !== null || word !== null;
  useEffect(() => {
    if (!wordLive) {
      wordStateRef.current = NO_STATE_WORD;
      return;
    }
    const read = () => {
      const t = teachRef.current;
      const step = stepStateWord(wordStateRef.current, {
        now: performance.now(),
        crew: viewRef.current?.frame.crew ?? [],
        taught: t?.taught ?? { working: true, idle: true },
        visible: interactiveRef.current && !document.hidden,
        summaryOf: shownRef.current,
        reducedMotion: prefersReducedMotion(),
      });
      wordStateRef.current = step.state;
      const same = (a: StateWordView | null, b: StateWordView | null) =>
        a === b ||
        (a !== null && b !== null && a.id === b.id && a.word === b.word && a.on === b.on);
      if (!same(wordRef.current, step.view)) {
        wordRef.current = step.view;
        setWord(step.view);
      }
      if (step.taught) t?.onTaught(step.taught);
    };
    const id = window.setInterval(read, 200);
    return () => window.clearInterval(id);
  }, [wordLive]);
  useLayoutEffect(() => {
    if (word) placeWord();
  }, [word, placeWord]);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const roomRef = useRef(summaryRoom);
  roomRef.current = summaryRoom;
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => {
      setViewportHeight(window.innerHeight);
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const nameKey = JSON.stringify(names);
  // A reroute names another model on the same button. Its fade
  // (./modelLabels.css) replays there, so the keyboard focus stays on it.
  const namesShown = useRef(names);
  useLayoutEffect(() => {
    const before = namesShown.current;
    namesShown.current = names;
    for (const [id, name] of Object.entries(names ?? {})) {
      const element = nameRefs.current.get(id);
      if (!element || before?.[id] === undefined || before[id] === name) continue;
      element.style.animation = "none";
      void element.offsetWidth;
      element.style.removeProperty("animation");
    }
  }, [names]);
  const colorsRef = useRef<CrewColors>({
    accent: [127, 220, 255],
    hot: [255, 162, 87],
    boost: 1,
  });
  const lastRead = useRef(0);
  const paintedTheme = useRef<Theme | undefined>(undefined);
  const ariaRef = useRef("");
  /** Whether the last frame painted anything, so an empty ring skips the clears. */
  const paintedRef = useRef(true);
  /** Whether the layers hold a frame, so a ring that mounted behind the stack draws once. */
  const pictureRef = useRef(false);

  // The summary, its brackets and its hairline follow the painted crewmate.
  // Every write compares first, so a paused stage touches no DOM.
  const placeSummary = useCallback(() => {
    const view = viewRef.current;
    const wrap = wrapRef.current;
    const layer = layerRef.current;
    const target = targetRef.current;
    const line = lineRef.current;
    const panel = panelRef.current;
    const cm = view && markOf(stageMarks(view.frame), shownRef.current, pointerRef.current);
    if (!view || !cm || !wrap || !layer || !target || !line || !panel) return;
    const rect = wrap.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Window coordinates to the layer's own, with clear air round each edge.
    const local = (box: Box, grow: number): Box => ({
      left: box.left - cx - grow,
      top: box.top - cy - grow,
      right: box.right - cx + grow,
      bottom: box.bottom - cy + grow,
    });
    const room = roomRef.current?.() ?? {
      within: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
      avoid: [],
    };
    const reach = (cm.size * view.scale) / 2 + CREW_HOVER.bracketPadPx;
    const anchor = { x: cm.x * view.scale, y: cm.y * view.scale };
    // The summary covers neither the brackets nor the crewmate's own name.
    const clear: Box = {
      left: anchor.x - reach,
      top: anchor.y - reach,
      right: anchor.x + reach,
      bottom: anchor.y + reach,
    };
    const name = nameRefs.current.get(cm.id);
    if (name && name.getClientRects().length > 0) {
      const label = local(name.getBoundingClientRect(), 0);
      clear.left = Math.min(clear.left, label.left);
      clear.top = Math.min(clear.top, label.top);
      clear.right = Math.max(clear.right, label.right);
      clear.bottom = Math.max(clear.bottom, label.bottom);
    }
    const at = placeCrewSummary(
      anchor,
      reach,
      clear,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      {
        within: local(room.within, -SUMMARY_MARGIN_PX),
        avoid: room.avoid.map((box) => local(box, SUMMARY_MARGIN_PX)),
      },
    );
    const px = (value: number) => `${Math.round(value * 10) / 10}px`;
    writeStyle(target, "width", px(reach * 2));
    writeStyle(target, "height", px(reach * 2));
    writeStyle(target, "transform", `translate(${px(anchor.x - reach)}, ${px(anchor.y - reach)})`);
    writeStyle(panel, "transform", `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`);
    writeStyle(line, "width", px(at.line.length));
    writeStyle(
      line,
      "transform",
      `translate(${px(at.line.x)}, ${px(at.line.y)}) rotate(${Math.round(at.line.angle * 1000) / 1000}rad)`,
    );
    angleRef.current = at.line.angle;
    if (!layer.hasAttribute("data-placed")) layer.setAttribute("data-placed", "");
  }, []);
  // The lit crewmate's brackets follow the painted crewmate as the summary's
  // do; every write compares first, so a paused stage touches no DOM. A lit
  // task that is no crewmate here draws nothing.
  const placeLit = useCallback(() => {
    const view = viewRef.current;
    const root = rootRef.current;
    const target = litTargetRef.current;
    const cm =
      view &&
      markOf(
        stageMarks(view.frame).filter((c) => c.phase !== "leaving"),
        litCrewRef.current,
        pointerRef.current,
      );
    const present = Boolean(view && cm);
    if (root) {
      if (present && root.getAttribute("data-crew-lit") !== litCrewRef.current)
        root.setAttribute("data-crew-lit", litCrewRef.current ?? "");
      else if (!present && root.hasAttribute("data-crew-lit"))
        root.removeAttribute("data-crew-lit");
    }
    if (!target) return;
    writeStyle(target, "display", present ? "" : "none");
    if (!view || !cm) return;
    const reach = (cm.size * view.scale) / 2 + CREW_HOVER.bracketPadPx;
    const px = (value: number) => `${Math.round(value * 10) / 10}px`;
    writeStyle(target, "width", px(reach * 2));
    writeStyle(target, "height", px(reach * 2));
    writeStyle(
      target,
      "transform",
      `translate(${px(cm.x * view.scale - reach)}, ${px(cm.y * view.scale - reach)})`,
    );
  }, []);
  // Under reduced motion no frame would place it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: litCrewId is the thing to place for
  useLayoutEffect(() => {
    placeLit();
  }, [litCrewId, placeLit]);

  // Placed before its first paint, and again whenever its text changes its
  // size or the window changes; under reduced motion no frame would do it.
  // A first placement slides it in; a new crewmate moves it from where it stood.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const line = lineRef.current;
    if (!summary || !panel || !line || !shown) return;
    const from = poseOf(panel, line);
    placeSummary();
    const before = placedFor.current?.panel === panel ? placedFor.current.target : null;
    if (before === null) openSummary(panel, line, angleRef.current);
    else if (before !== shown) moveSummary(panel, line, from, true);
    placedFor.current = { panel, target: shown };
    const observer = new ResizeObserver(placeSummary);
    observer.observe(panel);
    window.addEventListener("resize", placeSummary);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", placeSummary);
    };
  }, [summary, shown, placeSummary]);
  useSummaryFade(layerRef, leaving);

  useEffect(() => {
    // The pointer counts only on the formation itself or on the bare stage
    // behind it: a rail, the input or a card over the zone is someone else's.
    const onStage = (target: EventTarget | null): target is Element => {
      const wrap = wrapRef.current;
      return (
        interactiveRef.current &&
        wrap !== null &&
        target instanceof Element &&
        (wrap.contains(target) || target.contains(wrap))
      );
    };
    // The formation's box is re-measured on layout changes and at most every
    // quarter second of movement, so a sweep never forces a layout per event.
    let rect: DOMRect | null = null;
    let measuredAt = 0;
    const invalidate = () => {
      rect = null;
    };
    const leave = () => {
      pointerRef.current = null;
      dismissedRef.current = null;
      setHovered(null);
    };
    const onMove = (e: PointerEvent) => {
      const wrap = wrapRef.current;
      if (!wrap || !onStage(e.target)) {
        leave();
        return;
      }
      const real = performance.now();
      if (!rect || real - measuredAt > 250) {
        rect = wrap.getBoundingClientRect();
        measuredAt = real;
      }
      const x = e.clientX - (rect.left + rect.width / 2);
      const y = e.clientY - (rect.top + rect.height / 2);
      pointerRef.current = { x, y, movedAt: real };
      const view = viewRef.current;
      // A name is part of its crewmate: pointing at it points at the crewmate.
      const named = e.target.closest("[data-crew-model-name], [data-crew-mark]");
      let id = named
        ? (named.getAttribute("data-crew-model-name") ?? named.getAttribute("data-crew-mark"))
        : view
          ? crewHit(stageMarks(view.frame), x, y, view.scale, hoveredRef.current)
          : null;
      if (dismissedRef.current) {
        if (id === dismissedRef.current) id = null;
        else dismissedRef.current = null;
      }
      setHovered(id);
    };
    // Entering anything that is not the stage lets go, even where no further
    // movement would say so (a panel's own frame swallows it).
    const onOver = (e: PointerEvent) => {
      if (!onStage(e.target)) leave();
    };
    const onVisibility = () => {
      if (document.hidden) leave();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !hoveredRef.current) return;
      dismissedRef.current = hoveredRef.current;
      setHovered(null);
    };
    // A press on the crewmate being read is for the crewmate, not a tap on
    // the character it happens to be passing in front of.
    const onDown = (e: PointerEvent) => {
      if (hoveredRef.current && onStage(e.target)) e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      const id = hoveredRef.current;
      // A name is a button and opens its crewmate itself.
      if (!id || !onStage(e.target) || e.target.closest("[data-crew-model-name], [data-crew-mark]"))
        return;
      onOpenRef.current?.(id);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerover", onOver, { passive: true });
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", invalidate);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerover", onOver);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", invalidate);
      // Nobody is watching the pointer any more: the stage runs at full speed.
      stageClock.target = 1;
    };
  }, [setHovered]);
  useEffect(() => {
    if (interactive) return;
    pointerRef.current = null;
    dismissedRef.current = null;
    setHovered(null);
    setFocused(null);
  }, [interactive, setHovered]);

  // The project focus's light per crewmate, eased in real time over the
  // surface move, whatever the stage's own rate.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const lightRef = useRef<{ state: FocusLightState; at: number; duration: number | null }>({
    state: new Map(),
    at: 0,
    duration: null,
  });

  useAnimationLoop(
    (real) => {
      const reducedMotion = prefersReducedMotion();
      // Everything painted below reads stage time; only the theme re-read and
      // the pointer's rest are real time.
      const now = stageClock.advance(real);
      const light = lightRef.current;
      light.duration ??= motionToken(document.documentElement, "--dur-med");
      const warp = reducedMotion ? null : crewWarp.frame(now);
      const frame = lightFrame(
        model.update(now, reducedMotion, crewRush.level(now), warp),
        focusRef.current ?? { project: null, projectOf: () => undefined },
        light.state,
        light.at === 0 ? 0 : real - light.at,
        reducedMotion ? 0 : light.duration,
      );
      light.at = real;
      // Faded behind the card stack: clocks, the model and its signals keep
      // running; drawing and label writes wait until the character is shown.
      if (skipHiddenPaint(pictureRef.current)) {
        stageClock.target = stageRateTarget(null);
        for (const cue of model.takeCues()) {
          if (cue.kind === "sendoff") requestCharacterSendoff(cue.dx, cue.dy, cue.strength);
          else requestCharacterReceive();
        }
        const label = `Crew - ${frame.working} working, ${frame.idle} idle`;
        if (label !== ariaRef.current) {
          ariaRef.current = label;
          nearRef.current?.setAttribute("aria-label", label);
        }
        return;
      }
      const viewport = { width: viewportWidth, height: viewportHeight };
      const box = sceneBox(frame.scene, viewport, extent);
      for (const canvas of [nearRef.current, farRef.current]) {
        if (!canvas) continue;
        writeStyle(canvas, "width", `${box.width}px`);
        writeStyle(canvas, "height", `${box.height}px`);
        writeStyle(canvas, "left", `${(extent - box.width) / 2}px`);
        writeStyle(canvas, "top", `${(extent - box.height) / 2}px`);
      }
      const near = layerOf(nearRef.current, box);
      const far = layerOf(farRef.current, box);
      if (!near || !far) return;
      pictureRef.current = true;
      const labelsVisible = crewModelLabelsVisible(
        computers ? frame.crew.filter((c) => c.computerId === HOME_COMPUTER) : frame.crew,
      );
      if (singleOrbitRef.current !== labelsVisible) {
        singleOrbitRef.current = labelsVisible;
        setSingleOrbit(labelsVisible);
      }
      // Each cluster decides its names for itself, by the same rule as home.
      const namedClusters = new Set<string>();
      if (computers) {
        if (labelsVisible) namedClusters.add(HOME_COMPUTER);
        for (const cluster of computers.clusters()) {
          if (cluster.id === HOME_COMPUTER) continue;
          if (crewModelLabelsVisible(frame.crew.filter((c) => c.computerId === cluster.id)))
            namedClusters.add(cluster.id);
        }
      }
      const namedKey = [...namedClusters].sort().join(",");
      if (namedRef.current !== namedKey) {
        namedRef.current = namedKey;
        setNamed(namedKey);
      }
      const scale = frame.scene
        ? sceneFit(frame.scene, viewport, extent)
        : 1 + frame.planeBlend * (Math.min(1, (viewportHeight - CREW_FIT.reservePx) / extent) - 1);
      if (frame.scene && rootRef.current)
        writeStyle(rootRef.current, "--crew-fit-scale", sceneFitCss(frame.scene, extent));
      viewRef.current = { frame, now, scale, box };
      // A crewmate that is gone, or going, lets its summary and its pause go.
      const inspected = inspectingRef.current;
      const marks = stageMarks(frame);
      const there =
        inspected !== null && marks.some((c) => c.id === inspected && c.phase !== "leaving");
      if (inspected !== null && !there) {
        setHovered(null);
        setFocused(null);
      }
      // What the stage eases toward from the next frame on. Reduced motion has
      // no rate: its one settled frame is already still.
      const pointer = pointerRef.current;
      if (reducedMotion) stageClock.settle();
      else
        stageClock.target = stageRateTarget(
          interactiveRef.current
            ? {
                crew: frame.orbits.length > 0,
                inZone:
                  pointer !== null &&
                  inCrewZone({ orbits: frame.orbits, crew: marks }, pointer.x, pointer.y, scale),
                onCrewmate: there,
                restedMs: pointer ? real - pointer.movedAt : Number.POSITIVE_INFINITY,
              }
            : null,
        );
      const rate = String(Math.round(stageClock.rate * 1000) / 1000);
      if (near.canvas.dataset.stageRate !== rate) near.canvas.dataset.stageRate = rate;
      const travel = String(Math.round(frame.travel * 100) / 100);
      if (near.canvas.dataset.crewTravel !== travel) near.canvas.dataset.crewTravel = travel;
      const warpName = warp?.variant ?? "";
      if ((near.canvas.dataset.crewWarp ?? "") !== warpName) {
        if (warpName) near.canvas.dataset.crewWarp = warpName;
        else delete near.canvas.dataset.crewWarp;
      }
      if (shownRef.current) placeSummary();
      placeLit();
      const present = new Set<string>();
      for (const cm of frame.crew) {
        const element = nameRefs.current.get(cm.id);
        if (!element) continue;
        if (element.parentElement && !element.parentElement.hasAttribute("data-painted"))
          element.parentElement.setAttribute("data-painted", "");
        present.add(cm.id);
        const placement = crewModelLabelPlacement(cm, extent, scale, box.width / 2);
        const transform = `translate(${placement.x}px, ${placement.y}px)`;
        if (element.parentElement?.style.transform !== transform)
          element.parentElement?.style.setProperty("transform", transform);
        const glyphTarget = Boolean(
          computers && (!namedClusters.has(cm.computerId ?? HOME_COMPUTER) || !names?.[cm.id]),
        );
        const width = `${glyphTarget ? Math.max(24, cm.size) : placement.width}px`;
        if (element.style.width !== width) element.style.width = width;
        const height = glyphTarget ? `${Math.max(24, cm.size)}px` : "";
        if (element.style.height !== height) element.style.height = height;
        if (element.classList.contains("fm-computer-crew-target") !== glyphTarget)
          element.classList.toggle("fm-computer-crew-target", glyphTarget);
        if (cm.computerId && element.dataset.crewComputer !== cm.computerId)
          element.dataset.crewComputer = cm.computerId;
        else if (!cm.computerId && element.dataset.crewComputer)
          delete element.dataset.crewComputer;
        const hidden = cm.unfold <= 0.01;
        if (element.hidden !== hidden) element.hidden = hidden;
        const opacity = String(cm.alpha * cm.unfold);
        if (element.parentElement?.style.opacity !== opacity)
          element.parentElement?.style.setProperty("opacity", opacity);
      }
      for (const [id, element] of nameRefs.current) if (!present.has(id)) element.hidden = true;
      const others = programMarks(frame).filter((mark) => mark.phase !== "leaving");
      const markKey = others.map((mark) => mark.id).join(" ");
      if (markKeyRef.current !== markKey) {
        markKeyRef.current = markKey;
        setMarkIds(others.map((mark) => mark.id));
      }
      for (const mark of others) {
        const anchor = markRefs.current.get(mark.id);
        if (anchor)
          writeStyle(
            anchor,
            "transform",
            `translate(${extent / 2 + mark.x}px, ${extent / 2 + mark.y}px)`,
          );
      }
      // A cluster's name follows its seat, which glides as the scene changes.
      if (computers) {
        for (const cluster of computers.clusters()) {
          const element = clusterRefs.current.get(cluster.id);
          if (element) writeStyle(element, "transform", clusterNameTransform(cluster, extent));
        }
      }
      if (wordRef.current) placeWord();
      // An identical dataset write still queues a MutationObserver record, so
      // every per-frame DOM write compares first: a resting frame touches no DOM.
      if (near.canvas.dataset.formation !== frame.formation) {
        near.canvas.dataset.formation = frame.formation;
      }
      const blend = String(frame.planeBlend);
      if (near.canvas.dataset.planeBlend !== blend) near.canvas.dataset.planeBlend = blend;
      // Every crewmate on the stage counts on its plane; one names it only once
      // it has arrived and orbits there.
      const planeCounts = CROWDED_PLANES.map(() => 0);
      const planeCrew: string[][] = CROWDED_PLANES.map(() => []);
      for (const c of frame.crew) {
        if (c.phase === "leaving" || c.plane === undefined) continue;
        planeCounts[c.plane] = (planeCounts[c.plane] ?? 0) + 1;
        if (c.phase === "orbiting") planeCrew[c.plane]?.push(c.id);
      }
      const counts = planeCounts.join(",");
      if (near.canvas.dataset.planeCounts !== counts) near.canvas.dataset.planeCounts = counts;
      const orbiting = planeCrew.map((ids) => ids.join(" ")).join("|");
      if (near.canvas.dataset.planeCrew !== orbiting) near.canvas.dataset.planeCrew = orbiting;
      // Each task with parts by its branches, and the parts whose crewmate is
      // drawn at its node, so a journey reads the constellation it painted.
      const constellation = frame.programs
        .map((p) => `${p.id}=${p.branches.map((b) => `${b.fromId}>${b.toId}`).join(" ")}`)
        .join("|");
      if (near.canvas.dataset.constellation !== constellation)
        near.canvas.dataset.constellation = constellation;
      const seated = frame.programs.flatMap((p) => p.nodes.map((n) => n.id)).join(" ");
      if (near.canvas.dataset.constellationCrew !== seated)
        near.canvas.dataset.constellationCrew = seated;
      // Each wait and review arrow drawn, both ends on the stage as `paintFrame`
      // requires, so a journey reads the arrows it painted.
      const arrows = frame.links
        .filter(
          (link) =>
            frame.crew.some((c) => c.id === link.fromId) &&
            frame.crew.some((c) => c.id === link.toId),
        )
        .map((link) => `${link.kind}:${link.fromId}>${link.toId}`)
        .join(" ");
      if (near.canvas.dataset.crewArrows !== arrows) near.canvas.dataset.crewArrows = arrows;
      if (rootRef.current?.style.getPropertyValue("--crew-plane-blend") !== blend) {
        rootRef.current?.style.setProperty("--crew-plane-blend", blend);
      }
      for (const cue of model.takeCues()) {
        if (cue.kind === "sendoff") requestCharacterSendoff(cue.dx, cue.dy, cue.strength);
        else requestCharacterReceive();
      }
      const label = `Crew - ${frame.working} working, ${frame.idle} idle`;
      if (label !== ariaRef.current) {
        ariaRef.current = label;
        nearRef.current?.setAttribute("aria-label", label);
      }
      // With nobody out, a warp still paints its wormhole: the first mate travels alone.
      const empty =
        frame.crew.length === 0 &&
        frame.packets.length === 0 &&
        frame.programs.length === 0 &&
        !warp;
      if (empty && !paintedRef.current) return;
      paintedRef.current = !empty;
      if (
        !empty &&
        (lastRead.current === 0 || paintedTheme.current !== theme || real - lastRead.current > 400)
      ) {
        paintedTheme.current = theme;
        // Live theme switches re-paint: the wire tokens follow data-theme.
        const cs = getComputedStyle(near.canvas);
        const accent = cs.getPropertyValue("--wire-accent") || cs.getPropertyValue("--accent");
        const hot = cs.getPropertyValue("--wire-hot") || cs.getPropertyValue("--hot");
        colorsRef.current = {
          accent: parseRgb(accent, colorsRef.current.accent),
          hot: parseRgb(hot, colorsRef.current.hot),
          quiet: parseRgb(
            cs.getPropertyValue("--fg-3"),
            colorsRef.current.quiet ?? [148, 156, 168],
          ),
          boost: Number.parseFloat(cs.getPropertyValue("--wire-boost")) || 1,
        };
        lastRead.current = real;
      }
      paintFrame(near, far, box, frame, colorsRef.current, now, inspectingRef.current, warp);
    },
    `${extent}:${version}:${viewportWidth}:${viewportHeight}:${nameKey}:${theme}:${focus?.project ?? ""}`,
  );

  // A move to another display, or the size control's zoom, changes the pixel
  // ratio. The moving loop refits on its next frame; the reduced-motion still
  // has no next frame, so its last frame is painted again from its own inputs
  // at the new sharpness. Restarting the loop instead would let the ring's
  // slow turn jump to where it stands now.
  useEffect(() => {
    let raf = 0;
    const unwatch = onPixelRatioChange(() => {
      if (!prefersReducedMotion()) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const view = viewRef.current;
        if (!view) return;
        const near = layerOf(nearRef.current, view.box);
        const far = layerOf(farRef.current, view.box);
        if (!near || !far) return;
        paintFrame(
          near,
          far,
          view.box,
          view.frame,
          colorsRef.current,
          view.now,
          inspectingRef.current,
          null,
        );
      });
    });
    return () => {
      unwatch();
      cancelAnimationFrame(raf);
    };
  }, []);

  // The loop sizes and places the canvases (sceneBox); the formation's
  // square until its first frame.
  const layerStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: extent,
    height: extent,
    display: "block",
    pointerEvents: "none",
  };
  const namedClusters = new Set(named.split(",").filter(Boolean));
  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: extent, height: extent, pointerEvents: "none" }}
    >
      <div
        ref={rootRef}
        data-crew-formation
        data-crew-inspecting={inspecting ?? undefined}
        style={
          {
            position: "relative",
            width: extent,
            height: extent,
            pointerEvents: "none",
            // Fit the taller crowded formation above the activity line/input at the minimum window
            // height. CSS stays responsive even while reduced motion stops the loop.
            // The original small ring remains exactly scale 1. With several
            // computers the loop writes the whole scene's fit (sceneFitCss).
            ...(computers
              ? {}
              : {
                  "--crew-fit-scale": `calc(1 + var(--crew-plane-blend, 0) * (${crewWindowFit(extent)} - 1))`,
                }),
            "--crew-name-gap": `${CREW_MODEL_LABEL.gapPx}px`,
            transform: "scale(var(--crew-fit-scale))",
          } as React.CSSProperties
        }
      >
        <canvas ref={farRef} data-crew-layer="far" style={layerStyle} />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%,-50%)",
            pointerEvents: "auto",
          }}
        >
          {children}
        </div>
        <canvas
          ref={nearRef}
          data-crew-layer="near"
          role="img"
          aria-label="Crew - 0 working, 0 idle"
          style={layerStyle}
        />
        <fieldset
          className="fm-crew-model-names"
          aria-label="Crew model names"
          hidden={!singleOrbit && !computers}
        >
          {Object.entries(
            computers
              ? Object.fromEntries(
                  model.present().map((id) => [id, names?.[id] ?? facts?.[id]?.task.title ?? id]),
                )
              : (names ?? {}),
          ).map(([id, name]) => (
            <div className="fm-crew-model-anchor" data-crew-model-anchor={id} key={id}>
              <button
                ref={(node) => {
                  if (node) nameRefs.current.set(id, node);
                  else nameRefs.current.delete(id);
                }}
                type="button"
                className="fm-crew-model-name"
                data-crew-model-name={id}
                aria-label={name}
                aria-expanded={inspecting === id}
                tabIndex={interactive ? 0 : -1}
                style={{ pointerEvents: interactive ? "auto" : "none" }}
                onFocus={() => setFocused(id)}
                onBlur={() => setFocused(null)}
                onClick={() => onOpen?.(id)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.currentTarget.blur();
                }}
              >
                {computers && (!namedClusters.has(computers.computerOf(id)) || !names?.[id]) ? (
                  <span className="fm-computer-crew-accessible">{name}</span>
                ) : (
                  name
                )}
              </button>
            </div>
          ))}
        </fieldset>
        {markIds.length > 0 && (
          <fieldset className="fm-crew-model-names" aria-label="Programs and their parts">
            {markIds.map((id) => {
              const name = facts?.[id]?.task.title ?? facts?.[id]?.task.key ?? "A part";
              return (
                <div
                  className="fm-crew-model-anchor"
                  data-painted=""
                  key={id}
                  ref={(node) => {
                    if (node) markRefs.current.set(id, node);
                    else markRefs.current.delete(id);
                  }}
                >
                  <button
                    type="button"
                    className="fm-crew-model-name fm-computer-crew-target"
                    data-crew-mark={id}
                    aria-label={name}
                    aria-expanded={inspecting === id}
                    tabIndex={interactive ? 0 : -1}
                    style={{ pointerEvents: interactive ? "auto" : "none", width: 24, height: 24 }}
                    onFocus={() => setFocused(id)}
                    onBlur={() => setFocused(null)}
                    onClick={() => onOpen?.(id)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") event.currentTarget.blur();
                    }}
                  >
                    <span className="fm-computer-crew-accessible">{name}</span>
                  </button>
                </div>
              );
            })}
          </fieldset>
        )}
        {clusters.map((cluster) => (
          <div
            key={cluster.id}
            ref={(node) => {
              if (node) clusterRefs.current.set(cluster.id, node);
              else clusterRefs.current.delete(cluster.id);
            }}
            className="fm-computer-name"
            data-computer-cluster={cluster.id}
            data-computer-reachable={cluster.reachable}
            style={{ left: 0, top: 0, transform: clusterNameTransform(cluster, extent) }}
          >
            <span>{cluster.name}</span>
            {!cluster.reachable && <span className="fm-computer-unreachable">Out of reach</span>}
          </div>
        ))}
        <div className="fm-crew-state-words" aria-live="off">
          <div className="fm-crew-state-word-anchor">
            {word && (
              <div
                ref={wordElementRef}
                className="fm-crew-state-word"
                data-crew-state-word={word.word}
                data-crew-state-word-for={word.id}
                data-on={word.on ? "true" : "false"}
                style={
                  {
                    "--crew-state-word-gap": `${CREW_STATE_WORD.gapPx}px`,
                    "--crew-state-word-fade-in": `${CREW_STATE_WORD.fadeInMs}ms`,
                    "--crew-state-word-fade-out": `${CREW_STATE_WORD.fadeOutMs}ms`,
                  } as React.CSSProperties
                }
              >
                {CREW_STATE_WORD.words[word.word]}
              </div>
            )}
          </div>
        </div>
      </div>
      {computers && computers.pages > 1 && (
        <nav
          className="fm-computer-pages"
          aria-label="Work computers"
          style={{ top: extent / 2 + Math.min(248, (viewportHeight - CREW_FIT.reservePx) / 2) }}
        >
          <button
            type="button"
            disabled={computers.page === 0 || !interactive}
            onClick={() => computers.setPage(computers.page - 1)}
          >
            Previous computers
          </button>
          <span>
            {computers.page + 1} / {computers.pages}
          </span>
          <button
            type="button"
            disabled={computers.page + 1 === computers.pages || !interactive}
            onClick={() => computers.setPage(computers.page + 1)}
          >
            Next computers
          </button>
        </nav>
      )}
      {/* The lit crewmate's brackets (INF-237): the summary's brackets alone. */}
      {litCrewId && (
        <div className="fm-crew-summary-layer" data-placed="" aria-hidden="true">
          <div
            ref={litTargetRef}
            className="fm-crew-target"
            data-crew-lit-target={litCrewId}
            style={{ display: "none" }}
          >
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
      )}
      {/* Outside the fitted formation, so the summary's type is never scaled. */}
      {summary && shown && (
        <div
          ref={layerRef}
          className="fm-crew-summary-layer"
          aria-hidden={leaving || undefined}
          style={{ "--crew-summary-max": `${CREW_HOVER.maxWidthPx}px` } as React.CSSProperties}
        >
          <div
            ref={targetRef}
            className="fm-crew-target"
            data-crew-target={shown}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
            <i />
          </div>
          <div ref={lineRef} className="fm-crew-summary-line" aria-hidden="true" />
          <div ref={panelRef}>
            <CrewSummary taskId={shown} facts={summary} />
          </div>
        </div>
      )}
    </div>
  );
}
