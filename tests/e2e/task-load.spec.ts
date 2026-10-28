import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { HERE } from "../../src/shared/deviceNames";
import { loadRunWords } from "../../src/shared/load";
import { TASK_USE_UNAVAILABLE } from "../../src/shared/resources";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, expectRecordBody, pressRow, recordCard, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import {
  LOAD_RUN_DEMAND,
  LOAD_RUN_MARKER,
  LOAD_RUN_READY,
  LOAD_RUN_RELEASE,
  loadRun,
} from "./scenarios/loadRun";

/**
 * INF-1621 piece 2: a task shows its declared wait separately from measured Use,
 * then the actual wrapped program starts when fresh readings return and releases on exit.
 * Fixture: the real channel, native wrapper and a disposable Node program; the native
 * memory read deliberately fails, then the real adapter is restored (no invented reading).
 * Signal: actual load-view facts, task-record words, the program's ready file and group release.
 * Prerequisites: hermetic Electron on macOS/Linux, Bash and the native process reader.
 * Shared resources: none; the app's disposable data/HOME, keys and working folder only.
 */
test("a declared run waits visibly, starts after readings recover, and releases on natural exit", async () => {
  const app = await launchApp({ scenarios: [loadRun], withMockProvider: true });
  let work: string | undefined;
  try {
    const { page } = app;
    await app.app.evaluate(() => {
      (
        globalThis as typeof globalThis & { loadFixtureMemory?: typeof process.getSystemMemoryInfo }
      ).loadFixtureMemory = process.getSystemMemoryInfo;
      process.getSystemMemoryInfo = () => {
        throw new Error("Isolated unavailable load reading");
      };
    });
    await expect
      .poll(async () => {
        const view = await page.evaluate(() =>
          window.infinitary.plugins.read("computers.resources", {}),
        );
        return view.computers.find((computer) => computer.computerId === null)?.reading.status;
      })
      .toBe("unknown");
    await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${LOAD_RUN_MARKER}`);
    await promptInput(page).press("Enter");
    const key = await taskKey(page, LOAD_RUN_MARKER);
    const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (task) => task.key === key,
    );
    if (!task) throw new Error("Missing declared-run task");
    const ownRun = async () => {
      const view = await page.evaluate(() =>
        window.infinitary.plugins.read("computers.resources", {}),
      );
      return view.computers
        .find((computer) => computer.computerId === null)
        ?.load?.runs.find((run) => run.taskId === task.id);
    };
    await expect.poll(async () => (await ownRun())?.state).toBe("waiting");
    work = readSavedData(
      app.userDataDir,
      (db) =>
        (
          db.prepare("SELECT worktree_dir AS dir FROM tasks WHERE id = ?").get(task.id) as {
            dir: string;
          }
        ).dir,
    );
    if (!work) throw new Error("The load command has no prepared working folder");
    expect(existsSync(join(work, LOAD_RUN_READY))).toBe(false);
    const waiting = await ownRun();
    expect(waiting).toMatchObject({
      state: "waiting",
      reason: "unavailable",
      demand: LOAD_RUN_DEMAND,
    });
    if (!waiting) throw new Error("Missing waiting declaration");
    await expandDock(page, "now");
    await pressRow(page, key);
    await expectRecordBody(page);
    const row = recordCard(page).locator("[data-task-load]");
    await expect(row).toHaveText(loadRunWords(waiting, HERE.this));
    await expect(recordCard(page).locator("[data-task-resource-use]")).toHaveText(
      TASK_USE_UNAVAILABLE,
    );
    await app.app.evaluate(() => {
      const original = (
        globalThis as typeof globalThis & { loadFixtureMemory?: typeof process.getSystemMemoryInfo }
      ).loadFixtureMemory;
      if (!original) throw new Error("Missing native memory reader");
      process.getSystemMemoryInfo = original;
    });
    await expect.poll(() => existsSync(join(work as string, LOAD_RUN_READY))).toBe(true);
    await expect.poll(async () => (await ownRun())?.state).toBe("running");
    const running = await ownRun();
    if (!running) throw new Error("Missing running declaration");
    await expect(row).toHaveText(loadRunWords(running, HERE.this));
    await expect(recordCard(page).locator("[data-task-resource-use]")).toContainText("resident");
    writeFileSync(join(work, LOAD_RUN_RELEASE), "done");
    work = undefined;
    await expect.poll(ownRun).toBeUndefined();
    await expect(row).toHaveCount(0);
  } finally {
    if (work) writeFileSync(join(work, LOAD_RUN_RELEASE), "done");
    await app.close();
  }
});
