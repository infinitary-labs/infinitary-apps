import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { closingNoteTitle, droppedLine } from "../../src/core/orchestrator/settleWords";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { DISCARD_PROMPT_MARKER, MOCK_CLOSING_SENTENCES } from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { expandDock, feedLine, startedLine, taskKey } from "./rails";
import { expectNoCard, showCard, shownCard, shownEntry } from "./stack";
import { runFromSearch } from "./windowKeys";

/**
 * INF-547, the captain's words: "the tasks were done but i never got any
 * update". A task a crewmate worked on that the first mate closes without
 * the captain's click leaves them one note in the first mate's own sentence
 * when nothing else of the task is on their stack, and it goes only when they
 * close it. Activity's line for a drop says "Dropped:" and the same
 * sentence. The promised result is the note and the line after one
 * first-mate discard of started work; the data is a real project folder with
 * one commissioned task; the completion signals are the task's dropped
 * record and the note on the stack; it needs only the hermetic launcher and
 * shares nothing with another test.
 */

function initGitRepo(): string {
  const dir = scratchDir("infinitary-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  writeFileSync(join(dir, "README.md"), "# Test repo\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return dir;
}

test("a first mate's drop of started work leaves its note until the captain closes it", async () => {
  test.setTimeout(3 * 60_000);
  let app: LaunchedApp = await launchApp({ withMockProvider: true });
  const sentence = MOCK_CLOSING_SENTENCES.discard;
  try {
    await resizeWindow(app.app, app.page, { width: 1280, height: 820 });
    const repo = initGitRepo();
    await app.page.evaluate((path) => window.infinitary.repos.setup({ kind: "adopt", path }), repo);
    const title = `meter fix in ${basename(repo)}`;
    let key = "";
    let noteTitle = "";

    await test.step("the first mate drops a task its crewmate started", async () => {
      const { page } = app;
      const input = promptInput(page);
      await waitForFirstmateIdle(page);
      await input.click();
      await input.fill(`commission a crewmate: ${title}`);
      await input.press("Enter");
      key = await taskKey(page, title);
      await expandDock(page, "activity");
      await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
      await waitForFirstmateIdle(page, 30_000);
      await input.click();
      await input.fill(`${DISCARD_PROMPT_MARKER}${title}`);
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(async () => (await window.infinitary.tasks.board()).tasks)).find(
              (task) => task.key === key,
            )?.status,
          { timeout: 30_000 },
        )
        .toBe("dropped");
    });

    await test.step("its note says what became of the work, in the first mate's sentence", async () => {
      const { page } = app;
      noteTitle = closingNoteTitle(key, "dropped");
      await expect(shownCard(page, noteTitle)).toBeVisible({ timeout: 30_000 });
      await expect(cardBody(page, noteTitle).locator("body")).toContainText(sentence);
      const [note, ...others] = await page.evaluate(() => window.infinitary.cards.list());
      expect(others).toEqual([]);
      expect(note).toMatchObject({ author: "firstmate", title: noteTitle, actions: [] });
    });

    await test.step("Activity's line for the drop reads Dropped: and the same sentence", async () => {
      const line = feedLine(app.page, droppedLine(sentence));
      await expect(line).toBeVisible();
      // The release note's picture: the note beside the line it explains.
      await heroShot(app.app, app.page, {
        region: shownEntry(app.page),
        anchors: [line],
        name: "closing-note",
        dir: test.info().outputPath("hero"),
      });
    });

    await test.step("the note is still there after a restart", async () => {
      const { userDataDir, homeDir } = app;
      await app.close();
      app = await launchApp({ withMockProvider: true, userDataDir, homeDir });
      await showCard(app.page, noteTitle);
    });

    await test.step("the keyboard closes it, and it stays closed", async () => {
      await runFromSearch(app.app, app.page, "cards.minimize");
      await expectNoCard(app.page, noteTitle);
      await expect.poll(() => app.page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
    });
  } finally {
    await app.close();
  }
});
