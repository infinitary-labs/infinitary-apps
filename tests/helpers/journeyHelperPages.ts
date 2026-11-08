import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { BrowserCommandContext } from "vitest/node";
import type { IdleReading, LayoutProbe, LayoutReading } from "./browserProvided";

/**
 * The journeys' own Playwright helpers, run on a plain page of the browser
 * layer's Chromium, with no Electron and no app (docs/testing.md, "The
 * browser layer"). A helper that takes a Playwright `Page` is checked here
 * on the inputs its own test builds, where a journey launched the whole app
 * only to replace its page (INF-2456, repairing INF-2417's ledger rows for
 * helper tests that launched the app). Each command opens its own page in
 * the test's browser and closes it, so the test's window is left as it was.
 */

async function onPlainPage<T>(
  context: BrowserCommandContext,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await context.page.context().newPage();
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

/**
 * Places a surface and a control, each 40 by 40 at (200, 200), then moves
 * the surface to each probe in turn and reads it with the layout helpers of
 * `tests/e2e/layout.ts`: `clearOfLosses` for every probe, and `expectClearOf`
 * only where the losses are none, as a journey asks it of a settled layout.
 */
export async function layoutReadings(
  context: BrowserCommandContext,
  probes: LayoutProbe[],
): Promise<LayoutReading[]> {
  const { clearOfLosses, expectClearOf } = await context.project.import<
    typeof import("../e2e/layout")
  >(join(context.project.config.root, "tests/e2e/layout.ts"));
  return onPlainPage(context, async (page) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent("<!doctype html><body></body>");
    await page.evaluate(() => {
      for (const name of ["surface", "control"]) {
        const element = document.createElement("div");
        element.dataset.layoutProbe = name;
        element.textContent = name;
        element.style.cssText =
          "position:fixed;left:200px;top:200px;width:40px;height:40px;z-index:99999";
        document.body.append(element);
      }
    });
    const surface = page.locator('[data-layout-probe="surface"]');
    const control = page.locator('[data-layout-probe="control"]');
    const readings: LayoutReading[] = [];
    for (const probe of probes) {
      await surface.evaluate(
        (element, at) => {
          (element as HTMLElement).style.left = `${at.left}px`;
          (element as HTMLElement).style.top = `${at.top}px`;
        },
        { left: probe.left, top: probe.top },
      );
      if (probe.controlRemoved) await control.evaluate((element) => element.remove());
      const losses = await clearOfLosses(page, surface, control);
      const accepted =
        losses.length === 0 &&
        (await expectClearOf(page, surface, control).then(
          () => true,
          () => false,
        ));
      readings.push({ losses, accepted });
    }
    return readings;
  });
}

/**
 * Drives the opening order the first mate's character goes through at
 * launch on a stand-in canvas, and reads `waitForFirstmateIdle` of
 * `tests/e2e/crew.ts` after each step: an undrawn idle, a drawn greet, then
 * a drawn idle on a hidden canvas. Each reading waits until the helper has
 * read the step's label, so whether it resolved is read after it looked.
 */
export async function firstmateIdleReadings(
  context: BrowserCommandContext,
): Promise<IdleReading[]> {
  const { waitForFirstmateIdle } = await context.project.import<typeof import("../e2e/crew")>(
    join(context.project.config.root, "tests/e2e/crew.ts"),
  );
  return onPlainPage(context, async (page) => {
    await page.setContent('<canvas role="img" aria-label="First mate - idle" hidden></canvas>');
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="img"]');
      if (!canvas) throw new Error("Missing character fixture");
      const read = canvas.toDataURL.bind(canvas);
      canvas.toDataURL = (...args) => {
        canvas.dataset.read = canvas.getAttribute("aria-label") ?? "";
        return read(...args);
      };
    });
    const character = page.getByRole("img", { name: /^First mate - /, includeHidden: true });
    let resolved = false;
    const idle = waitForFirstmateIdle(page).then(() => {
      resolved = true;
    });
    const readings: IdleReading[] = [];
    const readAfter = async (label: string) => {
      await character.evaluate(
        (node, label) =>
          new Promise<void>((done) => {
            const check = () =>
              node.getAttribute("data-read") === label ? done() : requestAnimationFrame(check);
            check();
          }),
        label,
      );
      readings.push({ read: await character.getAttribute("data-read"), resolved });
    };
    // The helper has read the undrawn idle.
    await readAfter("First mate - idle");
    await character.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      canvas.setAttribute("aria-label", "First mate - greet");
      canvas.getContext("2d")?.fillRect(0, 0, 10, 10);
    });
    await readAfter("First mate - greet");
    await character.evaluate((canvas) => canvas.setAttribute("aria-label", "First mate - idle"));
    await idle;
    readings.push({ read: await character.getAttribute("data-read"), resolved });
    return readings;
  });
}
