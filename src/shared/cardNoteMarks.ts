import {
  NOTE_LINE_POINTS_MAX,
  type NotePlace,
  type PlaceBox,
  type PlacePoint,
  placeBounds,
} from "./cardNotes";

/**
 * How a note's place is made and drawn (docs/card-threads.md, "Pointing at a
 * place"): the geometry a pointer or the arrow keys give, in the picture's
 * own pixels, and the one drawing every surface shows - the viewer over its
 * picture, the queued note's small copy and the picture the author is sent.
 * It runs nothing and reads no window, so the window, a test and a later
 * phone draw the same marks.
 */

export type PictureSize = { width: number; height: number };

/** A mark as it is drawn: its number in the order queued, and whether it is the one being written. */
export type DrawnMark = { number: number; place: NotePlace; lit?: boolean };

/** The two colors a mark is drawn in: its ink, and the ground that keeps it legible on any picture. */
export type MarkLook = { ink: string; ground: string };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** One unit of a mark's drawing in picture pixels: a mark reads the same on a small picture and a large one. */
export function markUnit(size: PictureSize): number {
  return Math.max(1, Math.max(size.width, size.height) / 500);
}

/** The box between two points of a drag, inside the picture; a press with no drag is a spot, a box of no size. */
export function boxPlace(
  size: PictureSize,
  from: { x: number; y: number },
  to: { x: number; y: number },
): NotePlace {
  const left = Math.round(clamp(Math.min(from.x, to.x), 0, size.width));
  const top = Math.round(clamp(Math.min(from.y, to.y), 0, size.height));
  const right = Math.round(clamp(Math.max(from.x, to.x), 0, size.width));
  const bottom = Math.round(clamp(Math.max(from.y, to.y), 0, size.height));
  return {
    width: size.width,
    height: size.height,
    box: { x: left, y: top, width: right - left, height: bottom - top },
  };
}

/**
 * One drawn line inside the picture: each point rounded to a pixel, repeats dropped, and a long
 * line thinned evenly to the most a note carries, keeping where it starts and ends.
 */
export function linePlace(size: PictureSize, points: readonly PlacePoint[]): NotePlace | undefined {
  const drawn: PlacePoint[] = [];
  for (const point of points) {
    const next: PlacePoint = {
      x: Math.round(clamp(point.x, 0, size.width)),
      y: Math.round(clamp(point.y, 0, size.height)),
      ...(point.w !== undefined ? { w: Math.max(1, Math.round(point.w)) } : {}),
    };
    const last = drawn.at(-1);
    if (last && last.x === next.x && last.y === next.y) continue;
    drawn.push(next);
  }
  if (drawn.length === 0) return undefined;
  const kept =
    drawn.length <= NOTE_LINE_POINTS_MAX
      ? drawn
      : Array.from(
          { length: NOTE_LINE_POINTS_MAX },
          (_, at) =>
            drawn[Math.round((at * (drawn.length - 1)) / (NOTE_LINE_POINTS_MAX - 1))] as PlacePoint,
        );
  return { width: size.width, height: size.height, lines: [kept] };
}

/** The box the arrow keys start from: the picture's middle, a quarter of each side. */
export function middleBox(size: PictureSize): NotePlace {
  const width = Math.max(1, Math.round(size.width / 4));
  const height = Math.max(1, Math.round(size.height / 4));
  return {
    width: size.width,
    height: size.height,
    box: {
      x: Math.round((size.width - width) / 2),
      y: Math.round((size.height - height) / 2),
      width,
      height,
    },
  };
}

/** How far one arrow press moves or sizes a box: a hundredth of the picture's longer side. */
export function keyStep(size: PictureSize): number {
  return Math.max(1, Math.round(Math.max(size.width, size.height) / 100));
}

/** A box moved by the arrows, kept whole inside its picture. */
export function movedBox(place: NotePlace, dx: number, dy: number): NotePlace {
  const box = place.box as PlaceBox;
  return {
    ...place,
    box: {
      ...box,
      x: clamp(box.x + dx, 0, Math.max(0, place.width - box.width)),
      y: clamp(box.y + dy, 0, Math.max(0, place.height - box.height)),
    },
  };
}

/** A box sized by Shift and the arrows from its top left corner, never smaller than a pixel or past its picture. */
export function sizedBox(place: NotePlace, dw: number, dh: number): NotePlace {
  const box = place.box as PlaceBox;
  return {
    ...place,
    box: {
      ...box,
      width: clamp(box.width + dw, 1, Math.max(1, place.width - box.x)),
      height: clamp(box.height + dh, 1, Math.max(1, place.height - box.y)),
    },
  };
}

const escaped = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const n = (value: number) => String(Math.round(value * 100) / 100);

function boxShapes(box: PlaceBox, unit: number, look: MarkLook, lit: boolean): string {
  const ink = escaped(look.ink);
  const ground = escaped(look.ground);
  if (box.width === 0 && box.height === 0) {
    // i18n-exempt: drawing markup, not words
    const ring = `cx="${n(box.x)}" cy="${n(box.y)}" r="${n(6 * unit)}" fill="none"`;
    return (
      `<circle ${ring} stroke="${ground}" stroke-width="${n(4 * unit)}"/>` +
      `<circle ${ring} stroke="${ink}" stroke-width="${n(2 * unit)}"/>` +
      `<circle cx="${n(box.x)}" cy="${n(box.y)}" r="${n(1.5 * unit)}" fill="${ink}"/>`
    );
  }
  // i18n-exempt: drawing markup, not words
  const frame = `x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" rx="${n(unit)}"`;
  return (
    `<rect ${frame} fill="none" stroke="${ground}" stroke-width="${n(4 * unit)}"/>` +
    `<rect ${frame} fill="${lit ? ink : "none"}" fill-opacity="0.14" stroke="${ink}" stroke-width="${n(2 * unit)}"/>`
  );
}

function lineShapes(line: readonly PlacePoint[], unit: number, look: MarkLook): string {
  const ink = escaped(look.ink);
  const ground = escaped(look.ground);
  // i18n-exempt: drawing markup, not words
  const round = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const first = line[0] as PlacePoint;
  if (line.length === 1) {
    const r = (first.w ?? 2 * unit) / 2 + unit;
    return (
      `<circle cx="${n(first.x)}" cy="${n(first.y)}" r="${n(r + unit)}" fill="${ground}"/>` +
      `<circle cx="${n(first.x)}" cy="${n(first.y)}" r="${n(r)}" fill="${ink}"/>`
    );
  }
  // A pen's pressure gives each point its own width: each stretch is drawn at the mean of its ends.
  if (line.some((point) => point.w !== undefined)) {
    let under = "";
    let over = "";
    for (let at = 1; at < line.length; at++) {
      const a = line[at - 1] as PlacePoint;
      const b = line[at] as PlacePoint;
      const width = ((a.w ?? 2 * unit) + (b.w ?? 2 * unit)) / 2;
      // i18n-exempt: drawing markup, not words
      const ends = `x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke-linecap="round"`;
      under += `<line ${ends} stroke="${ground}" stroke-width="${n(width + 2 * unit)}"/>`;
      over += `<line ${ends} stroke="${ink}" stroke-width="${n(width)}"/>`;
    }
    return under + over;
  }
  const points = line.map((point) => `${n(point.x)},${n(point.y)}`).join(" ");
  return (
    `<polyline points="${points}" ${round} stroke="${ground}" stroke-width="${n(4 * unit)}"/>` +
    `<polyline points="${points}" ${round} stroke="${ink}" stroke-width="${n(2 * unit)}"/>`
  );
}

/**
 * Where a mark's number sits: beside its box's top left corner or where its line starts, up and
 * to the left so it covers none of what is marked, and kept inside the picture.
 */
function badgeAt(place: NotePlace, unit: number): { x: number; y: number } {
  const start = place.box ?? place.lines?.[0]?.[0] ?? placeBounds(place);
  const radius = 8 * unit;
  // A spot's ring is cleared whole; a box's corner or a line's start is only touched.
  const spot = place.box !== undefined && place.box.width === 0 && place.box.height === 0;
  const away = (radius + (spot ? 6 * unit : 0)) / Math.SQRT2;
  return {
    x: clamp(start.x - away, radius, Math.max(radius, place.width - radius)),
    y: clamp(start.y - away, radius, Math.max(radius, place.height - radius)),
  };
}

/**
 * The marks of one picture as a drawing of that picture's own size, one unit to a pixel, to lay
 * over it: each place in the ink over a ground halo, with its number in a filled badge. `unit`
 * is given where the picture is shown much smaller than it is, so its marks still read.
 */
export function marksSvg(
  size: PictureSize,
  marks: readonly DrawnMark[],
  look: MarkLook,
  unit = markUnit(size),
): string {
  let shapes = "";
  for (const mark of marks) {
    if (mark.place.box) shapes += boxShapes(mark.place.box, unit, look, mark.lit === true);
    for (const line of mark.place.lines ?? []) shapes += lineShapes(line, unit, look);
  }
  // Numbers last, so no later mark's ink crosses an earlier one's number.
  for (const mark of marks) {
    const at = badgeAt({ ...mark.place, width: size.width, height: size.height }, unit);
    shapes +=
      `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(8 * unit)}" fill="${escaped(look.ink)}" stroke="${escaped(look.ground)}" stroke-width="${n(1.5 * unit)}"/>` +
      `<text x="${n(at.x)}" y="${n(at.y)}" fill="${escaped(look.ground)}" font-family="system-ui, sans-serif" font-size="${n(10 * unit)}" font-weight="600" text-anchor="middle" dominant-baseline="central">${mark.number}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${shapes}</svg>`;
}

/** The drawing as a picture's address, which any `<img>` shows and runs nothing. */
export function marksSource(
  size: PictureSize,
  marks: readonly DrawnMark[],
  look: MarkLook,
  unit?: number,
): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(marksSvg(size, marks, look, unit))}`;
}

/**
 * How a marked picture's small copy is drawn, at most `width` by `height` and never larger than
 * the picture: its drawn width, and the unit its marks take so a line stays a pixel or two wide.
 */
export function smallCopy(
  size: PictureSize,
  width: number,
  height: number,
): { width: number; unit: number } {
  const scale = Math.min(width / size.width, height / size.height, 1);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    unit: Math.max(markUnit(size), 1 / scale),
  };
}
