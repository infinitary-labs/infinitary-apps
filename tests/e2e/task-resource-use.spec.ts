import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  TASK_USE_EMPTY,
  TASK_USE_UNAVAILABLE,
  taskResourceWords,
} from "../../src/shared/resources";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, pressRow, recordCard, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import {
  RESOURCE_USE_MARKER,
  RESOURCE_USE_READY,
  RESOURCE_USE_RELEASE,
  resourceUse,
} from "./scenarios/resourceUse";

/**
 * INF-1621 piece 1: a background job's share is visible on its task, even after the model turn ends.
 * Fixture: a real disposable Node job holds resident bytes until its release file arrives.
 * Signal: the record shows the shared observation's words; after natural exit it shows no attributed processes.
 * Prerequisites: the hermetic desktop launcher on macOS/Linux. No accounts, sign-in or shared external resource.
 */
test("a task record shows its real background process share and clears it after natural exit", async () => {
  const app = await launchApp({ scenarios: [resourceUse], withMockProvider: true });
  let work: string | undefined;
  try {
    const { page } = app;
    const input = promptInput(page);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${RESOURCE_USE_MARKER}`);
    await input.press("Enter");
    const key = await taskKey(page, RESOURCE_USE_MARKER);
    const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (task) => task.key === key,
    );
    if (!task) throw new Error("Missing resource-use task");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
            (row) => row.id === task.id,
          )?.workPosture,
      )
      .toEqual({ state: "active", reason: "job" });
    work = readSavedData(
      app.userDataDir,
      (db) =>
        (
          db.prepare("SELECT worktree_dir AS dir FROM tasks WHERE id = ?").get(task.id) as {
            dir: string;
          }
        ).dir,
    );
    if (!work) throw new Error("The running task has no prepared working folder");
    await expect.poll(() => existsSync(join(work as string, RESOURCE_USE_READY))).toBe(true);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
            (row) => row.id === task.id,
          )?.activity,
      )
      .toBe("idle");
    await expandDock(page, "now");
    await pressRow(page, key);
    const row = recordCard(page).locator("[data-task-resource-use]");
    await expect
      .poll(async () => {
        const view = await page.evaluate(() =>
          window.infinitary.plugins.read("computers.resources", {}),
        );
        for (const computer of view.computers) {
          const reading = computer.reading;
          if (reading.status !== "fresh" || reading.observation.processes?.status !== "sampled")
            continue;
          const share = reading.observation.processes.tasks.find(
            (share) => share.taskId === task.id,
          );
          if (share && share.residentBytes > 0)
            return (await row.textContent()) === `${computer.label} · ${taskResourceWords(share)}`;
        }
        return false;
      })
      .toBe(true);
    writeFileSync(join(work, RESOURCE_USE_RELEASE), "done");
    work = undefined;
    await expect(row).toHaveText(TASK_USE_EMPTY);
    // A failed native memory read travels through the real sampler/receiver, never a fake UI value.
    await app.app.evaluate(() => {
      process.getSystemMemoryInfo = () => {
        throw new Error("Isolated unavailable resource read");
      };
    });
    await expect(row).toHaveText(TASK_USE_UNAVAILABLE);
  } finally {
    if (work) writeFileSync(join(work, RESOURCE_USE_RELEASE), "done");
    await app.close();
  }
});
