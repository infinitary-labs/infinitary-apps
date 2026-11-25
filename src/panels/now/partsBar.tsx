import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { PartSegment, PartState } from "./rows";

/** Past this many parts a collapsed row's bar draws its segments with a hairline gap, so they fit. */
const MANY_PARTS = 30;

/** A collapsed row's bar as one string, so its memoized row paints again only when it changes. */
export function barWords(bar: readonly PartSegment[]): string {
  return bar.map(({ state, id }) => `${state}:${id ?? ""}`).join(" ");
}

/** The segments `barWords` wrote. */
export function barSegments(words: string): PartSegment[] {
  return words.split(" ").map((word) => {
    const at = word.indexOf(":");
    const id = word.slice(at + 1);
    return { state: word.slice(0, at) as PartState, id: id || null };
  });
}

/**
 * The rest and press on a bar's segments (INF-4147, INF-4172), for a
 * collapsed task's row and a folded tag group's header alike: a segment that
 * names a task rests on it (`onPart`), the rest of the element on what it
 * stands for (`onSelf`); a press lets the rest go until the pointer leaves.
 */
export function useBarRest(
  segments: readonly PartSegment[],
  on: {
    onPart: (element: HTMLElement, partId: string) => void;
    onSelf: (element: HTMLElement) => void;
    onLeave: (element: HTMLElement) => void;
    onPress: () => void;
  },
) {
  // The part the pointer rests on through the bar: undefined while the
  // pointer is off the element, null on the rest of it or a segment that
  // names no part.
  const hovered = useRef<string | null | undefined>(undefined);
  const [restedPart, setRestedPart] = useState<number | null>(null);
  const pressed = useRef(false);
  const partAt = (target: EventTarget): { index: number; id: string } | null => {
    const at = (target as HTMLElement).closest<HTMLElement>("[data-now-part]");
    if (!at) return null;
    const index = Number(at.dataset.nowPartIndex);
    const id = segments[index]?.id ?? null;
    return id === null ? null : { index, id };
  };
  return {
    restedPart,
    partAt,
    handlers: {
      onPointerOver: (event: ReactPointerEvent<HTMLElement>) => {
        if (pressed.current) return;
        const part = partAt(event.target);
        const partId = part?.id ?? null;
        if (hovered.current === partId) return;
        hovered.current = partId;
        setRestedPart(part?.index ?? null);
        if (part) on.onPart(event.currentTarget, part.id);
        else on.onSelf(event.currentTarget);
      },
      onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
        hovered.current = undefined;
        pressed.current = false;
        setRestedPart(null);
        on.onLeave(event.currentTarget);
      },
      onPointerDown: () => {
        pressed.current = true;
        setRestedPart(null);
        on.onPress();
      },
    },
  };
}

/**
 * The bar itself: one segment per part or task, in order, each its own rest
 * target, the rested one taller (`data-now-bar` in ./panel.css).
 */
export function PartsBar({
  segments,
  restedPart,
}: {
  segments: readonly PartSegment[];
  restedPart: number | null;
}) {
  return (
    <span
      data-now-bar=""
      aria-hidden="true"
      data-now-many={segments.length > MANY_PARTS ? "" : undefined}
    >
      {segments.map(({ state, id }, index) => (
        <i
          // The bar is the parts in order; a part it cannot name has no identity here.
          // biome-ignore lint/suspicious/noArrayIndexKey: one segment per part, in order
          key={index}
          data-now-part={state}
          data-now-part-index={index}
          data-now-part-id={id ?? undefined}
          data-now-part-rested={restedPart === index ? "" : undefined}
        />
      ))}
    </span>
  );
}
