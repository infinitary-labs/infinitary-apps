import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { readInMain } from "./mainProcess";

/**
 * Layout as invariants (docs/testing.md, "The e2e assertion contract"): a
 * spec compares measured boxes with each other - inside its container, no
 * horizontal overflow, clear of its neighbour. The window's own minimum
 * supplies a boundary to exercise, never an expected card size.
 * The numbers a layout computes are the unit
 * tests' (`cardGeometry.test.ts`, `threadGeometry.test.ts`,
 * `record.frame.test.ts`); a pixel typed into a spec restates one window.
 */

/** A box as `getBoundingClientRect()` and Playwright's `boundingBox()` both give it. */
export type Rect = { x: number; y: number; width: number; height: number };

/** Sub-pixel rounding between two boxes laid out by the same engine is not a breach. */
const ROUNDING = 0.5;

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

/** Whether two boxes share any area (touching edges do not). */
export function intersects(a: Rect, b: Rect): boolean {
  const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return across > ROUNDING && down > ROUNDING;
}

/**
 * A surface stays reachable in the window without covering the controls
 * the journey still needs. No prescribed side, alignment or gap: a summary
 * may move above, below or beside its source without breaking this promise.
 * Missing boxes fail rather than passing as non-overlap.
 */
export async function expectClearOf(
  page: Page,
  surface: Locator,
  ...controls: Locator[]
): Promise<void> {
  await expect(surface).toBeVisible();
  await expect
    .poll(async () => {
      const box = (await surface.count()) === 0 ? null : await surface.boundingBox();
      if (!box) return ["surface missing"];
      const window = await page.evaluate(() => ({
        x: 0,
        y: 0,
        width: innerWidth,
        height: innerHeight,
      }));
      const losses = within(box, window);
      for (const [index, control] of controls.entries()) {
        const other = (await control.count()) === 0 ? null : await control.boundingBox();
        if (!other) losses.push(`control ${index} missing`);
        else if (intersects(box, other)) losses.push(`covers control ${index}`);
      }
      return losses;
    })
    .toEqual([]);
}

/**
 * How far the element's content reaches past its own width, in px: 0 when
 * it fits, so a row that ellipsizes or a body that wraps reads 0.
 */
export function overflows(target: Locator): Promise<number> {
  return target.evaluate((el) => Math.max(0, el.scrollWidth - el.clientWidth));
}

/**
 * A length token as the document resolves it now, in px - `--rail-width` is
 * `max(300px, 20vw)`, so it is only a number at a given window. `scope` is
 * the page, or any element of a frame whose tokens are wanted.
 */
export function tokenPx(scope: Page | Locator, name: string): Promise<number> {
  const root = "goto" in scope ? scope.locator(":root") : scope;
  return root.evaluate((el, token) => {
    const probe = el.ownerDocument.createElement("div");
    probe.style.cssText = `position: absolute; visibility: hidden; width: var(${token});`;
    el.ownerDocument.documentElement.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }, name);
}

/**
 * Where an element's `::before` or `::after` box really paints, in its
 * frame's coordinates, or null when it generates none. A generated box is
 * not in the DOM, so a spec would otherwise re-implement the stylesheet to
 * predict it; this anchors a hidden probe to it (CSS anchor positioning)
 * and measures the probe, leaving the page as it found it.
 */
export function pseudoBox(target: Locator, pseudo: "::before" | "::after"): Promise<Rect | null> {
  return target.evaluate((el, which) => {
    const generated = getComputedStyle(el, which);
    if (generated.content === "none" || generated.display === "none") return null;
    const mark = "data-e2e-pseudo-box";
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`[${mark}]${which} { anchor-name: --e2e-pseudo-box; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    el.setAttribute(mark, "");
    const probe = document.createElement("div");
    probe.style.cssText =
      "position: fixed; visibility: hidden; margin: 0; position-anchor: --e2e-pseudo-box;" +
      " left: anchor(left); top: anchor(top);" +
      " width: anchor-size(width); height: anchor-size(height);";
    document.documentElement.append(probe);
    const box = probe.getBoundingClientRect();
    probe.remove();
    el.removeAttribute(mark);
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, pseudo);
}

/**
 * A measurement once the layout holds still: `read` again until two reads
 * in a row agree. A card eases between widths as the stack pages, so boxes
 * taken mid-move - or in two reads either side of a frame - disagree with
 * each other though each was true when read.
 */
export async function settled<T>(read: () => Promise<T>): Promise<T> {
  let last: string | undefined;
  let value: T | undefined;
  await expect
    .poll(async () => {
      value = await read();
      const json = JSON.stringify(value);
      const same = json === last;
      last = json;
      return same;
    })
    .toBe(true);
  return value as T;
}

/**
 * Waits until no motion plays on `target` or on a box it sits in. A card
 * grows into place as it arrives (`--scale-arrive`, design skill Motion)
 * while its controls already work, so a box read inside it before then is
 * scaled on screen though its layout never changed. Unlike `settled`, it
 * waits on the motion itself rather than on two reads agreeing. A motion
 * that never ends is not waited for.
 */
export async function atRest(target: Locator): Promise<void> {
  await target.evaluate((element) =>
    Promise.all(
      document
        .getAnimations()
        .filter((motion) => {
          const effect = motion.effect;
          return (
            effect instanceof KeyframeEffect &&
            effect.target?.contains(element) === true &&
            effect.getComputedTiming().endTime !== Number.POSITIVE_INFINITY
          );
        })
        .map((motion) => motion.finished.catch(() => undefined)),
    ),
  );
}

/** A window's content area in device-independent pixels, before page zoom. */
export type WindowSize = { width: number; height: number };

/** The narrowest window the app allows, read off the window itself. */
export function minimumWindowSize(app: ElectronApplication): Promise<WindowSize> {
  return app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) throw new Error("App window missing");
    const [minimumWidth = 0, minimumHeight = 0] = window.getMinimumSize();
    const [outerWidth = 0, outerHeight = 0] = window.getSize();
    const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
    return {
      width: minimumWidth - (outerWidth - contentWidth),
      height: minimumHeight - (outerHeight - contentHeight),
    };
  });
}

/**
 * Resizes the app's content area and waits until the page lays out at that size.
 * Returns the content size it had, for a spec to put back. The window is the one
 * that shows `page`, never another the app holds, such as a task browser's
 * hidden page.
 */
export async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  size: WindowSize,
): Promise<WindowSize> {
  // Each main-process step reads or sets to a fixed value, so `readInMain`
  // may run it again when its answer is lost to a garbage collection.
  const appWindow = await readInMain(() => app.browserWindow(page));
  const before = await readInMain(() =>
    appWindow.evaluate((shown) => {
      const [width = 0, height = 0] = shown.getContentSize();
      return { width, height };
    }),
  );
  await readInMain(() =>
    appWindow.evaluate((shown, next) => shown.setContentSize(next.width, next.height), size),
  );
  const zoom = await readInMain(() =>
    appWindow.evaluate((shown) => shown.webContents.getZoomFactor()),
  );
  await expect
    .poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
    .toEqual({ width: Math.round(size.width / zoom), height: Math.round(size.height / zoom) });
  return before;
}

/** A point in the window, px. */
export type Point = { x: number; y: number };

/** One action of Chromium's own synthetic mouse, at a window point. */
type PointerAction = { name: "pointerMove" | "pointerDown" | "pointerUp"; button?: 0 } & Point;

/**
 * Plays `actions` with Chromium's own synthetic mouse
 * (`launchApp({ gpuBenchmarking: true })`), which Chromium routes between
 * the window and a frame - the Tasks panel, a card body - the way it routes
 * a real mouse, where Playwright's mouse goes straight to the frame under
 * the point.
 */
async function playPointer(page: Page, actions: PointerAction[]): Promise<void> {
  await page.evaluate(
    (actions) =>
      new Promise<void>((resolve, reject) => {
        const bench = (
          window as unknown as {
            chrome?: {
              gpuBenchmarking?: {
                pointerActionSequence: (actions: unknown, done: () => void) => boolean;
              };
            };
          }
        ).chrome?.gpuBenchmarking;
        if (!bench) return reject(new Error("Launch with gpuBenchmarking to move the pointer"));
        bench.pointerActionSequence([{ source: "mouse", actions }], resolve);
      }),
    actions,
  );
}

/**
 * Slides the pointer from one window point to another in `steps` moves
 * (`playPointer`): crossing into a frame also hands the window one move
 * aimed at the frame element, which Playwright's mouse never does.
 */
export async function slidePointer(
  page: Page,
  from: Point,
  to: Point,
  steps: number,
): Promise<void> {
  await playPointer(
    page,
    Array.from({ length: steps }, (_, index) => ({
      name: "pointerMove" as const,
      x: Math.round(from.x + ((to.x - from.x) * (index + 1)) / steps),
      y: Math.round(from.y + ((to.y - from.y) * (index + 1)) / steps),
    })),
  );
}

/** The window point at the centre of `target`, where a press on it goes. */
async function pressPoint(target: Locator): Promise<Point> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The press target is not on screen");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * The captain's own press on `target`, at its centre (`playPointer`): inside
 * a card's frame it focuses the frame and clicks there, as a real mouse
 * does, which no click a script dispatches does.
 */
export async function pressPointer(page: Page, target: Locator): Promise<void> {
  const at = await pressPoint(target);
  await playPointer(page, [
    { name: "pointerMove", ...at },
    { name: "pointerDown", ...at, button: 0 },
    { name: "pointerUp", ...at, button: 0 },
  ]);
}

/**
 * The captain's own press on `target` (`pressPointer`), held: the button
 * stays down until the returned release lets it go at the same point, so a
 * test changes what is under a held press in order, never by timing a hold.
 * Chromium's synthetic mouse starts each play at the window's corner with no
 * button down, so the release moves back to the point first - a move
 * Chromium hands to the frame the press went down in - and then lets go.
 */
export async function holdPointer(page: Page, target: Locator): Promise<() => Promise<void>> {
  const at = await pressPoint(target);
  await playPointer(page, [
    { name: "pointerMove", ...at },
    { name: "pointerDown", ...at, button: 0 },
  ]);
  return () =>
    playPointer(page, [
      { name: "pointerMove", ...at },
      { name: "pointerUp", ...at, button: 0 },
    ]);
}
