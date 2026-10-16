import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp } from "../e2e/launch";

// Exercise panel sizing in the real Chromium cascade, not copied CSS math.
const styles = ["tokens/spacing.css", "styles.css"]
  .map((file) =>
    readFileSync(`src/renderer/src/design/${file}`, "utf8").replace(/^@import .*;$/gm, ""),
  )
  .join("\n");

for (const side of ["left", "right"]) {
  test(`${side} rail: overflowing content leaves collapsed headers whole`, async () => {
    const launched = await launchApp();
    const { page } = launched;
    try {
      await page.goto("about:blank");
      // SidePanelChrome's column/clip and nonshrinking header, with the
      // PanelMount body scroller around a content-sized frame.
      await page.setContent(`<div data-rail="${side}" style="height: 800px">
        <section data-side-panel="expanded" data-side-panel-size="content" data-side-panel-placement-y="bottom"
          style="overflow: hidden; display: flex; flex-direction: column">
          <header style="height: 40px; flex-shrink: 0"></header>
          <div data-side-panel-body style="min-height: 0; overflow-y: auto"><div style="height: 2547px"></div></div>
        </section>
        <section data-side-panel="collapsed" data-side-panel-size="content" data-side-panel-placement-y="bottom"
          data-side-panel-collapsed="" style="overflow: hidden; display: flex; flex-direction: column">
          <header style="height: 40px; flex-shrink: 0"></header>
        </section>
      </div>`);
      await page.addStyleTag({ content: styles });
      // Tasks/Knowledge, the mirror ordering, and collapsed fill panels all
      // share the same sizing contract on either rail.
      for (const size of ["content", "fill"]) {
        for (const order of ["below", "above"]) {
          await page.locator("[data-rail]").evaluate(
            (rail, { size, order }) => {
              const collapsed = rail.querySelector<HTMLElement>('[data-side-panel="collapsed"]');
              if (!collapsed) throw new Error("Missing collapsed fixture panel");
              collapsed.dataset.sidePanelSize = size;
              if (order === "above") rail.prepend(collapsed);
              else rail.append(collapsed);
            },
            { size, order },
          );
          const geometry = await page.locator("[data-rail]").evaluate((rail) => {
            const panels = [...rail.querySelectorAll<HTMLElement>("[data-side-panel]")];
            const collapsed = rail.querySelector('[data-side-panel="collapsed"]');
            const body = rail.querySelector<HTMLElement>("[data-side-panel-body]");
            if (!collapsed || !body) throw new Error("Missing fixture content");
            const boxes = panels.map((panel) => panel.getBoundingClientRect());
            const style = getComputedStyle(rail);
            return {
              collapsedHeight: collapsed.getBoundingClientRect().height,
              gap: (boxes[1]?.top ?? 0) - (boxes[0]?.bottom ?? 0),
              rowGap: Number.parseFloat(style.rowGap),
              end: boxes.at(-1)?.bottom,
              railEnd: rail.getBoundingClientRect().bottom - Number.parseFloat(style.paddingBottom),
              bodyHeight: body.clientHeight,
              contentHeight: body.scrollHeight,
            };
          });
          console.log("RAIL_GEOMETRY", side, size, order, JSON.stringify(geometry));
          const state = `${size}, ${order}`;
          expect
            .soft(geometry.collapsedHeight, `collapsed header keeps its height: ${state}`)
            .toBe(40);
          expect
            .soft(geometry.end, `bottom group stays at the rail end: ${state}`)
            .toBe(geometry.railEnd);
          expect
            .soft(geometry.gap, `expanded panel takes only the room left: ${state}`)
            .toBe(geometry.rowGap);
          expect
            .soft(geometry.bodyHeight, `expanded body can scroll: ${state}`)
            .toBeLessThan(geometry.contentHeight);
        }
      }
    } finally {
      await launched.close();
    }
  });
}
