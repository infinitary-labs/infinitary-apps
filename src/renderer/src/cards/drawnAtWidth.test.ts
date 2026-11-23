import { describe, expect, it, vi } from "vitest";
import { DrawnAtWidth, type FrameWidth } from "./drawnAtWidth";

// INF-669: on hosted Linux the completion card's facts strip never got its
// drawn mark. The widths are the ones read there: the strip's frame is 614
// wide, and the card's first height flashes a 15 px scrollbar that narrows it
// to 599 while the page's report is on its way.
const WIDE = 614;
const NARROW = 599;

function frame(width: number): FrameWidth & { resize(to: number): void; watchers(): number } {
  let now = width;
  const watching = new Set<() => void>();
  return {
    read: () => now,
    watch(changed) {
      watching.add(changed);
      return () => watching.delete(changed);
    },
    resize(to) {
      now = to;
      for (const changed of [...watching]) changed();
    },
    watchers: () => watching.size,
  };
}

describe("a frame's drawing counts at its own width", () => {
  it("counts a drawing reported during the scrollbar's flash once the frame is back at its width", () => {
    const strip = frame(NARROW);
    const drawing = new DrawnAtWidth(strip);
    const drawn = vi.fn();
    drawing.report(WIDE, drawn);
    expect(drawn).not.toHaveBeenCalled();
    strip.resize(WIDE);
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(strip.watchers()).toBe(0);
  });

  it("counts a drawing at the frame's width at once, without watching", () => {
    const strip = frame(WIDE);
    const drawn = vi.fn();
    new DrawnAtWidth(strip).report(WIDE, drawn);
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(strip.watchers()).toBe(0);
  });

  it("drops a waiting report replaced by a newer one", () => {
    const strip = frame(NARROW);
    const drawing = new DrawnAtWidth(strip);
    const replaced = vi.fn();
    const newest = vi.fn();
    drawing.report(WIDE, replaced);
    drawing.report(WIDE + 40, newest);
    strip.resize(WIDE);
    expect(replaced).not.toHaveBeenCalled();
    strip.resize(WIDE + 40);
    expect(newest).toHaveBeenCalledTimes(1);
    expect(replaced).not.toHaveBeenCalled();
  });

  it("drops a waiting report when a new document starts", () => {
    const strip = frame(NARROW);
    const drawing = new DrawnAtWidth(strip);
    const drawn = vi.fn();
    drawing.report(WIDE, drawn);
    drawing.forget();
    expect(strip.watchers()).toBe(0);
    strip.resize(WIDE);
    expect(drawn).not.toHaveBeenCalled();
  });
});
