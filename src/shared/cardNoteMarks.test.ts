import { describe, expect, it } from "vitest";
import {
  boxPlace,
  keyStep,
  linePlace,
  marksSvg,
  middleBox,
  movedBox,
  sizedBox,
  smallCopy,
} from "./cardNoteMarks";
import { NOTE_LINE_POINTS_MAX, notePlaceSchema, type PlacePoint } from "./cardNotes";

/**
 * A mark on a picture as a pointer or the arrow keys make it, and as every
 * surface draws it (docs/card-threads.md, "Pointing at a place"). The picture
 * is the 1,280 by 800 one a task's page is shown in; the drawing is the 750 by
 * 120 one a card's figure is drawn at.
 */

const page = { width: 1280, height: 800 };
const drawing = { width: 750, height: 120 };
const look = { ink: "#3b82f6", ground: "#ffffff" };

/** Where each mark's number is drawn: the filled circle its number sits in. */
function badges(svg: string): { x: number; y: number; r: number; number: number }[] {
  const found = svg.matchAll(
    /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="#3b82f6" stroke="#ffffff"[^>]*\/><text[^>]*>(\d+)<\/text>/g,
  );
  return [...found].map(([, x, y, r, number]) => ({
    x: Number(x),
    y: Number(y),
    r: Number(r),
    number: Number(number),
  }));
}

describe("a mark as a pointer makes it", () => {
  it("makes the box between a drag's two points, whichever way it ran, in whole pixels", () => {
    expect(boxPlace(page, { x: 612.4, y: 88.6 }, { x: 455.2, y: 31.9 })).toEqual({
      ...page,
      box: { x: 455, y: 32, width: 157, height: 57 },
    });
  });

  it("keeps a drag that left the picture inside it, and reads a press with no drag as a spot", () => {
    expect(boxPlace(page, { x: 1100, y: 700 }, { x: 1400, y: 940 }).box).toEqual({
      x: 1100,
      y: 700,
      width: 180,
      height: 100,
    });
    expect(boxPlace(page, { x: 300.2, y: 60.7 }, { x: 300.2, y: 60.7 }).box).toEqual({
      x: 300,
      y: 61,
      width: 0,
      height: 0,
    });
  });

  it("keeps a drawn line's points in whole pixels inside the picture, with a pen's width where it gave one", () => {
    const drawn = linePlace(drawing, [
      { x: 300.4, y: 40.2, w: 1.2 },
      { x: 300.1, y: 40.4, w: 1.4 },
      { x: 372.6, y: 58.9, w: 3.6 },
      { x: 780, y: 131, w: 0.2 },
    ]);
    // The second point rounds onto the first, so it is dropped; a width is never under a pixel.
    expect(drawn).toEqual({
      ...drawing,
      lines: [
        [
          { x: 300, y: 40, w: 1 },
          { x: 373, y: 59, w: 4 },
          { x: 750, y: 120, w: 1 },
        ],
      ],
    });
    expect(linePlace(drawing, [])).toBeUndefined();
  });

  it("thins a long line evenly to the most a note carries, keeping where it starts and ends", () => {
    const long: PlacePoint[] = Array.from({ length: 1_000 }, (_, at) => ({ x: at, y: at % 700 }));
    const drawn = linePlace(page, long);
    const line = drawn?.lines?.[0] ?? [];
    expect(line).toHaveLength(NOTE_LINE_POINTS_MAX);
    expect(line[0]).toEqual({ x: 0, y: 0 });
    expect(line.at(-1)).toEqual({ x: 999, y: 299 });
    // A note takes what the pointer drew.
    expect(notePlaceSchema.safeParse(drawn).success).toBe(true);
  });
});

describe("a box the arrow keys make", () => {
  it("starts in the picture's middle at a quarter of each side and moves a hundredth of the longer side", () => {
    expect(middleBox(page).box).toEqual({ x: 480, y: 300, width: 320, height: 200 });
    expect(keyStep(page)).toBe(13);
    expect(keyStep({ width: 60, height: 40 })).toBe(1);
  });

  it("moves whole inside its picture and sizes from its top left corner, never under a pixel or past the picture", () => {
    const start = middleBox(page);
    expect(movedBox(start, -13, 13).box).toEqual({ x: 467, y: 313, width: 320, height: 200 });
    expect(movedBox(start, -2_000, 2_000).box).toEqual({ x: 0, y: 600, width: 320, height: 200 });
    expect(sizedBox(start, 13, -13).box).toEqual({ x: 480, y: 300, width: 333, height: 187 });
    expect(sizedBox(start, 2_000, -2_000).box).toEqual({ x: 480, y: 300, width: 800, height: 1 });
  });
});

describe("the marks as every surface draws them", () => {
  it("numbers each mark beside it, clear of what it marks", () => {
    const svg = marksSvg(
      page,
      [
        { number: 1, place: { ...page, box: { x: 455, y: 132, width: 157, height: 57 } } },
        { number: 2, place: { ...page, box: { x: 900, y: 400, width: 0, height: 0 } } },
        {
          number: 3,
          place: {
            ...page,
            lines: [
              [
                { x: 200, y: 600 },
                { x: 260, y: 640 },
              ],
            ],
          },
        },
      ],
      look,
    );
    const [box, spot, line] = badges(svg);
    expect([box?.number, spot?.number, line?.number]).toEqual([1, 2, 3]);
    // The badge's middle is up and to the left of the box's corner, by its own radius.
    expect(Math.hypot(455 - (box?.x ?? 0), 132 - (box?.y ?? 0))).toBeCloseTo(box?.r ?? 0, 1);
    expect(box?.x).toBeLessThan(455);
    expect(box?.y).toBeLessThan(132);
    // A spot's ring, six units wide, is cleared whole.
    const unit = (spot?.r ?? 0) / 8;
    expect(Math.hypot(900 - (spot?.x ?? 0), 400 - (spot?.y ?? 0))).toBeCloseTo(14 * unit, 1);
    expect(Math.hypot(200 - (line?.x ?? 0), 600 - (line?.y ?? 0))).toBeCloseTo(line?.r ?? 0, 1);
  });

  it("keeps a number inside the picture for a mark in its corner", () => {
    const [corner] = badges(
      marksSvg(
        page,
        [{ number: 1, place: { ...page, box: { x: 0, y: 0, width: 40, height: 30 } } }],
        look,
      ),
    );
    expect(corner?.x).toBe(corner?.r);
    expect(corner?.y).toBe(corner?.r);
  });

  it("draws a small copy no larger than its picture, with marks that still read at that size", () => {
    // A page's picture in the queued note's 220 by 160 copy: a mark's unit grows as the picture shrinks.
    const copy = smallCopy(page, 220, 160);
    expect(copy.width).toBe(220);
    expect(copy.unit).toBeCloseTo(1280 / 220, 5);
    // A picture smaller than the copy is drawn at its own size.
    expect(smallCopy({ width: 96, height: 64 }, 220, 160)).toEqual({ width: 96, unit: 1 });
  });
});
