import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { seedRepo } from "./githubStub";
import { bubbleWords, yourBubble } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { seedProject } from "./projectSeed";
import { projectLine } from "./projects";
import {
  SUGGEST_TAGS_CARD_TITLE,
  SUGGEST_TAGS_PROJECT,
  suggestTags,
} from "./scenarios/suggestTags";
import { shownCard } from "./stack";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

/**
 * The approved Suggest tags plan (docs/task-tags.md, "Suggesting tags"): a
 * project with no tags shows Suggest tags before Add a tag, reached by keys;
 * its press goes home with the person's own message, and the first mate's
 * turn carries the note the press added, naming the project. Its data is one
 * disposable project with one task in the launcher's private home; the first
 * mate is the scripted stand-in, which puts up its card only for a turn
 * carrying that note.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test("Suggest tags in an empty Tags box asks the first mate by keys, with the press's note naming the project", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-suggest-tags-");
  const { repoDir } = seedRepo(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: SUGGEST_TAGS_PROJECT.id,
    path: repoDir,
    name: SUGGEST_TAGS_PROJECT.name,
    key: SUGGEST_TAGS_PROJECT.key,
    runsOn: null,
  });
  seedTask(new TaskService({ db, strict: true }), {
    id: "fix-login",
    repoId: SUGGEST_TAGS_PROJECT.id,
    title: "Sign-in times out after a restart",
    goal: "Signing in again after the app restarts succeeds within ten seconds.",
    status: "queued",
    startPolicy: "on-request",
  });
  db.close();

  launched = await launchApp({ withMockProvider: true, scenarios: [suggestTags], userDataDir });
  const { app, page } = launched;
  const tagsBox = page.locator("[data-project-tags]");
  const suggest = tagsBox.locator("[data-tag-suggest]");
  const words = m.settingsProjectsTagsSuggestWords({ project: SUGGEST_TAGS_PROJECT.name });

  await test.step("An empty Tags box offers Suggest tags before Add a tag, as its own Tab stop", async () => {
    await pressWindowKey(app, ",", ["meta"]);
    const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
    await focusOn(projectsTab);
    await pressKey(projectsTab, "Enter");
    await pressKey(projectLine(page, SUGGEST_TAGS_PROJECT.id).getByRole("button"), "Enter");
    await expect(tagsBox).toBeVisible();
    await expect(tagsBox.locator("[data-tag-suggest-line]")).toHaveText(
      m.settingsProjectsTagsSuggestHint(),
    );
    await expect(suggest).toHaveAccessibleName(m.settingsProjectsTagsSuggest());
    await pressKey(tagsBox.locator("[data-tag-add]"), "Shift+Tab");
    await expect(suggest).toBeFocused();
  });

  await test.step("Enter goes home with the person's message, and the first mate's card answers the press's note", async () => {
    await page.keyboard.press("Enter");
    await expect(tagsBox).toHaveCount(0);
    await expect(bubbleWords(yourBubble(page))).toHaveText(words);
    await expect(shownCard(page, SUGGEST_TAGS_CARD_TITLE)).toBeVisible({ timeout: 60_000 });
  });
});
