import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { expandDock, nowFrame, nowRow, recordBarButton, recordCard } from "./rails";
import { focusOn, pressKey, untilFocused } from "./windowKeys";

// One journey owns its dropped work and the outstanding wait it restores.
test("keyboard Start again replaces dropped work, moves its wait and leaves the old record closed", async () => {
  const userDataDir = scratchDir("infinitary-start-again-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const old = seedTask(tasks, {
    id: "dropped-chart",
    title: "Finish the harbour chart",
    status: "cancelled",
    intent: { goal: "The harbour chart is ready to share.", userWords: "finish the harbour chart" },
  });
  tasks.markWorkspaceRemoved(old.id);
  const waiter = seedTask(tasks, {
    id: "share-chart",
    title: "Share the chart",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.link(old.id, waiter.id, "blocks", "host");
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await expandDock(page, "now");
    await expect(nowFrame(page).locator('[data-now-group="backlog"]')).toBeVisible();
    const search = page
      .locator('[data-side-panel="now"]')
      .getByRole("button", { name: "Search tasks" });
    await pressKey(search, "Enter");
    await nowFrame(page).locator("[data-now-query]").fill(old.key);
    const row = nowRow(page, old.key);
    await focusOn(row);
    await untilFocused(row);
    await page.keyboard.press("Enter");
    await expect(recordCard(page)).toHaveAttribute("data-task-record", old.id);
    // Tab reaches the new control without needing focus inside its body frame.
    await focusOn(recordCard(page).getByRole("button", { name: "Hide", exact: true }));
    const next = recordBarButton(page, "next");
    for (let count = 0; count < 12; count++) {
      await page.keyboard.press("Tab");
      if (await next.evaluate((element) => element === document.activeElement)) break;
    }
    await expect(next).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(recordCard(page)).toHaveCount(0);
    const readOld = () => page.evaluate((id) => window.infinitary.tasks.detail(id), old.id);
    await expect.poll(async () => (await readOld()).replacedBy).toBeTruthy();
    const dropped = await readOld();
    expect(dropped.status).toBe("dropped");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const freshId = board.links.find(
      (link) => link.fromId === old.id && link.type === "replaced-by",
    )?.toId;
    if (!freshId) throw new Error("No replacement task");
    const readFresh = () => page.evaluate((id) => window.infinitary.tasks.detail(id), freshId);
    await expect.poll(async () => (await readFresh()).status).toBe("active");
    const fresh = await readFresh();
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.goal).toBe(old.goal);
    const waiting = await page.evaluate((id) => window.infinitary.tasks.detail(id), waiter.id);
    expect(waiting.blockedBy).toContain(fresh.key);
    expect(waiting.blockedBy).not.toContain(old.key);
    expect(dropped.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "captain",
          data: expect.objectContaining({ via: "task-card", startAgain: fresh.key }),
        }),
      ]),
    );
    // A stale second activation refuses without another task or history event.
    const before = dropped.events;
    const refused = await page.evaluate(
      (id) => window.infinitary.task.run(id, "start-again"),
      old.id,
    );
    expect(refused.ok).toBe(false);
    expect((await readOld()).events).toEqual(before);
    console.info(
      "Start again persisted result",
      JSON.stringify({
        predecessor: { key: dropped.key, status: dropped.status, replacedBy: dropped.replacedBy },
        replacement: { key: fresh.key, status: fresh.status, goal: fresh.goal },
        waiter: { key: waiting.key, blockedBy: waiting.blockedBy },
        duplicateRefusal: refused,
        historyUnchangedAfterRefusal: true,
      }),
    );
    await test.info().attach("replacement-and-wait", {
      body: JSON.stringify({ dropped, fresh, waiting, refused }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
