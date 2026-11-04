import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp } from "../e2e/launch";

// INF-815: the agent's-reach journey pressed Show earlier right after Enter
// opened the record's Activity, and missed it: the shared reveal transitioned
// content-visibility, so an opening body stayed hidden until its fade drew a
// first frame. State and controls never wait for animation (docs/renderer.md,
// "In-place reveals"). This exercises the real reveal stylesheet on the
// record's own template, opening More and focusing inside it in one task,
// before any frame can draw.
const styles = ["tokens/effects.css", "tokens/spacing.css", "reveals.css"]
  .map((file) =>
    readFileSync(`src/renderer/src/design/${file}`, "utf8").replace(/^@import .*;$/gm, ""),
  )
  .join("\n");

test("an opened section's controls take focus before its fade draws a frame", async () => {
  const launched = await launchApp();
  const { page } = launched;
  try {
    // Replace the isolated window's app document with the record's template.
    await page.goto("about:blank");
    await page.setContent(
      readFileSync("src/renderer/src/plugins/builtin/record/record.html", "utf8"),
    );
    await page.addStyleTag({ content: styles });
    // The record painter shows the Info tab's More row and, once the work
    // declared any, Knowledge used inside it. Activity is its own tab now
    // (INF-2261), so More is the record's section that opens in place.
    await page
      .locator(
        '[data-record-content], [data-record-section="details"], [data-record-section="knowledge"]',
      )
      .evaluateAll((nodes) => {
        for (const node of nodes) (node as HTMLElement).hidden = false;
      });
    const opened = await page
      .locator('[data-record-section="details"] > summary')
      .evaluate((summary) => {
        const more = summary.parentElement as HTMLDetailsElement;
        const body = () => getComputedStyle(more, "::details-content");
        // The closed body's style is what the opening transitions from.
        body().opacity;
        (summary as HTMLElement).click();
        const inner = more.querySelector<HTMLElement>(
          '[data-record-section="knowledge"] > summary',
        );
        inner?.focus();
        return {
          open: more.open,
          focused: inner !== null && document.activeElement === inner,
          fadesFrom: body().opacity,
        };
      });
    // Focus lands while the fade is still at its start.
    expect(opened).toEqual({ open: true, focused: true, fadesFrom: "0" });
  } finally {
    await launched.close();
  }
});
