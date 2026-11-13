import type React from "react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { thisDesktop, WINDOW_CONTROLS_CLEARANCE } from "../core/desktop";
import { fixedKeys } from "../core/fixedKeys";
import { IconButton } from "../core/IconButton";

/**
 * The overlay the picture viewer and the log reader share (INF-3887): the
 * dialog over the whole window, its header with the close button, the fade in
 * and out, and the Tab ring. Each viewer keeps only what it shows and its own
 * keys. Every rule here is the design skill's
 * `components/cards/PictureViewer.prompt.md`.
 */

/** The header: the top bar's height, which the viewer covers. */
const HEADER_HEIGHT = 52;

export const VIEWER_ICON = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Keeps Tab and Shift-Tab inside the dialog. True when it moved focus, so
 * the caller stops the key; false when the browser's own move stays inside.
 */
export function tabRing(event: KeyboardEvent, dialog: HTMLElement | null): boolean {
  if (!dialog) return false;
  const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const firstStop = stops[0];
  const lastStop = stops.at(-1);
  if (!firstStop || !lastStop) return false;
  const active = document.activeElement;
  const inside = active instanceof Node && dialog.contains(active);
  if (event.shiftKey && (!inside || active === firstStop || active === dialog)) {
    lastStop.focus();
  } else if (!event.shiftKey && (!inside || active === lastStop)) {
    firstStop.focus();
  } else {
    return false;
  }
  return true;
}

/**
 * The viewer's fade. `open` shows it on the frame after its first paint at
 * opacity 0, so the fade runs; under reduced motion the first paint is
 * already the whole viewer. `close` fades it out, timed from the transition
 * itself, then calls `onClose` once.
 */
export function useViewerFade(dialogRef: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const fadeOut = useRef<number | undefined>(undefined);
  const open = useCallback(() => {
    if (!reducedMotion()) void dialogRef.current?.getBoundingClientRect();
    setShown(true);
  }, [dialogRef]);
  // An animation event is not a clock the viewer can count on in every window.
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
  }, [leaving, onClose, dialogRef]);
  useEffect(() => () => window.clearTimeout(fadeOut.current), []);
  return { shown, leaving, open, close };
}

export type ViewerShellProps = {
  dialogRef: RefObject<HTMLDivElement | null>;
  label: string;
  /** The data attribute that names this viewer, such as `data-log-reader`. */
  marker: string;
  shown: boolean;
  leaving: boolean;
  /** The header's leading words and its trailing count or size. */
  heading: React.ReactNode;
  meta: React.ReactNode;
  closeLabel: string;
  /** Fades the viewer out (`useViewerFade`). */
  close: () => void;
  children: React.ReactNode;
};

export const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** The header's leading words, cut with an ellipsis when long. */
export const HEADING_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: "var(--fg-1)",
  fontSize: "var(--text-base)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** The header's trailing count or size, in the mono face. */
export const META_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
};

export function ViewerShell({
  dialogRef,
  label,
  marker,
  shown,
  leaving,
  heading,
  meta,
  closeLabel,
  close,
  children,
}: ViewerShellProps) {
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      {...{ [marker]: "" }}
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
        {heading}
        {meta}
        <IconButton label={closeLabel} {...fixedKeys("Escape")} onClick={close} style={NO_DRAG}>
          <svg width="16" height="16" viewBox="0 0 24 24" {...VIEWER_ICON} aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </IconButton>
      </div>
      {children}
    </div>,
    document.body,
  );
}
