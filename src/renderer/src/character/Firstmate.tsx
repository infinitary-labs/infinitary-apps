import * as m from "@shared/i18n/messages.generated";
import type { Theme } from "@shared/preferences";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { readLiveVoiceLevel } from "../voice/liveVoiceLevel";
import { crewRush } from "./crew/rush";
import { crewSupernova } from "./crew/supernova";
import { crewWarp } from "./crew/warp";
import {
  takeCharacterEmote,
  takeCharacterNotice,
  takeCharacterReceive,
  takeCharacterSendoff,
  takeStageClearedFidget,
} from "./emoteSignal";
import {
  createSim,
  drawFrame,
  fitBacking,
  type PointerGazeConfig,
  resolvePointerSetup,
  type Sim,
} from "./firstmatePainter";
import { flickerMerge, takeFirstmateFlicker } from "./flicker";
import {
  FIDGET_DURATION_MS,
  FirstmateMachine,
  type FirstmateState,
  type MachineSnapshot,
} from "./machine";
import { useAnimationLoop } from "./motion";
import { skipHiddenPaint } from "./paintHidden";
import { onPixelRatioChange } from "./pixelRatio";
import { prefersReducedMotion } from "./reducedMotion";
import { stageClock, stageNow } from "./stageClock";
import { isWarp } from "./warp";

// The Firstmate on the home stage: the painter (./firstmatePainter) draws it,
// and this component feeds it the machine, the app's signals, the pointer
// and the drawing loop. A card's stage part draws the same painter
// (./stage/cardStage).

export type FirstmateProps = {
  /** Attention is on the character: voice recording or text in the input. */
  listening?: boolean;
  /** The Firstmate agent's own turn is running - drives the ember. */
  busy?: boolean;
  /** Preserved animation input that folds the working form into the crystal. */
  crystalActive?: boolean;
  /** The first mate is shortening its conversation: the cinch over working (./cinch). */
  folding?: boolean;
  /** Monotonic count of shortenings begun; each increment plays a cinch, even one heard only ending. */
  foldStarts?: number;
  /** Cards cover the character: its idle fidgets wait until they leave. */
  hidden?: boolean;
  /** Canvas size in px. Null state is 280-320; docked is 56-72. */
  size?: number;
  /** 0-1 live voice level; scales the structure and spin while listening. */
  level?: number;
  /**
   * Monotonic counter; each increment kicks the listening spin. A reader is
   * called on each drawing frame instead, so a keystroke reaches the spin
   * without rendering the character again (INF-1073).
   */
  kick?: number | (() => number);
  /** Monotonic counter; each increment is a submitted turn (plays intake). */
  submitSignal?: number;
  /** The eyes follow the pointer anywhere in the window (default on); an object tunes it. */
  followPointer?: boolean | PointerGazeConfig;
  /** The shell's theme: a switch repaints the character in its colors, a reduced-motion still included. */
  theme?: Theme;
  style?: React.CSSProperties;
};

/** What the last frame was drawn from, so the reduced-motion still can be drawn again. */
type DrawnFrame = {
  now: number;
  real: number;
  snap: MachineSnapshot;
  level: number;
  kick: number;
};

export function Firstmate({
  listening = false,
  busy = false,
  crystalActive = false,
  folding = false,
  foldStarts = 0,
  hidden = false,
  size = 280,
  level = 0,
  kick = 0,
  submitSignal = 0,
  followPointer = true,
  theme,
  style,
}: FirstmateProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pointerSetupRef = useRef(resolvePointerSetup(followPointer));
  pointerSetupRef.current = resolvePointerSetup(followPointer);
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const crystalActiveRef = useRef(crystalActive);
  crystalActiveRef.current = crystalActive;
  const foldingRef = useRef(folding);
  foldingRef.current = folding;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const foldStartsRef = useRef(foldStarts);
  foldStartsRef.current = foldStarts;
  const levelRef = useRef(level);
  levelRef.current = level;
  const kickRef = useRef(kick);
  kickRef.current = kick;
  const readKick = () =>
    typeof kickRef.current === "function" ? kickRef.current() : kickRef.current;
  const submitRef = useRef(submitSignal);
  submitRef.current = submitSignal;
  const simRef = useRef<Sim | null>(null);
  const machineRef = useRef<FirstmateMachine | null>(null);
  const lastSubmit = useRef(submitSignal);
  const ariaState = useRef<FirstmateState>("idle");
  const drawnRef = useRef<DrawnFrame | null>(null);
  /** Whether the canvas holds a picture: a new or resized backing holds none. */
  const pictureRef = useRef(false);
  const lastTheme = useRef(theme);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // A tap on the character: fidget when idle, a spin kick otherwise.
    const onPointerDown = () => {
      const machine = machineRef.current;
      if (!machine) return;
      if (machine.tap(stageNow()) === "kick" && simRef.current) {
        simRef.current.vel = Math.min(simRef.current.vel + 1.4, 30);
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    return () => canvas.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // The pointer anywhere in the window feeds the gaze as an offset from the
    // character's center in character sizes. The rect is re-measured on
    // layout changes and at most every quarter second of movement, so a
    // pointer sweep never forces a layout per event.
    let rect: DOMRect | null = null;
    let measuredAt = 0;
    const invalidate = () => {
      rect = null;
    };
    const onMove = (e: PointerEvent) => {
      const sim = simRef.current;
      if (!sim || !pointerSetupRef.current.enabled) return;
      const now = performance.now();
      if (!rect || now - measuredAt > 250) {
        rect = canvas.getBoundingClientRect();
        measuredAt = now;
      }
      const s = rect.width || 1;
      sim.pointer.move(
        (e.clientX - (rect.left + rect.width / 2)) / s,
        (e.clientY - (rect.top + rect.height / 2)) / s,
      );
    };
    const onLeave = () => simRef.current?.pointer.leave();
    const onVisibility = () => {
      if (document.hidden) onLeave();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, { capture: true });
    };
  }, []);

  useAnimationLoop((real) => {
    const canvas = ref.current;
    if (!canvas) return;
    const now = stageClock.advance(real);
    if (!machineRef.current) {
      machineRef.current = new FirstmateMachine(now);
      // A small hello when the app opens.
      machineRef.current.requestEmote("greet", now);
    }
    const machine = machineRef.current;
    if (fitBacking(canvas, size)) pictureRef.current = false;
    if (!simRef.current || simRef.current.size !== size) {
      simRef.current = createSim(size, canvas, readKick(), foldStartsRef.current);
    }
    if (submitRef.current !== lastSubmit.current) {
      lastSubmit.current = submitRef.current;
      machine.noteSubmit(now);
    }
    // Inputs first, then the requests: an emote asked for in the frame a
    // turn starts is judged against that turn, so a reply is held for the
    // turn's end instead of starting and being cut by the turn's own start.
    machine.setInputs(
      {
        listening: listeningRef.current,
        busy: busyRef.current,
        crystalActive: crystalActiveRef.current,
        folding: foldingRef.current,
        hidden: hiddenRef.current,
      },
      now,
    );
    simRef.current.cinch.update(now, foldingRef.current, foldStartsRef.current);
    for (let e = takeCharacterEmote(); e; e = takeCharacterEmote()) {
      machine.requestEmote(e, now);
    }
    // A still frame plays nothing, so a stage-cleared fidget is let go.
    if (takeStageClearedFidget() && !prefersReducedMotion()) machine.stageCleared(now);
    if (takeCharacterNotice()) simRef.current.noticeAt = now;
    const sendoff = takeCharacterSendoff();
    if (sendoff) {
      simRef.current.sendoffAt = now;
      simRef.current.sendoffDir = { dx: sendoff.dx, dy: sendoff.dy };
      simRef.current.sendoffStrength = sendoff.strength;
    }
    if (takeCharacterReceive()) simRef.current.receiveAt = now;
    for (let fl = takeFirstmateFlicker(); fl !== undefined; fl = takeFirstmateFlicker()) {
      const sim = simRef.current;
      sim.flickerBoost = flickerMerge(sim.flickerAt, sim.flickerBoost, fl, now);
      sim.flickerAt = now;
    }
    const snap = machine.update(now);
    // The black hole sends the crew racing (./crew/rush.ts) on this fidget's
    // own clock; ended or cut short, they settle back. A still frame plays
    // nothing.
    if (snap.state === "fidget" && snap.variant === "blackhole" && !prefersReducedMotion()) {
      crewRush.playing(now - snap.phase, FIDGET_DURATION_MS.blackhole, now);
    } else crewRush.stopped(now);
    // A warp takes the crew along (./crew/warp.ts) on the same clock.
    if (snap.state === "fidget" && isWarp(snap.variant) && !prefersReducedMotion()) {
      const sim = simRef.current;
      crewWarp.playing(snap.variant, now - snap.phase, size * 0.27, sim.heat);
    } else crewWarp.stopped(now);
    // The supernova's blast reaches through the crew (./crew/supernova.ts).
    if (snap.state === "fidget" && snap.variant === "supernova" && !prefersReducedMotion()) {
      crewSupernova.playing(now - snap.phase, size * 0.27, simRef.current.heat);
    } else crewSupernova.stopped(now);
    if (snap.state !== ariaState.current) ariaState.current = snap.state;
    const drawn = {
      now,
      real,
      snap,
      level: readLiveVoiceLevel(levelRef.current),
      kick: readKick(),
    };
    drawnRef.current = drawn;
    // The state name stays current while faded: it is the signal, not the paint.
    const label = m.crewFirstmateLabel({ state: snap.state });
    if (canvas.getAttribute("aria-label") !== label) canvas.setAttribute("aria-label", label);
    // Faded behind the card stack: keep the machine, skip the canvas drawing.
    if (skipHiddenPaint(pictureRef.current)) return;
    drawFrame(
      simRef.current,
      canvas,
      drawn.now,
      drawn.real,
      drawn.snap,
      drawn.level,
      drawn.kick,
      pointerSetupRef.current,
    );
    pictureRef.current = true;
  }, size);

  // The reduced-motion still has no next frame, so a change to how it should
  // look draws the last frame again from its own inputs, on the next drawing
  // frame: no time passes and the machine does not step, so the same picture
  // comes back. A change made mid-turn cannot leave the still showing a turn
  // that has since ended.
  const redrawStill = useCallback(
    () =>
      requestAnimationFrame(() => {
        const sim = simRef.current;
        const canvas = ref.current;
        const drawn = drawnRef.current;
        if (!sim || !canvas || !drawn) return;
        fitBacking(canvas, sim.size);
        drawFrame(
          sim,
          canvas,
          drawn.now,
          drawn.real,
          drawn.snap,
          drawn.level,
          drawn.kick,
          pointerSetupRef.current,
        );
      }),
    [],
  );

  // A theme switch re-reads the colors on the next frame rather than at the
  // next timed re-read; the still comes back in the new colors.
  useEffect(() => {
    if (lastTheme.current === theme) return;
    lastTheme.current = theme;
    const sim = simRef.current;
    if (!sim) return;
    sim.lastRead = 0;
    if (!prefersReducedMotion()) return;
    const raf = redrawStill();
    return () => cancelAnimationFrame(raf);
  }, [theme, redrawStill]);

  // A size change (the window's zoom) or a move to another display changes
  // the pixel ratio but not the size prop. The moving loop refits on its next
  // frame; the still comes back at the new sharpness instead of stretched.
  useEffect(() => {
    let raf = 0;
    const unwatch = onPixelRatioChange(() => {
      if (!prefersReducedMotion()) return;
      cancelAnimationFrame(raf);
      raf = redrawStill();
    });
    return () => {
      unwatch();
      cancelAnimationFrame(raf);
    };
  }, [redrawStill]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={m.crewFirstmateLabel({ state: "idle" })}
      style={{ width: size, height: size, display: "block", ...style }}
    />
  );
}
