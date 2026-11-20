import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow, slidePointer, within } from "./layout";
import { expandDock, nowFrame, nowRowGroup, openGroup } from "./rails";
import { focusOn, pressKey } from "./windowKeys";

/**
 * INF-1951: the captain wants to hover and Start consecutive backlog rows
 * without the Tasks panel pulling the started task's new group into view.
 * Data: the reproduction's 60 on-request tasks and isolated mock provider.
 * Completion: two pointer starts reach Working, leave the next row visible
 * and retain the scroll; a keyboard start still reveals its focused row.
 * Needs Electron's routed pointer, not a real account or shared resources.
 */
function seeded(): string {
  const userDataDir = scratchDir("infinitary-now-start-scroll-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const subjects = [
    "Review the deployment checklist",
    "Check the backup recovery guide",
    "Document the release process",
    "Review the setup instructions",
    "Check the error messages",
    "Update the support guide",
  ];
  const at = Date.now() - 120_000;
  for (let n = 1; n <= 60; n++) {
    const subject = subjects[(n - 1) % subjects.length] as string;
    seedTask(tasks, {
      id: `scroll-${n}`,
      title: `${subject} ${n}`,
      intent: { goal: subject, userWords: subject },
      startPolicy: "on-request",
      status: "queued",
      createdAt: at + n * 1_000,
    });
  }
  db.close();
  return userDataDir;
}

test("sequential pointer Starts keep the backlog in view; keyboard Start reveals its task", async () => {
  test.setTimeout(180_000);
  const launched = await launchApp({
    userDataDir: seeded(),
    withMockProvider: true,
    gpuBenchmarking: true,
  });
  const { app, page } = launched;
  try {
    await resizeWindow(app, page, { width: 1280, height: 800 });
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const key = (id: string) => board.tasks.find((task) => task.id === id)?.key as string;
    const frame = nowFrame(page);
    const scroller = page.locator('[data-side-panel="now"] [data-side-panel-body]');
    const row = (n: number) => frame.locator(`[data-now-row="scroll-${n}"]`);
    const start = (n: number) => frame.locator(`[data-now-start="scroll-${n}"]`);
    // INF-2395: record the actual dispatch behind each group transition,
    // not just the drawing that previously remained queued after Start.
    const started = async (n: number) => {
      const task = await page.evaluate((id) => window.infinitary.tasks.detail(id), `scroll-${n}`);
      expect(task.status).toBe("active");
      expect(task.events.filter((event) => event.kind === "dispatched")).toHaveLength(1);
      return { id: task.id, status: task.status, group: await nowRowGroup(page, key(task.id)) };
    };
    const visible = async (n: number) => {
      const bounds = await row(n).boundingBox();
      const viewport = await scroller.boundingBox();
      expect(bounds).not.toBeNull();
      expect(viewport).not.toBeNull();
      if (!bounds || !viewport) throw new Error("Missing task or panel");
      expect(within(bounds, viewport)).toEqual([]);
    };
    // Scroll once, then move straight to the next row, without any helper
    // scrolling the panel after Start (visibility is measured, not attachment).
    await start(35).evaluate((el) => el.scrollIntoView({ block: "center" }));
    for (const n of [35, 36]) {
      await visible(n);
      const box = await row(n).boundingBox();
      if (!box) throw new Error("Missing task");
      await slidePointer(page, { x: 900, y: box.y + 10 }, { x: box.x + 40, y: box.y + 10 }, 12);
      await expect(start(n)).toHaveCSS("opacity", "1");
      const before = await scroller.evaluate((el) => el.scrollTop);
      expect(before).toBeGreaterThan(0);
      // As in now-row-start: Chromium's hidden Linux window can route
      // the hover but lose the native frame click. Focus and activate in
      // the frame, without letting a locator click scroll the target.
      await focusOn(start(n), { focusVisible: false, preventScroll: true });
      expect(await start(n).evaluate((button) => button.matches(":focus-visible"))).toBe(false);
      await start(n).evaluate((button) => (button as HTMLElement).click());
      await expect.poll(() => nowRowGroup(page, key(`scroll-${n}`))).toBe("working");
      await expect(row(n)).toBeFocused();
      await visible(n + 1);
      const after = await scroller.evaluate((el) => el.scrollTop);
      expect(after).toBe(before);
      console.log("[pointer Start]", { ...(await started(n)), before, after, nextVisible: n + 1 });
    }
    // The same long-list handoff by keyboard must still reveal its new stop.
    await focusOn(row(37));
    await pressKey(row(37), "ArrowRight");
    await expect(start(37)).toBeFocused();
    await pressKey(start(37), "Enter");
    await expect.poll(() => nowRowGroup(page, key("scroll-37"))).toBe("working");
    await expect(row(37)).toBeFocused();
    await visible(37);
    console.log("[keyboard Start]", { ...(await started(37)), focusedAndVisible: true });
  } finally {
    await launched.close();
  }
});
