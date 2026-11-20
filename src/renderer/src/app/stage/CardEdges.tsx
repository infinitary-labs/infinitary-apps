import * as m from "@shared/i18n/messages.generated";
import { useRef, useState } from "react";
import { CARD_DRAG_MIN } from "../../cards/cardGeometry";
import { useRestLabel } from "../../design";
import { useCommandKeys } from "../keyHints";

/**
 * The folded docks' edge tabs (the captain's tweak 2): a 4px accent strip
 * at each side whose panels gave up their width, saying they are one click
 * away. The click collapses the thread, which is what returns them - the
 * thread's messages stay on the record and the reply row returns to the
 * foot of the card under its latest line.
 */
export function FoldedRailTabs({
  left,
  right,
  onShow,
}: {
  left: boolean;
  right: boolean;
  onShow: () => void;
}) {
  return (
    <>
      {left && <RailTab side="left" onShow={onShow} />}
      {right && <RailTab side="right" onShow={onShow} />}
    </>
  );
}

/**
 * One edge tab. It does what Show or hide the card's thread does, so its
 * label on rest names that command's key (docs/keyboard.md, "Key hints").
 */
function RailTab({ side, onShow }: { side: "left" | "right"; onShow: () => void }) {
  const {
    keys,
    "aria-keyshortcuts": ariaKeys,
    "data-key-command": keyCommand,
  } = useCommandKeys("cards.thread");
  const showPanels = m.shellCardShowPanels();
  const rest = useRestLabel(showPanels, { keys });
  return (
    <button
      {...rest}
      type="button"
      data-rail-tab={side}
      aria-label={showPanels}
      aria-keyshortcuts={ariaKeys}
      data-key-command={keyCommand}
      onClick={onShow}
      style={{
        position: "fixed",
        [side]: 0,
        top: "var(--space-8)",
        bottom: "var(--space-4)",
        width: 4,
        padding: 0,
        border: "none",
        cursor: "pointer",
        background: "var(--accent)",
        opacity: 0.5,
        borderRadius: side === "left" ? "0 2px 2px 0" : "2px 0 0 2px",
        pointerEvents: "auto",
      }}
    />
  );
}

/**
 * One end of a maximized card's Tab round: focus that reaches it goes on to
 * the card's other end, so Tab and ⇧Tab stay with the card and its pager
 * while the rest of the window is aside (design skill ResponseCard,
 * "Maximize"). Nothing is drawn, and a pointer never lands on it.
 */
export function FocusEdge({ onFocus }: { onFocus: () => void }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a focus guard, which passes focus on at once
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focus guard, which passes focus on at once
      tabIndex={0}
      data-focus-edge=""
      onFocus={onFocus}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
      }}
    />
  );
}

/** How far one arrow key moves a card's edge. */
export const EDGE_KEY_STEP = 16;

/**
 * The captain's drag on a lone card's edges (his Q5 A: facts, then the
 * author's hint, then his own hand). The card is centred, so one edge moved
 * by a pixel moves the other the same way and the card grows by two. It
 * holds while the card is up and through its revisions; a double click, or
 * Enter on an edge the keyboard reached, gives the card back the width the
 * host decided. Never a setting.
 */
export function CardEdges({
  width,
  max,
  onDragging,
  onInteract,
  onDrag,
  onReset,
}: {
  /** The card's shown width, in px. */
  width: number;
  max: number;
  onDragging: (dragging: boolean) => void;
  onInteract: () => void;
  onDrag: (width: number) => void;
  onReset: () => void;
}) {
  const held = useRef<{ pointer: number; x: number; width: number; grow: 1 | -1 } | null>(null);
  const [lit, setLit] = useState<"left" | "right" | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(CARD_DRAG_MIN, next)));
  const edge = (side: "left" | "right") => {
    // Moving the right edge right widens the card; the left edge, left.
    const grow = side === "right" ? 1 : -1;
    const active = lit === side;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA separator with a value), which an <hr> cannot be
      <div
        key={side}
        role="separator"
        aria-orientation="vertical"
        aria-label={m.shellCardResize()}
        aria-valuemin={CARD_DRAG_MIN}
        aria-valuemax={max}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        data-card-edge={side}
        onPointerEnter={() => setLit(side)}
        onPointerLeave={() => {
          if (!held.current) setLit(null);
        }}
        onFocus={() => {
          onInteract();
          setLit(side);
        }}
        onBlur={() => setLit(null)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          held.current = { pointer: event.pointerId, x: event.clientX, width, grow };
          onDragging(true);
        }}
        onPointerMove={(event) => {
          const start = held.current;
          if (!start || start.pointer !== event.pointerId) return;
          onDrag(clamp(start.width + 2 * start.grow * (event.clientX - start.x)));
        }}
        onPointerUp={(event) => {
          if (held.current?.pointer !== event.pointerId) return;
          held.current = null;
          onDragging(false);
          setLit(null);
        }}
        onPointerCancel={() => {
          held.current = null;
          onDragging(false);
          setLit(null);
        }}
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowRight"
              ? grow * EDGE_KEY_STEP
              : event.key === "ArrowLeft"
                ? -grow * EDGE_KEY_STEP
                : 0;
          if (step !== 0) onDrag(clamp(width + 2 * step));
          else if (event.key === "Home") onDrag(CARD_DRAG_MIN);
          else if (event.key === "End") onDrag(clamp(max));
          else if (event.key === "Enter" && !event.repeat) onReset();
          else return;
          event.preventDefault();
        }}
        style={{
          position: "absolute",
          top: "var(--space-4)",
          bottom: "var(--space-4)",
          [side]: -6,
          width: 12,
          cursor: "ew-resize",
          outline: "none",
          touchAction: "none",
          zIndex: 1,
        }}
      >
        {/* The grip shows only while the edge is under the pointer, held or focused. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 4,
            top: "50%",
            width: 4,
            height: 32,
            marginTop: -16,
            borderRadius: "var(--radius-pill)",
            background: "var(--accent)",
            opacity: active ? 1 : 0,
            transition: "opacity var(--dur-fast) var(--ease-out)",
          }}
        />
      </div>
    );
  };
  return (
    <>
      {edge("left")}
      {edge("right")}
    </>
  );
}
