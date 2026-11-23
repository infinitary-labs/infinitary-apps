/**
 * Layout as invariants, as a browser test reads it (docs/testing.md, "The
 * e2e assertion contract"): measured boxes compared with each other - inside
 * the window, clear of a neighbour - never a pixel typed into a test.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** Sub-pixel rounding between two boxes laid out by the same engine is not a breach. */
const ROUNDING = 0.5;

export const windowBox = (): Rect => ({ x: 0, y: 0, width: innerWidth, height: innerHeight });

/**
 * The edges of `inner` that reach past `outer`, each with how far - empty
 * when `inner` lies inside. `expect(within(a, b)).toEqual([])` fails naming
 * the edge that escaped.
 */
export function within(inner: Rect, outer: Rect): string[] {
  const escaped: string[] = [];
  const past = (edge: string, by: number) => {
    if (by > ROUNDING) escaped.push(`${edge} by ${by.toFixed(1)}px`);
  };
  past("left", outer.x - inner.x);
  past("top", outer.y - inner.y);
  past("right", inner.x + inner.width - (outer.x + outer.width));
  past("bottom", inner.y + inner.height - (outer.y + outer.height));
  return escaped;
}

/** Whether two boxes share more than a rounding's worth of area (touching edges do not). */
export function intersects(a: Rect, b: Rect): boolean {
  const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return across > ROUNDING && down > ROUNDING;
}
