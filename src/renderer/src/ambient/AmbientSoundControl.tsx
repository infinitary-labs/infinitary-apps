import type { SavedOwnStyle } from "@shared/ambientOwn";
import * as m from "@shared/i18n/messages.generated";
import { ambientStyleIn } from "@shared/preferences";
import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mainMessageRefusal } from "../app/composer";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { useCardSound } from "../cards/playingSound";
import { onReducedMotionChange, prefersReducedMotion } from "../character/reducedMotion";
import { IconButton } from "../design";
import { readAmbientBands } from "./ambient";
import {
  describeOwnStyle,
  STYLE_GROUPS,
  STYLE_WORDS,
  styleWords,
  useStyleListAsk,
} from "./styleList";
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
function SoundMark({ off, hushed, silent }: { off: boolean; hushed: boolean; silent: boolean }) {
  const icon = useRef<SVGSVGElement>(null);
  const reduced = useSyncExternalStore(onReducedMotionChange, prefersReducedMotion);
  useEffect(() => {
    if (off || hushed || reduced || silent || !icon.current) return;
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
  }, [off, hushed, reduced, silent]);
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

/**
 * The sound button, shown whether the music is on or off: a press turns
 * Settings' Ambient music switch on or off (docs/ambient-music.md).
 */
export function AmbientSoundControl() {
  const off = !useShellStore((s) => s.ambientMusic);
  const setMusic = useShellStore((s) => s.setAmbientMusic);
  const volume = useShellStore((s) => s.ambientVolume);
  const setVolume = useShellStore((s) => s.setAmbientVolume);
  const recording = useShellStore((s) => s.recording);
  const sound = useCardSound((s) => s.playing || s.demo);
  const hushed = !off && (recording || sound);
  const error = useShellStore((s) =>
    s.appearanceError?.choice === "ambientMusic" ||
    s.appearanceError?.choice === "ambientVolume" ||
    s.appearanceError?.choice === "ambientStyle"
      ? s.appearanceError.message
      : undefined,
  );
  // A style a newer Infinitary saved shows, and plays, as the default.
  const own = useShellStore((s) => s.ambientOwnStyles);
  const style = ambientStyleIn(
    useShellStore((s) => s.ambientStyle),
    own,
  );
  const [rested, setRested] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [listed, setListed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list takes focus once drawn when keys or the command opened it.
  const focusList = useRef(false);
  const rest = useRef<number | undefined>(undefined);
  const nameRest = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(rest.current);
      window.clearTimeout(nameRest.current);
    },
    [],
  );
  const open = !dismissed && (rested || focused);
  const listOpen = open && listed;
  // Closing the pill closes the list with it.
  useEffect(() => {
    if (!open) setListed(false);
  }, [open]);
  const asked = useStyleListAsk((s) => s.asked);
  useEffect(() => {
    if (!asked) return;
    useStyleListAsk.setState({ asked: false });
    focusList.current = true;
    setDismissed(false);
    setFocused(true);
    setListed(true);
  }, [asked]);
  useEffect(() => {
    if (!listOpen || !focusList.current) return;
    focusList.current = false;
    list.current?.querySelector<HTMLElement>("[tabindex='0']")?.focus({ preventScroll: true });
  }, [listOpen]);
  const showList = (withFocus: boolean) => {
    focusList.current = withFocus;
    setDismissed(false);
    setListed(true);
  };
  const label = off ? m.shellAmbientPlay() : m.shellAmbientStop();
  const keys = useCommandKeys("ambient.toggle");
  const styleName = styleWords(style, own).name;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The group only delegates keys from the focusable button and slider.
    <div
      data-ambient-control=""
      data-off={off || undefined}
      data-hushed={hushed || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        setDismissed(false);
        rest.current = window.setTimeout(() => setRested(true), 500);
      }}
      onPointerLeave={() => {
        window.clearTimeout(rest.current);
        window.clearTimeout(nameRest.current);
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
        if (event.key === "Escape" && listOpen) {
          // The list first, then the pill, each giving focus back to where it opened.
          event.preventDefault();
          event.stopPropagation();
          if (list.current?.contains(document.activeElement)) name.current?.focus();
          setListed(false);
          return;
        }
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          button.current?.focus();
          setDismissed(true);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        // The volume moves only from the button and the slider.
        if (event.target !== button.current && !(event.target as Element).matches("input")) return;
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
        onClick={() => setMusic(off)}
      >
        <SoundMark off={off} hushed={hushed} silent={volume === 0} />
      </IconButton>
      <div className="ambient-volume-reveal" data-open={open || undefined} inert={!open}>
        <div className="ambient-volume-pill">
          <button
            ref={name}
            type="button"
            className="ambient-style-name"
            data-ambient-style-name=""
            aria-haspopup="menu"
            aria-expanded={listOpen}
            aria-label={m.shellAmbientStyleNamed({ name: styleName })}
            onClick={(event) => {
              window.clearTimeout(nameRest.current);
              // A press by keys (no pointer position) moves focus into the list.
              if (listOpen) setListed(false);
              else showList(event.detail === 0);
            }}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              nameRest.current = window.setTimeout(() => showList(false), 500);
            }}
            onPointerLeave={() => window.clearTimeout(nameRest.current)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              if (listOpen) list.current?.querySelector<HTMLElement>("[tabindex='0']")?.focus();
              else showList(true);
            }}
          >
            <span>{styleName}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.5 4l2.5 2.5L7.5 4"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {listOpen && <StyleList ref={list} chosen={style} own={own} off={off} />}
          <span className="ambient-pill-rule" aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label={m.settingsSoundVolume()}
            onChange={(event) => setVolume(Number(event.currentTarget.value))}
            style={{ "--ambient-fill": `${volume}%` } as CSSProperties}
          />
          <span className="ambient-volume-percent" aria-hidden="true">
            {volume}%
          </span>
        </div>
      </div>
    </div>
  );
}

/** Three small bars marking the chosen style, as the sound button's own mark. */
function PlayingMark() {
  return (
    <svg className="ambient-style-on" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 15v-6M12 18V6M18 14v-4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The sound button's style list (docs/ambient-music.md): Settings' groups
 * and names, the line of the style under the pointer or focus at its foot,
 * and Describe your own last. A pick plays at once, turning the music on
 * if it was off, and the list stays open for the next try.
 */
function StyleList({
  ref,
  chosen,
  own,
  off,
}: {
  ref: React.Ref<HTMLDivElement>;
  chosen: string;
  own: readonly SavedOwnStyle[];
  off: boolean;
}) {
  const setStyle = useShellStore((s) => s.setAmbientStyle);
  const setMusic = useShellStore((s) => s.setAmbientMusic);
  const refusal = useShellStore(mainMessageRefusal);
  const [shown, setShown] = useState<string | null>(null);
  const groups: [string, { id: string; name: string }[]][] = STYLE_GROUPS.map(([group, styles]) => [
    group(),
    styles.map((id) => ({ id, name: STYLE_WORDS[id].name() })),
  ]);
  if (own.length > 0)
    groups.push([
      m.settingsSoundStyleGroupYours(),
      own.map((style) => ({ id: style.id, name: style.name })),
    ]);
  const foot =
    shown === DESCRIBE
      ? (refusal ?? m.settingsSoundOwnDescription())
      : styleWords(shown ?? chosen, own).description;
  const pick = (id: string) => {
    if (id !== chosen) setStyle(id);
    if (off) setMusic(true);
  };
  return (
    <div
      ref={ref}
      className="ambient-style-list"
      role="menu"
      aria-label={m.settingsSoundStyle()}
      data-ambient-style-list=""
      onPointerLeave={() => setShown(null)}
      onFocus={(event) => setShown(event.target.dataset.ambientStyleOption ?? null)}
      onKeyDown={(event) => {
        const self = event.currentTarget;
        const items = [...self.querySelectorAll<HTMLElement>("[role^=menuitem]")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        const to =
          event.key === "ArrowDown"
            ? (at + 1) % items.length
            : event.key === "ArrowUp"
              ? (at - 1 + items.length) % items.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : -1;
        if (to < 0) return;
        event.preventDefault();
        event.stopPropagation();
        items[to]?.focus();
      }}
    >
      <div className="ambient-style-groups">
        {groups.map(([group, styles]) => (
          // biome-ignore lint/a11y/useSemanticElements: a menu's group, not a form's
          <div key={group} className="ambient-style-group" role="group" aria-label={group}>
            <span className="ambient-style-kind" aria-hidden="true">
              {group}
            </span>
            <div className="ambient-style-rows">
              {styles.map(({ id, name }) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  className="ambient-style-row"
                  aria-checked={id === chosen}
                  tabIndex={id === chosen ? 0 : -1}
                  data-ambient-style-option={id}
                  onPointerEnter={() => setShown(id)}
                  onClick={() => pick(id)}
                >
                  <span>{name}</span>
                  <PlayingMark />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="ambient-style-rule" />
      <p className="ambient-style-foot" aria-live="polite">
        {foot}
      </p>
      <button
        type="button"
        role="menuitem"
        className="ambient-style-row ambient-style-describe"
        tabIndex={-1}
        aria-disabled={refusal !== null || undefined}
        aria-description={refusal ?? undefined}
        data-ambient-style-option={DESCRIBE}
        onPointerEnter={() => setShown(DESCRIBE)}
        onClick={describeOwnStyle}
      >
        <span>{m.settingsSoundOwnDescribe()}</span>
      </button>
    </div>
  );
}

/** The foot's key for Describe your own, never a style's id. */
const DESCRIBE = "describe-own";
