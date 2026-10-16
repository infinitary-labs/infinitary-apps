import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";
import { expectClearOf } from "./layout";

// Synthetic boxes exercise the helper's promise, not a product layout.
test("the layout invariant accepts any clear side and refuses overlap, escape and a missing control", async () => {
  const launched = await launchApp();
  try {
    const { page } = launched;
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
    const move = (left: number, top: number) =>
      surface.evaluate(
        (element, at) => {
          (element as HTMLElement).style.left = `${at.left}px`;
          (element as HTMLElement).style.top = `${at.top}px`;
        },
        { left, top },
      );
    for (const [left, top] of [
      [100, 200],
      [300, 200],
      [200, 100],
      [200, 300],
    ] as const) {
      await move(left, top);
      await expectClearOf(page, surface, control);
      console.log("Layout invariant accepts clear placement:", { left, top });
    }
    await move(200, 200);
    await expect(expectClearOf(page, surface, control)).rejects.toThrow(/covers control 0/);
    console.log("Layout invariant refuses a surface covering its control");
    await move(-20, 200);
    await expect(expectClearOf(page, surface, control)).rejects.toThrow(/left by/);
    console.log("Layout invariant refuses a surface outside the window");
    await move(100, 200);
    await control.evaluate((element) => element.remove());
    await expect(expectClearOf(page, surface, control)).rejects.toThrow(/control 0 missing/);
    console.log("Layout invariant refuses a missing control");
  } finally {
    await launched.close();
  }
});
