import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { closingNoteTitle } from "../../src/core/orchestrator/settleWords";
import { crewPlaneCounts, waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { CANCEL_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, startedLine, statusLine, taskKey } from "./rails";
import { expectNoCard, showCard } from "./stack";
import { runFromSearch } from "./windowKeys";

/**
 * The crew in orbit around the Firstmate (src/renderer/src/character/crew/):
 * a commissioned crewmate is painted on the ring around the character, the
 * ring turns, the ring holds the crew the core counts, a
 * cancelled crewmate leaves the ring, and under reduced motion a crewmate
 * appears settled: across many drawing frames the ring does not move, and a
 * move to a display of another density draws that still ring again at the
 * new sharpness instead of stretching it (FI3-743).
 * Everything is read off the real far/near canvases, so it exercises the
 * real wiring, loop, and painter.
 * Each named case owns a fresh app and any crew it needs, including the
 * cancellation case: no predecessor's task or media setting is a fixture.
 */

type Paint = {
  /** Pixels carrying visible ink across both layers. */
  count: number;
  /** Summed channels over those pixels. */
  r: number;
  g: number;
  b: number;
  /** Centroid of the ink, canvas px. */
  x: number;
  y: number;
  digest: string;
};

async function paint(page: Page): Promise<Paint> {
  return page.evaluate((): Paint => {
    const out = { count: 0, r: 0, g: 0, b: 0, x: 0, y: 0, digest: "" };
    for (const layer of ["far", "near"]) {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `canvas[data-crew-layer="${layer}"]`,
      );
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) throw new Error(`crew ${layer} layer missing`);
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 40) continue;
        const p = i / 4;
        out.count += 1;
        out.r += data[i] ?? 0;
        out.g += data[i + 1] ?? 0;
        out.b += data[i + 2] ?? 0;
        out.x += p % width;
        out.y += Math.floor(p / width);
      }
      out.digest += canvas.toDataURL("image/png");
    }
    if (out.count > 0) {
      out.x /= out.count;
      out.y /= out.count;
    }
    return out;
  });
}

/** The ring's accessible label, kept with the evidence; its words are the orbit's own. */
async function crewLabel(page: Page): Promise<string> {
  return (await page.locator('canvas[data-crew-layer="near"]').getAttribute("aria-label")) ?? "";
}

/** Crewmates on the ring as the orbit placed them, every plane together. */
async function ringSize(page: Page): Promise<number> {
  return (await crewPlaneCounts(page)).reduce((sum, count) => sum + count, 0);
}

/** The core's own crew counts: the ring follows these. */
function crewCounts(page: Page) {
  return page.evaluate(() => window.infinitary.crew.counts());
}

async function send(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** Commission through the real prompt and wait for this test's one idle crewmate. */
async function commissionIdleCrew(page: Page, title: string): Promise<string> {
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
  const key = await taskKey(page, title);
  await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect(reportLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => crewCounts(page)).toMatchObject({ working: 0, idle: 1 });
  await expect.poll(() => ringSize(page), { timeout: 15_000 }).toBe(1);
  await waitForFirstmateIdle(page);
  return key;
}

/** Product state and pictures accompany the assertions, without pixel snapshots. */
async function evidence(page: Page, name: string, picture = true): Promise<void> {
  const { digest: _digest, ...pixels } = await paint(page);
  const state = {
    label: await crewLabel(page),
    pixels,
    counts: await page.evaluate(() => window.infinitary.crew.counts()),
    tasks: (await page.evaluate(() => window.infinitary.tasks.board())).tasks,
  };
  const statePath = test.info().outputPath(`${name}.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  await test.info().attach(name, { path: statePath, contentType: "application/json" });
  if (picture) {
    const picturePath = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path: picturePath });
    await test.info().attach(name, { path: picturePath, contentType: "image/png" });
  }
}

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp({ withMockProvider: true });
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await waitForFirstmateIdle(page);
  expect((await page.evaluate(() => window.infinitary.tasks.board())).tasks).toEqual([]);
  await expect.poll(() => ringSize(page)).toBe(0);
  expect((await paint(page)).count).toBe(0);
  await evidence(page, "fresh", false);
});

test.afterEach(async () => {
  await launched.close();
});

test("a cancelled crewmate leaves the ring", async () => {
  const { page } = launched;
  const title = "write a cancellation probe note";
  const key = await commissionIdleCrew(page, title);
  await expect.poll(async () => (await paint(page)).count, { timeout: 5_000 }).toBeGreaterThan(40);
  await evidence(page, "before-cancellation");

  await send(page, `${CANCEL_PROMPT_MARKER}${title}`);
  await expect(statusLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      page.evaluate(
        async (wanted) =>
          (await window.infinitary.tasks.board()).tasks.find((task) => task.key === wanted),
        key,
      ),
    )
    .toMatchObject({ status: "dropped", closedReason: "cancelled" });
  await expect.poll(() => crewCounts(page)).toMatchObject({ working: 0, idle: 0 });
  await expect.poll(() => ringSize(page), { timeout: 15_000 }).toBe(0);
  // The first mate's closing note goes up (INF-547), and the ring is not
  // painted behind a card: close it to see the ring again.
  const note = closingNoteTitle(key, "dropped");
  await showCard(page, note);
  await runFromSearch(launched.app, page, "cards.close");
  await expectNoCard(page, note);
  await expect.poll(async () => (await paint(page)).count, { timeout: 5_000 }).toBe(0);
  await evidence(page, "cancelled");
});

test("under reduced motion a crewmate appears settled: one still frame", async () => {
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await commissionIdleCrew(page, "write a still note");
  await expect.poll(async () => (await paint(page)).count, { timeout: 5_000 }).toBeGreaterThan(0);
  // Counted in drawing frames, not time: across them nothing on the ring moves.
  const [first, last] = await page.evaluate(
    () =>
      new Promise<[string, string]>((resolve) => {
        const digest = () =>
          [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-crew-layer]")]
            .map((canvas) => canvas.toDataURL("image/png"))
            .join();
        const first = digest();
        let frames = 0;
        const step = () => {
          if (++frames < 30) requestAnimationFrame(step);
          else resolve([first, digest()]);
        };
        requestAnimationFrame(step);
      }),
  );
  expect(last).toBe(first);
  await evidence(page, "reduced-motion");
});

/** How far each crew canvas is from one backing pixel per device pixel: 0 is sharp. */
function ringBlur(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-crew-layer]")].map(
      (canvas) => canvas.width - Math.round(canvas.offsetWidth * devicePixelRatio),
    ),
  );
}

/**
 * Moving the window between its own display and one of another density, as
 * the page hears it: the device pixel ratio changes and the viewport, in CSS
 * pixels, does not. Chromium tells media queries about a device-metrics
 * override when one starts and when it is cleared, not when a second
 * replaces the first, so the way back to the window's own display clears it.
 */
async function displays(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const own = await page.evaluate(() => devicePixelRatio);
  const moveTo = async (ratio: number) => {
    if (ratio === own) await cdp.send("Emulation.clearDeviceMetricsOverride");
    else
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 0,
        height: 0,
        deviceScaleFactor: ratio,
        mobile: false,
      });
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(ratio);
  };
  return { own, moveTo };
}

test("under reduced motion a move to another display redraws the still ring sharp", async () => {
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await commissionIdleCrew(page, "write a sharp note");
  await expect.poll(async () => (await paint(page)).count, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(await ringBlur(page)).toEqual([0, 0]);
  const height = await page.evaluate(() => innerHeight);
  const display = await displays(page);
  const sharper = display.own * 2;

  // A display twice as sharp: one canvas pixel per screen pixel again, drawn.
  await display.moveTo(sharper);
  await expect.poll(() => ringBlur(page)).toEqual([0, 0]);
  const first = await paint(page);
  expect(first.count).toBeGreaterThan(0);
  await evidence(page, "sharper-display");

  // Back on the window's own display, and sharp again.
  await display.moveTo(display.own);
  await expect.poll(() => ringBlur(page)).toEqual([0, 0]);
  expect((await paint(page)).count).toBeGreaterThan(0);

  // The redraws moved nothing: the sharper display once more shows the very
  // picture the first visit drew, so the ring's slow turn did not jump on.
  await display.moveTo(sharper);
  await expect.poll(async () => (await paint(page)).digest).toBe(first.digest);
  // The window's height never changed, so the ring's height-driven restart never ran.
  expect(await page.evaluate(() => innerHeight)).toBe(height);
});
