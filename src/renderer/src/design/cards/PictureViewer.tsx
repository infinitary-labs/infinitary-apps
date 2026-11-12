import { isDrawingSource } from "@shared/cardPictures";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { thisDesktop, WINDOW_CONTROLS_CLEARANCE } from "../core/desktop";
import { fixedKeys } from "../core/fixedKeys";
import { IconButton } from "../core/IconButton";
import { useRestLabel } from "../core/restLabel";
import { pictureHint, pictureSize } from "./pictureViewerWords";

/**
 * Where a card's picture is read (card pictures, phase 3 of the locked
 * plan). Host chrome over the whole window, at the size the window allows -
 * never inside the card, whose body is a sandboxed frame exactly the card's
 * size, and never only between the docked rails - opened from the frame
 * bridge's `image` message and paging within that picture's group. Every
 * rule here is the design skill's `components/cards/PictureViewer.prompt.md`.
 *
 * The viewer owns its own leaving: `onClose` is called once it is gone -
 * after its fade, or at once under reduced motion - so the caller unmounts
 * it and returns focus to whatever opened it.
 */

export type ViewerPicture = {
  src: string;
  alt: string;
  /** The picture's natural size as the frame saw it; 0 while it had not decoded. */
  width: number;
  height: number;
};

/**
 * A demo recording the viewer plays in place of its poster (the design
 * skill's PictureViewer, "A demo"; docs/card-authoring.md "Demo recordings").
 */
export type ViewerDemo = {
  /** The host's served copy of the recording (`isPlayableDemoSource`). */
  src: string;
  /**
   * What the recording is (`playableDemoKind`): an MP4 plays in a `<video>`
   * with Play, Pause, Replay and a seek slider; a GIF, the single-play
   * fallback, is drawn only once Play is pressed, with Play, Stop and Replay.
   */
  kind: "mp4" | "gif";
  /** The demo's figcaption, the viewer's caption; empty for none. */
  caption: string;
  /** The length the host wrote on the figure, until the player reads the real one. */
  durationMs: number;
  /** Opened from its Play button by the captain's press: it plays at once. */
  play: boolean;
};

export type PictureViewerProps = {
  /** The card's title: the header names the card. */
  title: string;
  /** The pictures to page; a demo's is its poster alone. */
  pictures: readonly ViewerPicture[];
  /** Which picture opens first. */
  index: number;
  /** A demo: the viewer plays its recording over its poster, `pictures[0]`. */
  demo?: ViewerDemo | undefined;
  onClose: () => void;
};

type Size = { width: number; height: number };

/** The header: the top bar's height, which the viewer covers. */
const HEADER_HEIGHT = 52;
/** The picture's inset from the row's sides, where the arrows sit. */
const SIDE_GUTTER = 64;
const NAV_SIZE = 36;
const THUMB = { width: 64, height: 44 };
/** A demo's player row, at most this wide (the design skill's PictureViewer, "A demo"). */
const PLAYER_WIDTH = 480;
/** A pointer that moved further than this was a drag, not a click. */
const DRAG_SLOP = 2;
/** A GIF demo's length when its card names none: the longest a GIF demo plays. */
const GIF_LONGEST_MS = 10_000;
/** How often a playing GIF's time moves on. */
const GIF_TICK_MS = 250;

/** What a diagram is drawn on, as a picture is in the card: its colors were chosen for it. */
const DRAWING_GROUND: React.CSSProperties = {
  background: "var(--bg-1)",
  borderRadius: "var(--radius-s)",
};

const icon = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** A demo's time as the player shows it: `0:04`. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A picture offset that keeps its edges outside the viewport's, or centres an axis that fits. */
function clampOffset(offset: { x: number; y: number }, picture: Size, box: Size) {
  const axis = (value: number, size: number, room: number) =>
    size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, value));
  return {
    x: axis(offset.x, picture.width, box.width),
    y: axis(offset.y, picture.height, box.height),
  };
}

export function PictureViewer({
  title,
  pictures,
  index: first,
  demo,
  onClose,
}: PictureViewerProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(first, 0), pictures.length - 1));
  const [zoomed, setZoomed] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [row, setRow] = useState<Size | null>(null);
  // What each picture decoded to here: the truth, over the frame's report.
  const [decoded, setDecoded] = useState<Record<string, Size>>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const fadeOut = useRef<number | undefined>(undefined);
  const dragged = useRef(false);
  const captionId = useId();
  // A demo's player: what its recording is doing now, as the element says.
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(demo ? demo.durationMs / 1000 : 0);
  const [recorded, setRecorded] = useState<Size | null>(null);
  // A GIF demo's player: which press drew the animation (its URL, so each
  // play starts from its first frame), and the clocks that end and count it.
  const gif = demo?.kind === "gif";
  const [run, setRun] = useState(0);
  const gifPlaying = useRef(false);
  const gifEnd = useRef<number | undefined>(undefined);
  const gifTick = useRef<number | undefined>(undefined);
  const gifMs = demo && demo.durationMs > 0 ? demo.durationMs : GIF_LONGEST_MS;

  const picture = pictures[index] as ViewerPicture;
  const size: Size | null =
    (demo ? recorded : null) ??
    decoded[picture.src] ??
    (picture.width > 0 && picture.height > 0
      ? { width: picture.width, height: picture.height }
      : null);
  const box: Size | null = row
    ? { width: Math.max(0, row.width - 2 * SIDE_GUTTER), height: row.height }
    : null;
  // A diagram (INF-3107) is a drawing, sharp at any size: fitted, it fills
  // the room there is, larger than its own size where the window allows. A
  // picture is never drawn larger than its own pixels.
  const drawing = isDrawingSource(picture.src);
  const scale =
    size && box
      ? Math.min(
          drawing ? Number.POSITIVE_INFINITY : 1,
          box.width / size.width,
          box.height / size.height,
        )
      : 1;
  const fitsBox =
    size !== null && box !== null && size.width <= box.width && size.height <= box.height;
  const fitsAtOne = fitsBox && (!drawing || Math.abs(scale - 1) < 0.01);
  const zoomable = !demo && size !== null && box !== null && !fitsAtOne;
  const atOne = zoomed && zoomable;
  // Why Actual size does nothing, on rest, the pointer's or the keyboard's
  // focus, and in its description (docs/keyboard.md, "Facts shown on rest").
  // Esc stays the viewer's own, which closes it and the label with it.
  const ownSizeId = useId();
  const ownSize = useRestLabel(zoomable ? undefined : m.uiPictureViewerShownAtOwnSize());

  const clearGif = useCallback(() => {
    window.clearTimeout(gifEnd.current);
    window.clearInterval(gifTick.current);
  }, []);
  // Stop takes the animation away and leaves the poster; its end does the same, with Replay.
  const stopGif = useCallback(
    (atEnd: boolean) => {
      clearGif();
      gifPlaying.current = false;
      setPlaying(false);
      setEnded(atEnd);
      setTime(atEnd ? gifMs / 1000 : 0);
    },
    [clearGif, gifMs],
  );
  const startGif = useCallback(() => {
    clearGif();
    gifPlaying.current = true;
    setRun((previous) => previous + 1);
    setPlaying(true);
    setEnded(false);
    setTime(0);
  }, [clearGif]);
  // The animation is drawing from its first frame: it has ended once its length has played.
  const gifLoaded = useCallback(() => {
    const began = performance.now();
    gifTick.current = window.setInterval(
      () => setTime(Math.min(gifMs, performance.now() - began) / 1000),
      GIF_TICK_MS,
    );
    gifEnd.current = window.setTimeout(() => stopGif(true), gifMs);
  }, [gifMs, stopGif]);
  useEffect(() => clearGif, [clearGif]);

  // In on the frame after the first paint at opacity 0, so the fade runs;
  // under reduced motion the first paint is already the whole viewer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves in once, on opening
  useEffect(() => {
    // A demo's first stop is its play control, so Space plays or pauses it.
    (demo ? playRef.current : dialogRef.current)?.focus();
    // A GIF opened from its Play button plays at once, as a video's autoplay does.
    if (gif && demo?.play) startGif();
    if (reducedMotion()) {
      setShown(true);
      return;
    }
    void dialogRef.current?.getBoundingClientRect();
    setShown(true);
  }, []);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setRow((previous) =>
        previous && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The window hidden pauses it, and only a press plays it again.
  useEffect(() => {
    if (!demo) return;
    const onHidden = () => {
      if (!document.hidden) return;
      videoRef.current?.pause();
      if (gifPlaying.current) stopGif(false);
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [demo, stopGif]);

  const pressPlay = useCallback(() => {
    if (gif) {
      if (failed) return;
      if (gifPlaying.current) stopGif(false);
      else startGif();
      return;
    }
    const video = videoRef.current;
    if (!video || failed) return;
    if (ended) video.currentTime = 0;
    if (video.paused || ended) video.play().catch(() => {});
    else video.pause();
  }, [ended, failed, gif, startGif, stopGif]);

  const seek = useCallback((to: number) => {
    const video = videoRef.current;
    if (!video) return;
    const at = Math.min(Math.max(to, 0), Number.isFinite(video.duration) ? video.duration : to);
    video.currentTime = at;
    setTime(at);
  }, []);

  // Out over the same fade, timed from the transition itself: an animation
  // event is not a clock the viewer can count on in every window.
  const close = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    const dialog = dialogRef.current;
    const fade =
      dialog && !reducedMotion()
        ? parseFloat(getComputedStyle(dialog).transitionDuration) * 1000
        : 0;
    if (!(fade > 0)) {
      onClose();
      return;
    }
    setShown(false);
    fadeOut.current = window.setTimeout(onClose, fade);
  }, [leaving, onClose]);
  useEffect(() => () => window.clearTimeout(fadeOut.current), []);

  const go = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(next, 0), pictures.length - 1);
      if (target === index) return;
      setIndex(target);
      setZoomed(false);
    },
    [index, pictures.length],
  );

  const toggle = useCallback(() => {
    if (!zoomable || !size || !box) return;
    if (!zoomed) {
      const centred = { x: (box.width - size.width) / 2, y: (box.height - size.height) / 2 };
      setOffset(clampOffset(centred, size, box));
    }
    setZoomed(!zoomed);
  }, [zoomable, zoomed, size, box]);

  // The keys, while it is open. Captured at the window so they reach the
  // viewer wherever focus stands and never the stack's paging or the
  // shell's own Escape underneath.
  useEffect(() => {
    if (leaving) return;
    const onKey = (event: KeyboardEvent) => {
      const onControl =
        event.target instanceof HTMLElement &&
        event.target.closest("button") !== null &&
        dialogRef.current?.contains(event.target);
      // A demo's keys are its controls' own; only Esc and the Tab ring are the viewer's.
      if (demo && event.key !== "Escape" && event.key !== "Tab") return;
      let handled = true;
      switch (event.key) {
        case "Escape":
          close();
          break;
        case "ArrowLeft":
          go(index - 1);
          break;
        case "ArrowRight":
          go(index + 1);
          break;
        case "Home":
          go(0);
          break;
        case "End":
          go(pictures.length - 1);
          break;
        case "z":
        case "Z":
          toggle();
          break;
        case "Enter":
        case " ":
          // A focused control is pressed by the key itself.
          if (onControl) return;
          toggle();
          break;
        case "Tab": {
          const dialog = dialogRef.current;
          if (!dialog) return;
          const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
          const firstStop = stops[0];
          const lastStop = stops.at(-1);
          if (!firstStop || !lastStop) break;
          const active = document.activeElement;
          const inside = active instanceof Node && dialog.contains(active);
          if (event.shiftKey && (!inside || active === firstStop || active === dialog)) {
            lastStop.focus();
          } else if (!event.shiftKey && (!inside || active === lastStop)) {
            firstStop.focus();
          } else {
            return;
          }
          break;
        }
        default:
          handled = false;
      }
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leaving, close, go, toggle, index, pictures.length, demo]);

  // Keep the current thumbnail in view when a group outgrows the row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the current thumbnail moves with index
  useEffect(() => {
    const strip = thumbsRef.current;
    const current = strip?.querySelector<HTMLElement>("[aria-current='true']");
    if (!strip || !current) return;
    const left = current.offsetLeft - strip.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [index]);

  const pan = (dx: number, dy: number) => {
    if (!size || !box) return;
    setOffset((previous) => clampOffset({ x: previous.x + dx, y: previous.y + dy }, size, box));
  };

  const fitted = size ? { width: size.width * scale, height: size.height * scale } : null;
  const dims = size ? pictureSize(size) : "";
  const hint = !size ? "" : pictureHint(size, atOne ? "one" : fitsAtOne ? "own" : "fitted");
  const count = demo
    ? clock(length)
    : pictures.length > 1
      ? `${index + 1} / ${pictures.length}`
      : dims;

  const pictureBox: React.CSSProperties =
    atOne && box
      ? { left: SIDE_GUTTER, top: 0, width: box.width, height: box.height }
      : fitted && box
        ? {
            left: SIDE_GUTTER + (box.width - fitted.width) / 2,
            top: (box.height - fitted.height) / 2,
            width: fitted.width,
            height: fitted.height,
          }
        : { left: SIDE_GUTTER, top: 0, right: SIDE_GUTTER, bottom: 0 };

  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={
        demo ? m.uiPictureViewerDemoFrom({ title }) : m.uiPictureViewerPicturesFrom({ title })
      }
      tabIndex={-1}
      data-picture-viewer=""
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-ui)",
        background: "color-mix(in srgb, var(--bg-0) 80%, transparent)",
        backdropFilter: "var(--blur-overlay)",
        WebkitBackdropFilter: "var(--blur-overlay)",
        opacity: shown ? 1 : 0,
        transition: reducedMotion() ? "none" : "opacity var(--dur-med) var(--ease-drift)",
        outline: "none",
        pointerEvents: leaving ? "none" : "auto",
      }}
    >
      <div
        style={
          {
            height: HEADER_HEIGHT,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            // Clear of the window controls, as the top bar is: the Mac's at
            // the left, or the app's own at the right.
            padding:
              thisDesktop().windowControls === "app"
                ? `0 ${WINDOW_CONTROLS_CLEARANCE}px 0 var(--space-4)`
                : "0 var(--space-4) 0 calc(var(--space-8) + var(--space-4))",
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--fg-1)",
            fontSize: "var(--text-base)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        <span
          data-picture-count=""
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            whiteSpace: "nowrap",
          }}
        >
          {count}
        </span>
        <IconButton
          label={m.uiPictureViewerClose()}
          {...fixedKeys("Escape")}
          onClick={close}
          style={noDrag}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" {...icon} aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </IconButton>
      </div>

      {/* The backdrop's click is the pointer's twin of Esc, which the window
          listener above already gives the keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop, see above */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc is its key */}
      <div
        ref={rowRef}
        data-picture-row=""
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        style={{ position: "relative", flex: 1, minHeight: 0 }}
      >
        {box && demo && gif && (
          // A GIF rests on its poster, fitted as the picture would be; Play
          // lays the animation over it, from its first frame, and Stop or its
          // end takes the animation away again. It does not zoom.
          <div
            data-demo-gif=""
            role="img"
            aria-label={picture.alt}
            aria-describedby={captionId}
            style={{
              position: "absolute",
              ...pictureBox,
              overflow: "hidden",
              background: "var(--bg-1)",
              borderRadius: "var(--radius-s)",
              boxShadow: "var(--shadow-2)",
            }}
          >
            <img
              data-demo-poster=""
              src={picture.src}
              alt=""
              draggable={false}
              style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }}
            />
            {playing && (
              <img
                key={run}
                data-demo-animation=""
                src={`${demo.src}?play=${run}`}
                alt=""
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setRecorded({ width: image.naturalWidth, height: image.naturalHeight });
                  }
                  gifLoaded();
                }}
                onError={() => {
                  setFailed(true);
                  stopGif(false);
                }}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                }}
              />
            )}
          </div>
        )}
        {box && demo && !gif && (
          // The recording takes the picture's place, fitted the same way and
          // resting on the poster until it plays; it does not zoom.
          <video
            ref={videoRef}
            data-demo-video=""
            src={demo.src}
            poster={picture.src}
            // Opened from its Play button it plays one pass at once; from its
            // poster it rests on the poster. Nothing else ever starts it.
            autoPlay={demo.play}
            preload="metadata"
            muted
            playsInline
            aria-describedby={captionId}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (Number.isFinite(video.duration)) setLength(video.duration);
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setRecorded({ width: video.videoWidth, height: video.videoHeight });
              }
            }}
            onPlay={() => {
              setPlaying(true);
              setEnded(false);
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setEnded(true);
            }}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onError={() => setFailed(true)}
            style={{
              position: "absolute",
              ...pictureBox,
              display: "block",
              objectFit: "contain",
              background: "var(--bg-1)",
              borderRadius: "var(--radius-s)",
              boxShadow: "var(--shadow-2)",
            }}
          />
        )}
        {box && !demo && (
          <button
            type="button"
            data-picture=""
            aria-label={m.uiPictureViewerActualSize()}
            aria-pressed={atOne}
            aria-disabled={!zoomable}
            aria-describedby={zoomable ? captionId : `${ownSizeId} ${captionId}`}
            {...ownSize}
            onClick={() => {
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              toggle();
            }}
            onPointerDown={(event) => {
              if (!atOne) return;
              drag.current = { x: event.clientX, y: event.clientY, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const from = drag.current;
              if (!from) return;
              const dx = event.clientX - from.x;
              const dy = event.clientY - from.y;
              if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) from.moved = true;
              from.x = event.clientX;
              from.y = event.clientY;
              pan(dx, dy);
            }}
            onPointerUp={() => {
              dragged.current = drag.current?.moved ?? false;
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onWheel={(event) => {
              if (atOne) pan(-event.deltaX, -event.deltaY);
            }}
            style={{
              position: "absolute",
              ...pictureBox,
              padding: 0,
              border: "none",
              background: "transparent",
              overflow: "hidden",
              borderRadius: "var(--radius-s)",
              boxShadow: atOne ? "none" : "var(--shadow-2)",
              cursor: atOne
                ? fitsBox
                  ? "zoom-in"
                  : "grab"
                : zoomable
                  ? scale > 1
                    ? "zoom-out"
                    : "zoom-in"
                  : "default",
              touchAction: "none",
              display: fitted || atOne ? "block" : "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img
              key={picture.src}
              data-picture-image=""
              src={picture.src}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget;
                const src = picture.src;
                if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                  setDecoded((previous) =>
                    previous[src]
                      ? previous
                      : {
                          ...previous,
                          [src]: { width: image.naturalWidth, height: image.naturalHeight },
                        },
                  );
                }
              }}
              style={
                atOne && size
                  ? {
                      // Out of flow: a button centres its content, which
                      // would add to the offset.
                      position: "absolute",
                      left: 0,
                      top: 0,
                      display: "block",
                      width: size.width,
                      height: size.height,
                      maxWidth: "none",
                      transform: `translate(${offset.x}px, ${offset.y}px)`,
                      ...(drawing ? DRAWING_GROUND : {}),
                    }
                  : fitted
                    ? {
                        display: "block",
                        width: "100%",
                        height: "100%",
                        ...(drawing ? DRAWING_GROUND : {}),
                      }
                    : { display: "block", maxWidth: "100%", maxHeight: "100%" }
              }
            />
          </button>
        )}
        {pictures.length > 1 && (
          <>
            <IconButton
              label={m.uiPictureViewerPrevious()}
              {...fixedKeys("ArrowLeft")}
              size={NAV_SIZE}
              disabled={index === 0}
              onClick={() => go(index - 1)}
              style={navStyle("left")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" {...icon} aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </IconButton>
            <IconButton
              label={m.uiPictureViewerNext()}
              {...fixedKeys("ArrowRight")}
              size={NAV_SIZE}
              disabled={index === pictures.length - 1}
              onClick={() => go(index + 1)}
              style={navStyle("right")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" {...icon} aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </IconButton>
          </>
        )}
      </div>

      <div
        style={{
          flex: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-3) var(--space-6) var(--space-4)",
          minWidth: 0,
        }}
      >
        <p
          id={captionId}
          data-picture-caption=""
          style={{
            margin: 0,
            maxWidth: "70ch",
            textAlign: "center",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-body)",
            color: "var(--fg-2)",
          }}
        >
          {demo?.caption || picture.alt}
        </p>
        <span id={ownSizeId} hidden>
          {m.uiPictureViewerShownAtOwnSize()}
        </span>
        {demo ? (
          <div
            data-demo-player=""
            style={{
              display: "flex",
              alignItems: "center",
              // A GIF has no slider to fill the row: its button and time sit centred.
              justifyContent: gif ? "center" : undefined,
              gap: "var(--space-3)",
              width: "100%",
              maxWidth: PLAYER_WIDTH,
            }}
          >
            <IconButton
              ref={playRef}
              label={
                ended
                  ? m.uiPictureViewerReplay()
                  : playing
                    ? gif
                      ? m.uiPictureViewerStop()
                      : m.uiPictureViewerPause()
                    : m.uiPictureViewerPlay()
              }
              disabled={failed}
              onClick={pressPlay}
              style={{ flex: "none", color: "var(--fg-1)" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" {...icon} aria-hidden="true">
                {ended ? (
                  <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />
                ) : playing && gif ? (
                  <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
                ) : playing ? (
                  <path d="M8 5v14M16 5v14" />
                ) : (
                  <path d="M7 5l12 7-12 7z" fill="currentColor" />
                )}
              </svg>
            </IconButton>
            {gif ? null : (
              <input
                type="range"
                data-demo-seek=""
                aria-label={m.uiPictureViewerSeek()}
                aria-valuetext={m.uiPictureViewerSeekValue({
                  time: clock(time),
                  length: clock(length),
                })}
                min={0}
                max={length || 0}
                step="any"
                value={Math.min(time, length || 0)}
                disabled={failed}
                onChange={(event) => seek(Number(event.currentTarget.value))}
                onKeyDown={(event) => {
                  // A second a press: a demo is short, and the slider's own step is a hair.
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    seek(time + (event.key === "ArrowRight" ? 1 : -1));
                  }
                }}
                style={{ flex: 1, minWidth: 0, accentColor: "var(--accent)" }}
              />
            )}
            <span
              data-demo-time=""
              style={{
                flex: "none",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                whiteSpace: "nowrap",
              }}
            >
              {failed ? m.uiPictureViewerUnplayable() : `${clock(time)} / ${clock(length)}`}
            </span>
          </div>
        ) : null}
        <span
          hidden={demo !== undefined}
          data-picture-hint=""
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            minHeight: "1lh",
          }}
        >
          {hint}
        </span>
        {pictures.length > 1 && (
          <div
            ref={thumbsRef}
            data-picture-thumbs=""
            style={{
              display: "flex",
              gap: "var(--space-2)",
              maxWidth: "100%",
              overflowX: "auto",
              scrollbarWidth: "none",
              // Room for the focus ring, which the scroller would clip.
              padding: "var(--space-1)",
            }}
          >
            {pictures.map((thumb, at) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: a group may name one picture twice
                key={at}
                type="button"
                aria-label={m.uiPictureViewerThumb({
                  number: formatNumber(at + 1),
                  alt: thumb.alt,
                })}
                aria-current={at === index}
                onClick={() => go(at)}
                style={{
                  flex: "none",
                  width: THUMB.width,
                  height: THUMB.height,
                  padding: 0,
                  overflow: "hidden",
                  cursor: "pointer",
                  background: "var(--bg-1)",
                  border: `1px solid ${at === index ? "var(--accent)" : "var(--line-1)"}`,
                  borderRadius: "var(--radius-s)",
                  opacity: at === index ? 1 : 0.7,
                }}
              >
                <img
                  src={thumb.src}
                  alt=""
                  draggable={false}
                  style={{
                    display: "block",
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "top",
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function navStyle(side: "left" | "right"): React.CSSProperties {
  return {
    position: "absolute",
    top: "50%",
    [side]: "var(--space-3)",
    transform: "translateY(-50%)",
    border: "1px solid var(--line-2)",
    color: "var(--fg-1)",
  };
}
