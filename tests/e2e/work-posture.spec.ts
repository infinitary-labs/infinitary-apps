import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, expectTaskMark, nowRow, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import {
  backgroundPosture,
  WORK_POSTURE_MARKER,
  WORK_POSTURE_QUIET_MARKER,
} from "./scenarios/backgroundPosture";

test("a background job keeps both indicators active alongside a question; its exit and restart become captain-held idle", async () => {
  let app = await launchApp({ scenarios: [backgroundPosture], withMockProvider: true });
  try {
    const { page } = app;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${WORK_POSTURE_MARKER}`);
    await input.press("Enter");
    const key = await taskKey(page, WORK_POSTURE_MARKER);
    const posture = () =>
      page.evaluate(
        async (key) => (await window.infinitary.tasks.board()).tasks.find((t) => t.key === key),
        key,
      );
    await expect.poll(async () => (await posture())?.activity, { timeout: 30_000 }).toBe("idle");
    await expect
      .poll(async () => (await posture())?.workPosture)
      .toEqual({ state: "active", reason: "job" });
    await expectTaskMark(page, key);
    await expect(page.locator('canvas[data-crew-layer="near"]')).toHaveAttribute(
      "aria-label",
      /1 working.*0 idle/,
    );
    const task = await posture();
    if (!task) throw new Error("missing task");
    expect(task.flags.needsYou).toBe(true);
    await expandDock(page, "activity");
    await expect(page.locator("[data-thread-working]")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("work-posture-background.png") });
    const worktreeDir = readSavedData(
      app.userDataDir,
      (db) =>
        (
          db.prepare("SELECT worktree_dir AS dir FROM tasks WHERE id = ?").get(task.id) as {
            dir: string;
          }
        ).dir,
    );
    writeFileSync(join(worktreeDir, ".posture-release"), "done");
    await expect
      .poll(async () => (await posture())?.workPosture)
      .toEqual({ state: "idle", reason: "captain" });
    await expectTaskMark(page, key);
    await expect(page.locator('canvas[data-crew-layer="near"]')).toHaveAttribute(
      "aria-label",
      /0 working.*1 idle/,
    );
    await page.screenshot({ path: test.info().outputPath("work-posture-captain.png") });
    const userDataDir = app.userDataDir;
    await app.close();
    app = await launchApp({ scenarios: [backgroundPosture], userDataDir, withMockProvider: true });
    await expectTaskMark(app.page, key);
    await expect(app.page.locator('canvas[data-crew-layer="near"]')).toHaveAttribute(
      "aria-label",
      /0 working.*1 idle/,
    );
    expect(
      (await app.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (t) => t.key === key,
      )?.workPosture,
    ).toEqual({ state: "idle", reason: "captain" });
  } finally {
    await app.close();
  }
});

test("both visible indicators stay hot for a background job and cool when no work continues", async () => {
  const app = await launchApp({ scenarios: [backgroundPosture], withMockProvider: true });
  try {
    const { page } = app;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${WORK_POSTURE_MARKER} ${WORK_POSTURE_QUIET_MARKER}`);
    await input.press("Enter");
    const key = await taskKey(page, `${WORK_POSTURE_MARKER} ${WORK_POSTURE_QUIET_MARKER}`);
    const task = () =>
      page.evaluate(
        async (key) => (await window.infinitary.tasks.board()).tasks.find((t) => t.key === key),
        key,
      );
    await expect.poll(async () => (await task())?.activity, { timeout: 30_000 }).toBe("idle");
    await expect
      .poll(async () => (await task())?.workPosture)
      .toEqual({ state: "active", reason: "job" });
    await expectTaskMark(page, key);
    await expect(page.locator('canvas[data-crew-layer="near"]')).toHaveAttribute(
      "aria-label",
      /1 working.*0 idle/,
    );
    await expandDock(page, "activity");
    await waitForFirstmateIdle(page, 5_000);
    await page.screenshot({ path: test.info().outputPath("work-posture-active-orbit.png") });
    const row = await task();
    if (!row) throw new Error("missing task");
    const worktreeDir = readSavedData(
      app.userDataDir,
      (db) =>
        (
          db.prepare("SELECT worktree_dir AS dir FROM tasks WHERE id = ?").get(row.id) as {
            dir: string;
          }
        ).dir,
    );
    writeFileSync(join(worktreeDir, ".posture-release"), "done");
    await expect
      .poll(async () => (await task())?.workPosture)
      .toEqual({ state: "idle", reason: "inactive" });
    await expectTaskMark(page, key);
    await expect(page.locator('canvas[data-crew-layer="near"]')).toHaveAttribute(
      "aria-label",
      /0 working.*1 idle/,
    );
    await waitForFirstmateIdle(page, 5_000);
    // A collapsed dock's frame never paints, so the frame wait below needs Tasks shown.
    await expandDock(page, "now");
    await nowRow(page, key)
      .locator("[data-now-dot]")
      .evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
    await page.screenshot({ path: test.info().outputPath("work-posture-idle-orbit.png") });
  } finally {
    await app.close();
  }
});
