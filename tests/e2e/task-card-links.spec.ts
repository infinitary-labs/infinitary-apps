import { expect, test } from "@playwright/test";
import { checksSentence } from "../../src/core/tasks/recordActivity";
import { crewRoster } from "./crewRoster";
import { launchApp } from "./launch";
import { expandDock, expectRecordBody, pressRow, recordCard, recordFrame, taskFact } from "./rails";
import { clickInBody } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * Every pull request a task's card names opens that pull request (FI3-1159;
 * the design skill's TaskRecord, "Pull request links"): the fact strip's
 * Pull request cell, the words of Now that name it and an Activity line
 * that names it, by pointer and by keys. The system browser is replaced by
 * a recorder, so nothing here opens a page.
 */
test("every pull request a task's card names opens it, from the strip, Now and Activity", async () => {
  const fixture = await crewRoster(1, {
    idPrefix: "linked-pr",
    title: () => "Fix the meter's unit",
    change: () => ({ prNumber: 965, ci: "red" }),
  });
  const pr = "https://github.com/example/crew/pull/965";
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    await app.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const opened = () =>
      app.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);
    await expandDock(page, "now");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const key = board.tasks.find((task) => task.id === "linked-pr-0")?.key;
    if (!key) throw new Error("The seeded task is missing");
    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "linked-pr-0");
    await expectRecordBody(page);

    await test.step("the fact strip's pull request opens it on a click", async () => {
      const strip = recordCard(page).locator("[data-record-strip]");
      await expect(taskFact(strip, "checks")).toHaveAttribute("data-dot", "failed");
      await taskFact(strip, "change").getByRole("link", { name: "#965" }).click();
      await expect.poll(opened).toEqual([pr]);
    });

    await test.step("the pull request Now names opens it from the keyboard", async () => {
      const now = taskFact(recordCard(page), "now");
      await expect(now).toHaveText(checksSentence("red", "#965", undefined));
      const link = now.getByRole("link", { name: "pull request #965" });
      await pressKey(link, "Enter");
      await expect.poll(opened).toEqual([pr, pr]);
    });

    await test.step("an Activity line that names it opens it too", async () => {
      const activity = recordFrame(page).locator('[data-record-section="timeline"] > summary');
      await pressKey(activity, "Enter");
      const line = recordFrame(page)
        .locator('[data-record-event="pr_opened"] [data-record-change]')
        .first();
      await clickInBody(line);
      await expect.poll(opened).toEqual([pr, pr, pr]);
    });
  } finally {
    await app.close();
  }
});
