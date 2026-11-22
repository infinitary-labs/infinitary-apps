import type { Page } from "@playwright/test";

export type Point = { x: number; y: number };

/**
 * Whether each point drags the window, by Electron's own rule for the
 * regions a page marks with `-webkit-app-region`: every element's box marked
 * `drag` adds to the window's drag area and every box marked `no-drag`
 * subtracts from it, in page order. On a Mac, a pointer over a drag point
 * belongs to the window, not the page, so the page hears it leave.
 */
export function windowDragAt(page: Page, points: readonly Point[]): Promise<boolean[]> {
  return page.evaluate((at) => {
    const regions: { drag: boolean; box: DOMRect }[] = [];
    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      const region =
        style.getPropertyValue("app-region") || style.getPropertyValue("-webkit-app-region");
      if (region !== "drag" && region !== "no-drag") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      regions.push({ drag: region === "drag", box });
    }
    return at.map(({ x, y }) => {
      let drag = false;
      for (const { drag: adds, box } of regions) {
        if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) drag = adds;
      }
      return drag;
    });
  }, points);
}

export function pointsAlong(from: Point, to: Point, count: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}
