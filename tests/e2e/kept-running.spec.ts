import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { KeptJobs } from "../../src/core/tasks/keptJobs";
import automationManifest from "../../src/panels/automation/manifest.json" with { type: "json" };
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { launchApp } from "./launch";
import { settingsSection } from "./settings";
import { focusOn, pressKey, pressKeyTakingFrame } from "./windowKeys";

/**
 * Kept running (docs/leftover-programs.md, "Kept running"), the captain's
 * approved plan on INF-4381, piece 2: "Settings → Automation and the
 * Automation panel list kept jobs under Kept running, by label, computer,
 * account and task. Check runs the check; Remove asks once, then runs the
 * remove on that computer and keeps a failure. ... Every control is reached
 * by keyboard, and one journey drives it by keys."
 *
 * - Promised result: with no automation saved, the Automation panel shows
 *   the two kept jobs; Enter on one opens Settings → Automation with the
 *   keyboard on its Check; Enter there shows it running; Tab and Enter on
 *   Remove ask once, and Enter on Remove for good runs its remove, which
 *   takes its file and kept folder and takes it off the list. A job whose
 *   remove fails stays listed with how it went; Remove there asks once,
 *   hiding Forget, and Escape or leaving it runs nothing; Forget beside it
 *   (the captain's choice on the review) takes it off the list, running
 *   nothing; and with no job left and no automation saved, the section and
 *   the panel go.
 * - Data: two jobs recorded through the core's own `KeptJobs` before the
 *   launch, as a merged close records them, each with a kept folder; the
 *   first's check reads its own file and its remove deletes it, the
 *   second's remove exits 3.
 * - Completion signal: the row's typed hooks (`data-kept-checked`,
 *   `data-kept-remove-failed`), the record read back through `KeptJobs`,
 *   and the kept folder gone from disk.
 * - Platform prerequisites: a POSIX shell for the jobs' commands.
 * - Shared resources: none; its own userData and HOME, and a stand-in
 *   name for this computer.
 */

const PANEL = "automation";
const BACKUP = "Nightly backup of the notes folder";
const STUCK = "Weekly photo sync";
/** This computer's name, as the launch names it, where both jobs run. */
const COMPUTER = "MacBook Pro";

function automationPanel(page: Page) {
  return page.locator(`[data-side-panel="${PANEL}"]`);
}

test("kept jobs are listed, checked and removed by keys, and a failed remove keeps its job", async () => {
  const userDataDir = scratchDir("infinitary-kept-running-");
  const kept = join(userDataDir, "kept");
  const backup = join(kept, "task-1-s1");
  const stuck = join(kept, "task-2-s1");
  mkdirSync(backup, { recursive: true });
  mkdirSync(stuck, { recursive: true });
  const marker = join(backup, "backup.timer");
  // e2e-fixture: input -- Author the job's own file its check reads and its remove deletes.
  writeFileSync(marker, "[Timer]\nOnCalendar=daily\n");
  const jobs = new KeptJobs(join(kept, "jobs.json"));
  jobs.record(
    [
      {
        id: "s1",
        label: BACKUP,
        check: `test -f "${marker}"`,
        remove: `rm "${marker}"`,
        folder: backup,
        account: "captain",
      },
    ],
    { computer: null, task: "task-1", key: "INF-7" },
  );
  jobs.record(
    [
      {
        id: "s1",
        label: STUCK,
        check: "true",
        remove: "exit 3",
        folder: stuck,
        account: "captain",
      },
    ],
    { computer: null, task: "task-2", key: "INF-8" },
  );

  const { page, close } = await launchApp({
    userDataDir,
    env: { INFINITARY_DEVICE_NAME: COMPUTER },
  });
  try {
    const panel = automationPanel(page);
    await test.step("with no automation saved, the panel shows the kept jobs", async () => {
      await expect(panel).toBeAttached({ timeout: 30_000 });
      await pressKey(
        panel.getByRole("button", { name: `Expand ${automationManifest.title}` }),
        "Enter",
      );
      await expect(panel).not.toHaveAttribute("data-side-panel-collapsed", "");
    });

    const body = panelBody(page, PANEL);
    const row = (id: string) => body.locator(`[data-automation-kept-job="${id}"] button`);
    await test.step("the kept rows are one stop the arrows move through", async () => {
      await focusOn(row("task-1-s1"));
      await pressKey(row("task-1-s1"), "ArrowDown");
      await expect(row("task-2-s1")).toBeFocused();
      await pressKey(row("task-2-s1"), "ArrowUp");
      await expect(row("task-1-s1")).toBeFocused();
    });

    const section = settingsSection(page, PANEL);
    const job = (id: string) => section.locator(`[data-kept-job="${id}"]`);
    await test.step("Enter on a row opens Settings → Automation with the keyboard on its Check", async () => {
      await pressKeyTakingFrame(row("task-1-s1"), "Enter");
      await expect(job("task-1-s1")).toContainText(BACKUP);
      await expect(job("task-1-s1")).toContainText(COMPUTER);
      await expect(job("task-1-s1")).toContainText("captain");
      await expect(job("task-1-s1")).toContainText("INF-7");
      await expect(job("task-1-s1").locator("[data-kept-check]")).toBeFocused();
    });

    await test.step("Enter on Check runs the job's check", async () => {
      await pressKey(job("task-1-s1").locator("[data-kept-check]"), "Enter");
      await expect(job("task-1-s1").locator("[data-kept-checked]")).toHaveAttribute(
        "data-kept-checked",
        "running",
      );
    });

    await test.step("Remove asks once, and Remove for good runs the remove", async () => {
      await pressKey(job("task-1-s1").locator("[data-kept-check]"), "Tab");
      await expect(job("task-1-s1").locator("[data-kept-remove]")).toBeFocused();
      await pressKey(job("task-1-s1").locator("[data-kept-remove]"), "Enter");
      const forGood = job("task-1-s1").locator("[data-kept-remove-for-good]");
      await expect(forGood).toBeFocused();
      expect(existsSync(marker)).toBe(true);
      await pressKey(forGood, "Enter");
      await expect(job("task-1-s1")).toHaveCount(0);
      expect(existsSync(backup)).toBe(false);
      expect(jobs.list().map((entry) => entry.label)).toEqual([STUCK]);
    });

    await test.step("a remove that fails keeps the job listed, with how it went", async () => {
      await pressKey(job("task-2-s1").locator("[data-kept-remove]"), "Enter");
      await pressKey(job("task-2-s1").locator("[data-kept-remove-for-good]"), "Enter");
      await expect(job("task-2-s1").locator("[data-kept-remove-failed]")).toHaveAttribute(
        "data-kept-remove-failed",
        "failed",
      );
      expect(existsSync(stuck)).toBe(true);
      expect(jobs.list()[0]?.removeFailed?.outcome).toBe("failed");
    });

    await test.step("Remove on that row asks once, hiding Forget, and Escape or leaving it runs nothing", async () => {
      const failed = job("task-2-s1");
      const before = jobs.list()[0]?.removeFailed;
      await pressKey(failed.locator("[data-kept-remove]"), "Enter");
      await expect(failed.locator("[data-kept-remove-for-good]")).toBeFocused();
      await expect(failed.locator("[data-kept-forget]")).toHaveCount(0);
      await pressKey(failed.locator("[data-kept-remove-for-good]"), "Escape");
      await expect(failed.locator("[data-kept-remove]")).toBeVisible();
      await expect(failed.locator("[data-kept-forget]")).toBeVisible();
      await pressKey(failed.locator("[data-kept-remove]"), "Enter");
      await pressKey(failed.locator("[data-kept-remove-for-good]"), "Tab");
      await expect(failed.locator("[data-kept-remove]")).toBeVisible();
      await expect(failed.locator("[data-kept-forget]")).toBeVisible();
      expect(jobs.list()[0]?.removeFailed).toEqual(before);
    });

    await test.step("Forget, beside the remove that did not finish, takes it off the list and runs nothing", async () => {
      const forget = job("task-2-s1").locator("[data-kept-forget]");
      await expect(forget).toContainText(COMPUTER);
      await pressKey(forget, "Enter");
      await expect(job("task-2-s1")).toHaveCount(0);
      expect(jobs.list()).toEqual([]);
      expect(existsSync(stuck)).toBe(true);
    });

    await test.step("with no job kept and no automation saved, the section and the panel go", async () => {
      await expect(section.locator("[data-kept-running]")).toHaveCount(0);
      // Escape leaves Settings for home, where the rails are drawn.
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-screen-label="Settings"]')).toHaveCount(0);
      await expect(
        page.locator('[data-screen-label]:not([data-screen-label="Settings"])'),
      ).toBeVisible();
      // Home reads `automation.kept` again; the wait covers its poll as well.
      await expect(page.locator(`[data-side-panel="${PANEL}"]:not([hidden])`)).toHaveCount(0, {
        timeout: 60_000,
      });
    });
  } finally {
    await close();
  }
});
