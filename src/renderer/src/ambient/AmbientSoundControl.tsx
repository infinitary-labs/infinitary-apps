import * as m from "@shared/i18n/messages.generated";
import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { useCardSound } from "../cards/playingSound";
import { onReducedMotionChange, prefersReducedMotion } from "../character/reducedMotion";
import { IconButton } from "../design";
import { readAmbientBands } from "./ambient";
import "./soundControl.css";

const X = [4.5, 9.5, 14.5, 19.5];
// The captain's Calm look (INF-5053), in units of the 24-unit icon: a bar
// rests at 4 and peaks at 16 at any volume above zero, rising and falling
// slowly. The drawn line is 4 units long, so a bar's height is its scale times 4.
const REST = 4;
const PEAK = 16;
const RISE = 0.35;
const FALL = 0.1;
// Each band is measured against its own recent quietest and loudest level,
// forgetting them over about 3.3 s at 30 samples a second, so every bar uses
// its full height; a range narrower than this is read as this wide.
const FORGET = 0.01;
const NARROWEST_RANGE = 0.15;

/** Only the icon's transforms change on a sample, never the top bar's React tree. */
function SoundMark({
  paused,
  hushed,
  silent,
}: {
  paused: boolean;
  hushed: boolean;
  silent: boolean;
}) {
  const icon = useRef<SVGSVGElement>(null);
  const reduced = useSyncExternalStore(onReducedMotionChange, prefersReducedMotion);
  useEffect(() => {
    if (paused || hushed || reduced || silent || !icon.current) return;
    const bars = Array.from(icon.current.querySelectorAll("line"));
    const levels = X.map(() => 0);
    const low = X.map(() => 1);
    const high = X.map(() => 0);
    const smooth = X.map(() => 0);
    let timer: number | undefined;
    const paint = () => {
      const live = readAmbientBands(levels);
      for (const [i, bar] of bars.entries()) {
        let target = 0;
        if (live) {
          const level = levels[i] ?? 0;
          const lo = low[i] ?? 1;
          const hi = high[i] ?? 0;
          const nextLow = lo + (level - lo) * (level < lo ? 0.5 : FORGET);
          const nextHigh = hi + (level - hi) * (level > hi ? 0.5 : FORGET);
          low[i] = nextLow;
          high[i] = nextHigh;
          const range = Math.max(nextHigh - nextLow, NARROWEST_RANGE);
          target = Math.max(0, Math.min(1, (level - nextLow) / range));
        }
        const was = smooth[i] ?? 0;
        const next = was + (target - was) * (target > was ? RISE : FALL);
        smooth[i] = next;
        bar.style.transform = `scaleY(${(REST + (PEAK - REST) * next) / 4})`;
      }
    };
    const sync = () => {
      window.clearInterval(timer);
      if (!document.hidden) timer = window.setInterval(paint, 1000 / 30);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
      for (const bar of bars) bar.style.removeProperty("transform");
    };
  }, [paused, hushed, reduced, silent]);
  return (
    <svg
      ref={icon}
      className="ambient-mark"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {X.map((x) => (
        <line
          key={x}
          x1={x}
          x2={x}
          y1={10}
          y2={14}
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

export function AmbientSoundControl() {
  const on = useShellStore((s) => s.ambientMusic);
  return on ? <EnabledSoundControl /> : null;
}

function EnabledSoundControl() {
  const paused = useShellStore((s) => s.ambientPaused);
  const volume = useShellStore((s) => s.ambientVolume);
  const setVolume = useShellStore((s) => s.setAmbientVolume);
  const toggle = useShellStore((s) => s.toggleAmbientPlayback);
  const recording = useShellStore((s) => s.recording);
  const sound = useCardSound((s) => s.playing || s.demo);
  const hushed = !paused && (recording || sound);
  const error = useShellStore((s) =>
    s.appearanceError?.choice === "ambientPaused" || s.appearanceError?.choice === "ambientVolume"
      ? s.appearanceError.message
      : undefined,
  );
  const [rested, setRested] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const rest = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(rest.current), []);
  const open = !dismissed && (rested || focused);
  const label = paused ? m.shellAmbientPlay() : m.shellAmbientPause();
  const keys = useCommandKeys("ambient.toggle");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The group only delegates keys from the focusable button and slider.
    <div
      data-ambient-control=""
      data-paused={paused || undefined}
      data-hushed={hushed || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        setDismissed(false);
        rest.current = window.setTimeout(() => setRested(true), 500);
      }}
      onPointerLeave={() => {
        window.clearTimeout(rest.current);
        setRested(false);
      }}
      onFocus={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDismissed(false);
        if (event.target.matches(":focus-visible")) setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          button.current?.focus();
          setDismissed(true);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        setDismissed(false);
        setFocused(true);
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const up = (event.key === "ArrowRight") !== rtl;
        setVolume(Math.max(0, Math.min(100, volume + (up ? 5 : -5))));
      }}
    >
      <IconButton
        ref={button}
        label={label}
        {...keys}
        restWords={error ?? (hushed ? m.shellAmbientQuiet() : undefined)}
        onClick={toggle}
      >
        <SoundMark paused={paused} hushed={hushed} silent={volume === 0} />
      </IconButton>
      <div className="ambient-volume-reveal" data-open={open || undefined} inert={!open}>
        <div className="ambient-volume-pill">
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label={m.settingsSoundVolume()}
            onChange={(event) => setVolume(Number(event.currentTarget.value))}
            style={{ "--ambient-fill": `${volume}%` } as CSSProperties}
          />
          <span aria-hidden="true">{volume}%</span>
        </div>
      </div>
    </div>
  );
}
