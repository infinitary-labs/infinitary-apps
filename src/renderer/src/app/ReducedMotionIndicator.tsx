import { COMPUTER } from "@shared/deviceNames";
import type React from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { onReducedMotionChange, prefersReducedMotion } from "../character/reducedMotion";
import { Badge, MicroLabel } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { usePopoverPresence } from "../design/motion";

/** The panel's words, one owner: what the OS setting changes in this app. */
export const REDUCED_MOTION_COPY = {
  label: "Reduced motion",
  headline: `Your ${COMPUTER.one} is set to reduce motion, so your first mate holds still.`,
  points: [
    {
      subject: "Your first mate",
      text: "is one still picture. It does not show when it is listening or working, react, blink or follow your pointer.",
    },
    {
      subject: "Crewmates",
      text: "sit still on their ring. Their color still changes, but you will not see them arrive, report in, finish or flicker.",
    },
    { subject: "The voice waveform", text: "holds still while you talk." },
    {
      subject: "Cards, panels and Settings",
      text: "appear at once instead of sliding or fading. A few short fades remain.",
    },
  ],
  change: "To change it, open System Settings › Accessibility › Display › Reduce motion.",
  /** Where to change it on a desktop other than a Mac's, whose settings differ by desktop. */
  changeOnLinux: "To change it, turn animations back on in your desktop's accessibility settings.",
} as const;

function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion);
}

/**
 * Says the Mac's Reduce motion setting is on, beside the settings button, so
 * a still Firstmate reads as a setting and not a fault. Hover or focus opens
 * the panel; a click keeps it open until a click elsewhere or Esc. Shows
 * nothing when the setting is off.
 */
export function ReducedMotionIndicator() {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // The button unsets every style of its own, so it draws its focus ring itself.
  const [ring, setRing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  // Grows from the badge like every popover; the setting that shows it makes that a cut.
  const drawn = usePopoverPresence(open, panelRef, buttonRef);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setPinned(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!reduced) return null;

  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
  const leave = () => {
    if (!pinned) setOpen(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors the button's own focus, which is the keyboard path
    <div
      ref={rootRef}
      data-reduced-motion-indicator
      style={{ position: "relative", ...noDrag }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={leave}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-describedby={open ? panelId : undefined}
        aria-expanded={open}
        onFocus={(event) => {
          setRing(event.currentTarget.matches(":focus-visible"));
          setOpen(true);
        }}
        onBlur={() => {
          setRing(false);
          leave();
        }}
        onClick={() => {
          setPinned(true);
          setOpen(true);
        }}
        style={{
          all: "unset",
          cursor: "default",
          borderRadius: "var(--radius-s)",
          boxShadow: ring ? "var(--focus-ring)" : undefined,
          ...noDrag,
        }}
      >
        <Badge tone="warn" dot>
          {REDUCED_MOTION_COPY.label}
        </Badge>
      </button>
      {drawn && <ReducedMotionPanel ref={panelRef} id={panelId} />}
    </div>
  );
}

/** The open panel, in the update panel's style, right-aligned under the badge. */
export function ReducedMotionPanel({ id, ref }: { id?: string; ref?: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-reduced-motion-panel
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        right: 0,
        width: 340,
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 20,
      }}
    >
      <MicroLabel>{REDUCED_MOTION_COPY.label}</MicroLabel>
      <div style={{ fontSize: "var(--text-base)", color: "var(--fg-1)", fontWeight: 500 }}>
        {REDUCED_MOTION_COPY.headline}
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 16,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
        }}
      >
        {REDUCED_MOTION_COPY.points.map((point) => (
          <li key={point.subject}>
            <span style={{ color: "var(--fg-1)", fontWeight: 500 }}>{point.subject}</span>{" "}
            {point.text}
          </li>
        ))}
      </ul>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {thisDesktop().mac ? REDUCED_MOTION_COPY.change : REDUCED_MOTION_COPY.changeOnLinux}
      </div>
    </div>
  );
}
