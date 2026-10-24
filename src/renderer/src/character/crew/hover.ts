import { CREW_HOVER } from "./hoverMeasures";
import type { CrewmateFrame, OrbitFrame } from "./orbit";

export { CREW_HOVER } from "./hoverMeasures";

// Pointing at the crew (FI3-398): where the stage's slow zone ends, which
// crewmate the pointer is on, and where that crewmate's summary sits. The crew
// are painted on canvases that ignore the pointer, so this is a hit test
// against the frames the orbit already hands the painter. Pure geometry in
// screen pixels measured from the formation's centre; no clock, no DOM.

type Target = Pick<CrewmateFrame, "id" | "x" | "y" | "size" | "depth" | "phase" | "unfold">;

/** A departing crewmate, or a spark not yet unfolded, is not there to point at. */
const pointable = (c: Pick<CrewmateFrame, "phase" | "unfold">) =>
  c.phase !== "leaving" && c.unfold >= 0.5;

/** How close the pointer must come to a crewmate's painted centre, px on screen. */
export function crewHitRadius(size: number, scale = 1): number {
  return Math.max((size * scale) / 2 + CREW_HOVER.padPx, CREW_HOVER.minPx);
}

/**
 * Whether the pointer is in the slow zone: over an occupied orbit (the
 * frame's `orbits`, every computer's) - inside its ellipse with both
 * semi-axes widened by the margin - or within the margin of a crewmate
 * there to point at, such as a reviewer circling off the orbit. The air
 * above and below a flattened orbit is not in it. In screen pixels from the
 * formation's centre: the fit shrinks the orbits, not the margin.
 */
export function inCrewZone(
  frame: { orbits: OrbitFrame["orbits"]; crew: readonly Target[] },
  x: number,
  y: number,
  scale = 1,
): boolean {
  const margin = CREW_HOVER.zoneMarginPx;
  const near = (c: Target) =>
    pointable(c) && Math.hypot(x - c.x * scale, y - c.y * scale) <= margin;
  return (
    frame.crew.some(near) ||
    frame.orbits.some((orbit) => {
      const dx = x - orbit.x * scale;
      const dy = y - orbit.y * scale;
      const cos = Math.cos(orbit.angle);
      const sin = Math.sin(orbit.angle);
      const along = (dx * cos + dy * sin) / (orbit.major * scale + margin);
      const across = (dy * cos - dx * sin) / (orbit.minor * scale + margin);
      return along * along + across * across <= 1;
    })
  );
}

/**
 * The crewmate under the pointer. The nearest painted centre within its
 * acquire radius wins, and the one nearer the camera when two are equally
 * near. A crewmate already held keeps the pointer out to its release radius,
 * so the pointer does not flutter at the edge; a neighbour takes over only
 * once the pointer has left the held one's own acquire radius.
 */
export function crewHit(
  crew: readonly Target[],
  x: number,
  y: number,
  scale = 1,
  held: string | null = null,
): string | null {
  let best: { id: string; distance: number; depth: number } | null = null;
  let heldDistance: number | null = null;
  let heldRadius = 0;
  for (const c of crew) {
    if (!pointable(c)) continue;
    const distance = Math.hypot(x - c.x * scale, y - c.y * scale);
    const radius = crewHitRadius(c.size, scale);
    if (c.id === held) {
      heldDistance = distance;
      heldRadius = radius;
    }
    if (distance > radius) continue;
    const tie = best !== null && Math.abs(distance - best.distance) < 0.5;
    if (!best || (tie ? c.depth > best.depth : distance < best.distance))
      best = { id: c.id, distance, depth: c.depth };
  }
  if (heldDistance !== null) {
    if (heldDistance <= heldRadius) return held;
    if (!best && heldDistance <= heldRadius * CREW_HOVER.release) return held;
  }
  return best?.id ?? null;
}

export type Box = { left: number; top: number; right: number; bottom: number };

/** Where a summary may sit: inside `within`, and over none of `avoid`. */
export type SummaryRoom = { within: Box; avoid: readonly Box[] };

export type SummaryPlacement = {
  /** The panel's top-left corner. */
  x: number;
  y: number;
  /** The hairline from the brackets to the panel: its start, length and angle (radians). */
  line: { x: number; y: number; length: number; angle: number };
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(Math.max(min, max), value));

/** Whether a panel at `at` lies inside `room.within` and over none of `room.avoid`. */
function hasRoom(
  at: { x: number; y: number },
  panel: { width: number; height: number },
  room: SummaryRoom,
): boolean {
  const { within } = room;
  return (
    at.x >= within.left &&
    at.x + panel.width <= within.right &&
    at.y >= within.top &&
    at.y + panel.height <= within.bottom &&
    !room.avoid.some((box) => overlaps(at, panel, box))
  );
}

function overlaps(
  at: { x: number; y: number },
  panel: { width: number; height: number },
  box: Box,
): boolean {
  return (
    at.x < box.right &&
    at.x + panel.width > box.left &&
    at.y < box.bottom &&
    at.y + panel.height > box.top
  );
}

/**
 * The hairline from `anchor`, starting `reach` out from it, to the nearest
 * point of the panel placed at `at`.
 */
function tie(
  anchor: { x: number; y: number },
  reach: number,
  at: { x: number; y: number },
  panel: { width: number; height: number },
): SummaryPlacement["line"] {
  const tx = clamp(anchor.x, at.x, at.x + panel.width);
  const ty = clamp(anchor.y, at.y, at.y + panel.height);
  const distance = Math.hypot(tx - anchor.x, ty - anchor.y);
  const ux = distance > 0 ? (tx - anchor.x) / distance : 0;
  const uy = distance > 0 ? (ty - anchor.y) / distance : 0;
  return {
    x: anchor.x + ux * reach,
    y: anchor.y + uy * reach,
    length: Math.max(0, distance - reach),
    angle: Math.atan2(uy, ux),
  };
}

/**
 * Where the summary sits: beside the crewmate on the side away from the
 * character, level with it; where that has no room, under or over it (away
 * from the character first); and only then on the character's side. A place
 * has room when it lies inside `room.within` and over none of `room.avoid`.
 * `clear` is what the panel must not cover: the brackets round the crewmate,
 * and its name when it shows one. `reach` is the brackets' half-size, where
 * the hairline starts.
 */
export function placeCrewSummary(
  anchor: { x: number; y: number },
  reach: number,
  clear: Box,
  panel: { width: number; height: number },
  room: SummaryRoom,
): SummaryPlacement {
  const { within } = room;
  const { width, height } = panel;
  const lead = CREW_HOVER.leadPx;
  const beside = (right: boolean) => ({
    x: right ? clear.right + lead : clear.left - lead - width,
    y: clamp(anchor.y - height / 2, within.top, within.bottom - height),
  });
  const stacked = (below: boolean) => ({
    x: clamp(anchor.x - width / 2, within.left, within.right - width),
    y: below ? clear.bottom + lead : clear.top - lead - height,
  });
  const away = anchor.x >= 0;
  const down = anchor.y >= 0;
  const places = [beside(away), stacked(down), stacked(!down), beside(!away)];
  const first = places[0] as { x: number; y: number };
  const at = places.find((place) => hasRoom(place, panel, room)) ?? {
    x: clamp(first.x, within.left, within.right - width),
    y: first.y,
  };
  // The hairline runs from the brackets toward the nearest point of the panel.
  return { ...at, line: tie(anchor, reach, at, panel) };
}

/**
 * Where a summary sits beside a panel or card whose sides are `edge`,
 * level with `row`: outside it, on the side facing the middle of
 * `room.within` - the stage - with the lead between them. A place has room
 * as for a crewmate's summary; where the level place is over something to
 * avoid, it rises above that, and where that side has no room at all it
 * takes the other. Null when neither side has room; `left` is whether it
 * sits on the edge's left.
 */
function besideEdge(
  row: Pick<Box, "top" | "bottom">,
  edge: Pick<Box, "left" | "right">,
  panel: { width: number; height: number },
  room: SummaryRoom,
): { at: { x: number; y: number }; left: boolean } | null {
  const { within } = room;
  const { height } = panel;
  const middle = (row.top + row.bottom) / 2;
  const level = clamp(middle - height / 2, within.top, within.bottom - height);
  const towardLeft = facesLeft(edge, room);
  const inTheWay = (at: { x: number; y: number }) =>
    room.avoid.filter((box) => overlaps(at, panel, box));
  const placeOn = (left: boolean) => {
    const at = { x: besideX(edge, panel, left), y: level };
    // Each rise clears the highest thing in the way, so this ends.
    let hits = inTheWay(at);
    while (hits.length > 0) {
      at.y = Math.min(...hits.map((box) => box.top)) - height;
      if (at.y < within.top) return null;
      hits = inTheWay(at);
    }
    return hasRoom(at, panel, room) ? { at, left } : null;
  };
  return placeOn(towardLeft) ?? placeOn(!towardLeft);
}

/** Whether the side of `edge` facing the middle of `room.within` is its left. */
function facesLeft(edge: Pick<Box, "left" | "right">, room: SummaryRoom): boolean {
  return (edge.left + edge.right) / 2 > (room.within.left + room.within.right) / 2;
}

/** The panel's left edge beside `edge`, the lead clear of it, on one side. */
function besideX(edge: Pick<Box, "left" | "right">, panel: { width: number }, left: boolean) {
  return left ? edge.left - CREW_HOVER.leadPx - panel.width : edge.right + CREW_HOVER.leadPx;
}

/**
 * Where a Tasks row's summary sits (FI3-565 piece 3; the design skill's
 * NowPanel, Row hover): beside the panel the row is in (`besideEdge`),
 * centred on `row`; with room on neither side it keeps the stage side,
 * pulled inside the window. The hairline runs from the panel's edge at the
 * row's middle.
 */
export function placeRowSummary(
  row: Pick<Box, "top" | "bottom">,
  edge: Pick<Box, "left" | "right">,
  panel: { width: number; height: number },
  room: SummaryRoom,
): SummaryPlacement {
  const middle = (row.top + row.bottom) / 2;
  const beside = besideEdge(row, edge, panel, room);
  const towardLeft = facesLeft(edge, room);
  const at = beside?.at ?? {
    x: clamp(besideX(edge, panel, towardLeft), room.within.left, room.within.right - panel.width),
    y: clamp(middle - panel.height / 2, room.within.top, room.within.bottom - panel.height),
  };
  const left =
    beside?.left ?? (at.x + panel.width <= edge.left || (at.x < edge.right && towardLeft));
  return { ...at, line: tie({ x: left ? edge.left : edge.right, y: middle }, 0, at, panel) };
}

/**
 * Where a task key's summary sits (FI3-594; the design skill's core rule
 * "Task keys"): beside the card the key is in, the
 * way a Tasks row's sits beside its panel - level with `key`, its hairline
 * leaving the card's edge on the key's line, so it strikes through none of
 * the words between. Where neither side of the card has room - a narrow
 * window - it sits under the key's line, or over it, the lead clear of the
 * key and centred on it, its hairline from the key itself: it may cover
 * the card's other words, never the key.
 */
export function placeKeySummary(
  key: Box,
  card: Pick<Box, "left" | "right">,
  panel: { width: number; height: number },
  room: SummaryRoom,
): SummaryPlacement {
  const middle = (key.top + key.bottom) / 2;
  const beside = besideEdge(key, card, panel, room);
  if (beside) {
    const { at, left } = beside;
    return { ...at, line: tie({ x: left ? card.left : card.right, y: middle }, 0, at, panel) };
  }
  const { within } = room;
  const lead = CREW_HOVER.leadPx;
  const x = clamp(
    (key.left + key.right) / 2 - panel.width / 2,
    within.left,
    within.right - panel.width,
  );
  const under = { x, y: key.bottom + lead };
  const over = { x, y: key.top - lead - panel.height };
  const at = [under, over].find((place) => hasRoom(place, panel, room)) ?? {
    x,
    y: clamp(under.y, within.top, within.bottom - panel.height),
  };
  const centre = { x: (key.left + key.right) / 2, y: middle };
  return { ...at, line: tie(centre, (key.bottom - key.top) / 2, at, panel) };
}
