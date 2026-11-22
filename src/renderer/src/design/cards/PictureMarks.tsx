import {
  boxPlace,
  type DrawnMark,
  linePlace,
  type MarkLook,
  marksSource,
  markUnit,
  type PictureSize,
} from "@shared/cardNoteMarks";
import { type NotePlace, type PlacePoint, placeBounds } from "@shared/cardNotes";
import type React from "react";
import { useRef, useState, useSyncExternalStore } from "react";

/**
 * The marks on a picture, and the surface that makes one (the design skill's
 * `components/cards/PictureViewer.prompt.md`, "Pointing at a place"). The
 * picture viewer lays it over its picture and the Browser tab over the held
 * picture of a page: both draw the same numbered marks, in the picture's own
 * pixels, from the one drawing the author is sent (`marksSvg`).
 *
 * With Point at on the pointer marks and reaches nothing under it: a drag is
 * a box, a press with no drag a spot, and with the line tool a freehand line
 * whose width follows a pen's pressure.
 */

export type MarkTool = "box" | "line";

/** Where something is drawn in the window, as the note popover is placed by. */
export type ClientBox = { top: number; bottom: number; left: number; right: number };

/** A pointer that moved further than this drew a box, not a spot. */
const DRAG_SLOP = 3;

/**
 * The tokens a mark is drawn in, as the window reads them now: the accent over the page's own
 * ground. They are read where the theme is set, on the body (src/renderer/src/app/preferences.ts).
 */
export function markLook(): MarkLook {
  const tokens = getComputedStyle(document.body);
  return {
    // i18n-exempt: a system color's name
    ink: tokens.getPropertyValue("--accent").trim() || "Highlight",
    // i18n-exempt: a system color's name
    ground: tokens.getPropertyValue("--bg-0").trim() || "Canvas",
  };
}

function onTheme(changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const shownTheme = () => document.body.dataset.theme ?? "";

/** The marks' look in a view: a mark's colors are part of its drawing, so a change of theme draws it again. */
export function useMarkLook(): MarkLook {
  useSyncExternalStore(onTheme, shownTheme);
  return markLook();
}

export function placeClientBox(place: NotePlace, drawn: DOMRect): ClientBox {
  const bounds = placeBounds(place);
  const x = drawn.width / place.width;
  const y = drawn.height / place.height;
  return {
    left: drawn.left + bounds.x * x,
    right: drawn.left + (bounds.x + bounds.width) * x,
    top: drawn.top + bounds.y * y,
    bottom: drawn.top + (bounds.y + bounds.height) * y,
  };
}

export type PictureMarksProps = {
  /** The picture's own size: what every place is measured in. */
  size: PictureSize;
  /** The marks to draw, numbered; the one being written is lit. */
  marks: readonly DrawnMark[];
  /** Point at is on: the pointer marks. Off, the marks are only drawn and the pointer passes through. */
  on: boolean;
  tool: MarkTool;
  /** The number the mark being drawn takes. */
  next: number;
  onMark: (place: NotePlace, at: ClientBox) => void;
  /** The wheel over the surface, which the viewer pans a picture at 1:1 with. */
  onWheel?: ((event: React.WheelEvent) => void) | undefined;
  /** Where the picture's frame is, in what holds it. */
  style: React.CSSProperties;
  /** Where the picture itself is drawn inside that frame: over all of it, or moved at 1:1. */
  layerStyle: React.CSSProperties;
  /** The drawn picture's own element, for where a place made by keys sits in the window. */
  layerRef?: React.Ref<HTMLDivElement> | undefined;
};

export function PictureMarks({
  size,
  marks,
  on,
  tool,
  next,
  onMark,
  onWheel,
  style,
  layerStyle,
  layerRef,
}: PictureMarksProps) {
  const layer = useRef<HTMLDivElement | null>(null);
  const stroke = useRef<{
    from: { x: number; y: number };
    client: { x: number; y: number };
    moved: boolean;
    points: PlacePoint[];
  } | null>(null);
  const [draft, setDraft] = useState<NotePlace | null>(null);
  const look = useMarkLook();

  const at = (event: React.PointerEvent) => {
    const drawn = (layer.current as HTMLDivElement).getBoundingClientRect();
    return {
      x: ((event.clientX - drawn.left) / Math.max(1, drawn.width)) * size.width,
      y: ((event.clientY - drawn.top) / Math.max(1, drawn.height)) * size.height,
    };
  };
  // A pen says how hard it presses: the line is that much wider there. A mouse says nothing.
  const pointOf = (event: React.PointerEvent): PlacePoint => ({
    ...at(event),
    ...(event.pointerType === "pen" && event.pressure > 0
      ? { w: Math.max(1, Math.round(markUnit(size) * (1 + 5 * event.pressure))) }
      : {}),
  });
  const placeOf = (
    current: NonNullable<typeof stroke.current>,
    to: { x: number; y: number },
  ): NotePlace | undefined =>
    tool === "line"
      ? linePlace(size, current.points)
      : boxPlace(size, current.from, current.moved ? to : current.from);

  const shown = draft ? [...marks, { number: next, place: draft, lit: true }] : marks;
  return (
    <div
      data-picture-marks={shown.map((mark) => mark.number).join(" ")}
      data-picture-marking={on ? tool : undefined}
      onPointerDown={(event) => {
        if (!on || event.button !== 0 || !layer.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = pointOf(event);
        stroke.current = {
          from: point,
          client: { x: event.clientX, y: event.clientY },
          moved: false,
          points: [point],
        };
        setDraft(placeOf(stroke.current, point) ?? null);
      }}
      onPointerMove={(event) => {
        const current = stroke.current;
        if (!current) return;
        if (
          Math.abs(event.clientX - current.client.x) + Math.abs(event.clientY - current.client.y) >
          DRAG_SLOP
        )
          current.moved = true;
        const point = pointOf(event);
        current.points.push(point);
        setDraft(placeOf(current, point) ?? null);
      }}
      onPointerUp={(event) => {
        const current = stroke.current;
        stroke.current = null;
        setDraft(null);
        if (!current || !layer.current) return;
        const place = placeOf(current, at(event));
        if (place) onMark(place, placeClientBox(place, layer.current.getBoundingClientRect()));
      }}
      onPointerCancel={() => {
        stroke.current = null;
        setDraft(null);
      }}
      onWheel={onWheel}
      style={{
        position: "absolute",
        ...style,
        overflow: "hidden",
        pointerEvents: on ? "auto" : "none",
        cursor: on ? "crosshair" : undefined,
        touchAction: "none",
      }}
    >
      <div
        ref={(element) => {
          layer.current = element;
          if (typeof layerRef === "function") layerRef(element);
          else if (layerRef) layerRef.current = element;
        }}
        style={{ position: "absolute", ...layerStyle }}
      >
        {shown.length > 0 && (
          <img
            data-picture-marks-drawn=""
            src={marksSource(size, shown, look)}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              display: "block",
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
