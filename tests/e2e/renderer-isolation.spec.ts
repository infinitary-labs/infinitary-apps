import { expect, type Page } from "@playwright/test";
import { rendererTest as test } from "./renderer";

async function origin(page: Page) {
  await page.route("http://renderer.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Isolated renderer</p>" }),
  );
  await page.goto("http://renderer.test/");
}

test.describe("renderer fixture isolation", () => {
  test.describe.configure({ mode: "serial" });
  let pid: number | undefined;

  // Each page writes, and each finds nothing an earlier page wrote: run
  // together they share one Chromium, run alone each still holds.
  for (const run of ["first", "second"]) {
    test(`the ${run} page sees no earlier page's storage or cookies, and no Node or preload bridge`, async ({
      page,
      rendererApp,
    }) => {
      if (pid !== undefined) expect(rendererApp.process().pid).toBe(pid);
      pid = rendererApp.process().pid;
      await origin(page);
      expect(await page.evaluate(() => localStorage.getItem("fixture-private"))).toBeNull();
      expect(await page.evaluate(() => document.cookie)).toBe("");
      await page.evaluate((value) => {
        localStorage.setItem("fixture-private", value);
        // biome-ignore lint/suspicious/noDocumentCookie: exercise ordinary browser cookie isolation.
        document.cookie = `fixture_private=${value}`;
      }, run);
      expect(await page.evaluate(() => localStorage.getItem("fixture-private"))).toBe(run);
      expect(
        await page.evaluate(
          () => "firstmate" in window || "require" in window || "process" in window,
        ),
      ).toBe(false);
    });
  }
});
