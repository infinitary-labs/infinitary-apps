import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp } from "../e2e/launch";

// Exercise the real stylesheet cascade in Chromium, independently of panel
// content and host ordering. Pixel composition belongs here, not in a journey.
const styles = ["tokens/spacing.css", "styles.css"]
  .map((file) =>
    readFileSync(`src/renderer/src/design/${file}`, "utf8").replace(/^@import .*;$/gm, ""),
  )
  .join("\n");

for (const side of ["left", "right"]) {
  test(`${side} rail: only the first shown bottom panel consumes spare height`, async () => {
    const launched = await launchApp();
    const { page } = launched;
    try {
      // Replace the isolated window's app document with a stylesheet fixture.
      await page.goto("about:blank");
      await page.setContent(`<div data-rail="${side}" style="height: 800px">
        <section data-side-panel="top" data-side-panel-placement-y="top" style="height: 60px"></section>
        <section data-side-panel="first" data-side-panel-placement-y="bottom" style="height: 100px"></section>
        <section data-side-panel="second" data-side-panel-placement-y="bottom" style="height: 40px"></section>
        <section data-side-panel="third" data-side-panel-placement-y="bottom" style="height: 80px"></section>
      </div>`);
      await page.addStyleTag({ content: styles });
      // Expanded/collapsed content and a hidden first/middle panel all retain
      // one bottom group. A hidden sibling must not claim its docking margin.
      for (const state of ["collapsed", "expanded", "first-hidden", "middle-hidden"]) {
        await page.evaluate((state) => {
          const first = document.querySelector<HTMLElement>('[data-side-panel="first"]');
          const second = document.querySelector<HTMLElement>('[data-side-panel="second"]');
          if (!first || !second) throw new Error("missing fixture panel");
          first.hidden = state === "first-hidden";
          second.hidden = state === "middle-hidden";
          second.style.height = state === "expanded" ? "140px" : "40px";
        }, state);
        const geometry = await page.locator("[data-rail]").evaluate((rail) => {
          const style = getComputedStyle(rail);
          const panels = [
            ...rail.querySelectorAll<HTMLElement>('[data-side-panel-placement-y="bottom"]'),
          ]
            .filter((panel) => !panel.hidden)
            .map((panel) => panel.getBoundingClientRect());
          return {
            gaps: panels
              .slice(1)
              .map((box, index) => box.top - (panels[index]?.bottom ?? Number.NaN)),
            gap: Number.parseFloat(style.rowGap),
            end: panels.at(-1)?.bottom,
            railEnd: rail.getBoundingClientRect().bottom - Number.parseFloat(style.paddingBottom),
          };
        });
        expect.soft(geometry.gaps, state).toEqual(geometry.gaps.map(() => geometry.gap));
        expect.soft(geometry.end, state).toBe(geometry.railEnd);
      }
    } finally {
      await launched.close();
    }
  });
}
