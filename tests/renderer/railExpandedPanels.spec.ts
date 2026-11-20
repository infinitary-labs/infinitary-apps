import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp } from "../e2e/launch";

// INF-178, the captain: "the automation panel should have docked at the
// bottom but it got pushed out of the viewport". Two expanded panels in a
// rail that overflows must share the room so a short panel keeps its whole
// content and a long one scrolls. Heights are the hermetic app's own
// readings: a 40-task Tasks board (1494px frame) beside Automation (61px).
const styles = ["tokens/spacing.css", "styles.css"]
  .map((file) =>
    readFileSync(`src/renderer/src/design/${file}`, "utf8").replace(/^@import .*;$/gm, ""),
  )
  .join("\n");

const panel = (name: string, frame: number, collapsed = false) => `
  <section data-side-panel="${name}" data-side-panel-size="content" data-side-panel-placement-y="bottom"
    ${collapsed ? 'data-side-panel-collapsed=""' : ""}
    style="overflow: hidden; display: flex; flex-direction: column">
    <header style="height: 40px; flex-shrink: 0"></header>
    ${
      collapsed
        ? ""
        : `<div data-side-panel-body style="min-height: 0; overflow-y: auto; padding: 8px 0"><div style="height: ${frame}px"></div></div>`
    }
  </section>`;

for (const side of ["left", "right"]) {
  test(`${side} rail: a short expanded panel keeps its content beside a long one`, async () => {
    const launched = await launchApp();
    const { page } = launched;
    try {
      await page.goto("about:blank");
      await page.setContent(`<div data-rail="${side}" style="height: 820px">
        ${panel("tasks", 1494)}${panel("knowledge", 0, true)}${panel("automation", 61)}
      </div>`);
      await page.addStyleTag({ content: styles });
      const geometry = await page.locator("[data-rail]").evaluate((rail) => {
        const style = getComputedStyle(rail);
        const body = (name: string) =>
          rail.querySelector<HTMLElement>(`[data-side-panel="${name}"] [data-side-panel-body]`);
        const automation = body("automation");
        const tasks = body("tasks");
        if (!automation || !tasks) throw new Error("missing fixture panel");
        return {
          automationShown: automation.clientHeight,
          automationContent: automation.scrollHeight,
          tasksShown: tasks.clientHeight,
          tasksContent: tasks.scrollHeight,
          end: rail.querySelector('[data-side-panel="automation"]')?.getBoundingClientRect().bottom,
          railEnd: rail.getBoundingClientRect().bottom - Number.parseFloat(style.paddingBottom),
        };
      });
      expect(geometry.automationShown, "Automation shows all of its rows").toBe(
        geometry.automationContent,
      );
      expect(geometry.tasksShown, "Tasks scrolls inside what is left").toBeLessThan(
        geometry.tasksContent,
      );
      expect(geometry.end, "Automation stays docked at the rail end").toBe(geometry.railEnd);
    } finally {
      await launched.close();
    }
  });
}
