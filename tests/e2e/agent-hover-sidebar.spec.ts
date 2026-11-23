import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { agentHoverFixture, HOVER_PROJECT_NAME } from "./agentHoverFixture";
import { nextFrame } from "./crew";
import { launchApp } from "./launch";
import { clearOfLosses, resizeWindow } from "./layout";
import { movePanelTo } from "./panelLayout";
import { heroShot, windowShot } from "./pictures";
import { expandDock, nowFrame } from "./rails";

/** Issue #44: a real fleet hover must clear sidebar content, even when none
 * of its four preferred positions fits. Fleet paint behind the rails is
 * intentional; a Tasks-row preview is not the summary this test reads.
 * The shell is required because sidebar bodies use the app's frame scheme.
 */
const summarySelector = "[data-crew-target] ~ div [data-crew-summary]";

async function stageAnchors(page: Page) {
  return page.locator("[data-crew-model-anchor][data-painted]").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const { x, y } = element.getBoundingClientRect();
      // The name attaches just above its glyph; this point is inside the
      // glyph's minimum hit radius, without relying on canvas pixel colors.
      const point = { x, y: y + 6 };
      if (point.x <= 0 || point.x >= innerWidth || point.y <= 0 || point.y >= innerHeight)
        return [];
      if (document.elementFromPoint(point.x, point.y)?.closest("[data-rail]")) return [];
      return [point];
    }),
  );
}

test("fleet agent hover clears both sidebars in narrow and wide windows", async () => {
  const fixture = agentHoverFixture(
    "Keep keyboard focus on the selected result when a background refresh updates the task board",
  );
  const launched = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page, app } = launched;
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await resizeWindow(app, page, { width: 1024, height: 800 });
    const batches = page.locator('[data-side-panel="batches-panel"]');
    await expect(batches).toBeVisible();
    if ((await batches.getAttribute("data-side-panel-collapsed")) !== null)
      await batches.getByRole("button", { name: "Expand Batches" }).click();
    await expandDock(page, "now");
    await expandDock(page, "activity");
    await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible();
    await expect(page.locator('[data-computer-cluster="worker-one"]')).toHaveText("Worker one");
    await expect(page.locator('[data-computer-cluster="worker-two"]')).toHaveText("Worker two");
    await expect(page.locator("[data-card-stack-open]")).toHaveCount(0);

    for (const side of ["right", "left"] as const) {
      await movePanelTo(page, "activity", { x: side === "right" ? "left" : "right", y: "top" });
      if (side === "right") await movePanelTo(page, "batches-panel", { x: "right", y: "top" });
      await movePanelTo(page, "now", { x: side, y: "top" });
      for (const width of [960, 1024, 1200, 1440]) {
        await test.step(`${side} sidebar, ${width} pixels`, async () => {
          await page.mouse.move(20, 70);
          await resizeWindow(app, page, { width, height: 800 });
          await nextFrame(page);
          await expect(page.locator(`[data-rail="${side}"]`)).toBeVisible();
          const anchors = (await stageAnchors(page))
            .filter((point) => (side === "right" ? point.x > width / 2 : point.x < width / 2))
            .sort((a, b) => (side === "right" ? b.x - a.x : a.x - b.x))
            .slice(0, 5);
          expect(
            anchors.length,
            "The fleet has glyphs inside the stage near this sidebar",
          ).toBeGreaterThan(0);
          for (const [index, anchor] of anchors.entries()) {
            await page.mouse.move(20, 70);
            await expect(page.locator(summarySelector)).toHaveCount(0);
            await page.mouse.move(anchor.x, anchor.y);
            await expect(page.locator(summarySelector)).toBeVisible();
            // Read the real DOM after its task detail fills and placement paints.
            await expect(page.locator(summarySelector)).toContainText(HOVER_PROJECT_NAME);
            await nextFrame(page);
            if (index === 0 && process.env.HOVER_EVIDENCE) {
              await windowShot(
                page,
                join(
                  process.env.HOVER_EVIDENCE,
                  `${process.env.HOVER_REF ?? "hover"}-${side}-${width}.png`,
                ),
              );
              if (side === "left" && width === 960 && process.env.HOVER_HERO) {
                await heroShot(app, page, {
                  name: "fleet-hover-sidebar",
                  region: page.locator(summarySelector),
                  anchors: [page.locator("[data-crew-target]")],
                  ready: async () => {
                    await page.mouse.move(anchor.x, anchor.y);
                    await expect(page.locator(summarySelector)).toBeVisible();
                  },
                });
              }
            }
            expect(
              await clearOfLosses(
                page,
                page.locator(summarySelector),
                ...(await page
                  .locator("[data-rail] > [data-side-panel]:not([hidden])")
                  .filter({ visible: true })
                  .all()),
              ),
              "Fleet hover summary must not overlap visible sidebar panel content",
            ).toEqual([]);
          }
        });
      }
    }
  } finally {
    await launched.close();
  }
});
