import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import {
  SAVED_DATA_REFUSAL_MESSAGE,
  SAVED_DATA_REFUSAL_TITLE,
} from "../../src/core/storage/savedDataCompatibility";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { recordNewerMigration } from "../helpers/database";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { seedProtectedProfile } from "./savedDataFixtures";

for (const reason of ["database", "persisted-format"] as const) {
  test(`${reason} incompatibility visibly protects saved work`, async () => {
    const userDataDir = scratchDir("fm-refusal-journey-");
    const db = openDatabase(userDataDir);
    seedTask(new TaskService({ db }), {
      id: "protected-task",
      title: "Keep my saved work",
      status: "queued",
      startPolicy: "on-request",
    });
    if (reason === "database") recordNewerMigration(db);
    db.close();
    seedProtectedProfile(userDataDir, reason === "persisted-format");
    const protectedFiles = [
      "firstmate.db",
      "saved-data-format.json",
      "accounts/sentinel.json",
      "firstmate/conversation.jsonl",
    ];
    const before = protectedFiles.map((file) => readFileSync(join(userDataDir, file)));
    const homeDir = scratchDir("fm-refusal-home-");
    const launched = await launchApp({
      userDataDir,
      homeDir,
      env: { CFFIXED_USER_HOME: homeDir },
      shell: false,
    });
    try {
      await expect(
        launched.page.getByRole("heading", { name: SAVED_DATA_REFUSAL_TITLE }),
      ).toBeVisible();
      await expect(launched.page.getByRole("main")).toContainText(SAVED_DATA_REFUSAL_MESSAGE);
      expect(await launched.page.evaluate(() => typeof window.infinitary)).toBe("undefined");
      await launched.page.screenshot({
        path: test.info().outputPath(`${reason}.png`),
      });
    } finally {
      await launched.close();
    }
    for (const [index, file] of protectedFiles.entries())
      expect(readFileSync(join(userDataDir, file))).toEqual(before[index]);
  });
}

for (const throughVersion of [1, undefined]) {
  test(`supported ${throughVersion === 1 ? "older" : "current"} saved data opens normally`, async () => {
    const userDataDir = scratchDir("fm-supported-journey-");
    openDatabase(userDataDir, throughVersion).close();
    const homeDir = scratchDir("fm-supported-home-");
    const launched = await launchApp({
      userDataDir,
      homeDir,
      env: { CFFIXED_USER_HOME: homeDir },
      shell: false,
    });
    try {
      await expect
        .poll(() => launched.page.evaluate(() => window.infinitary.app.healthcheck()))
        .toMatchObject({ ok: true });
      await expect(
        launched.page.getByRole("heading", { name: SAVED_DATA_REFUSAL_TITLE }),
      ).toHaveCount(0);
      const health = await launched.page.evaluate(() => window.infinitary.app.healthcheck());
      writeFileSync(
        test.info().outputPath(`supported-${throughVersion === 1 ? "older" : "current"}.json`),
        JSON.stringify(health, null, 2),
      );
    } finally {
      await launched.close();
    }
  });
}
