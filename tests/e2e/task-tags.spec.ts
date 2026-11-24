import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import { seedProject } from "./projectSeed";
import { projectLine } from "./projects";
import { expandDock, expectRecordBody, openGroup, pressRow, recordCard } from "./rails";
import { focusOn, pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * The approved tags plan's first piece (docs/task-tags.md): a project's page
 * in Settings has a Tags box where a person adds, renames and removes the
 * project's tags from the keyboard, a name the project already has in any
 * case is refused, Edit tags in command search ticks a tag on the shown
 * record, and removing a tag asks once, naming how many tasks carry it, and
 * takes it off them. Its data is one disposable project and one backlog task
 * in the launcher's private home; no model turn runs.
 */
test("a project's tags are added, renamed and removed by keys, and Edit tags ticks one on a task's record", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-task-tags-");
  const { repoDir } = seedRepo(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, { id: "repo-harbour", path: repoDir, name: "harbour", key: "HAR", runsOn: null });
  const task = seedTask(new TaskService({ db, strict: true }), {
    id: "fix-login",
    repoId: "repo-harbour",
    title: "Sign-in times out after a restart",
    goal: "Signing in again after the app restarts succeeds within ten seconds.",
    status: "queued",
    startPolicy: "on-request",
  });
  db.close();

  const launched = await launchApp({ withMockProvider: true, userDataDir });
  try {
    const { app, page } = launched;
    const tagsBox = page.locator("[data-project-tags]");
    const tagRow = (name: string) => tagsBox.locator("[data-project-tag]", { hasText: name });
    const openTags = async () => {
      await pressWindowKey(app, ",", ["meta"]);
      const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
      await focusOn(projectsTab);
      await pressKey(projectsTab, "Enter");
      await pressKey(projectLine(page, "repo-harbour").getByRole("button"), "Enter");
      await expect(tagsBox).toBeVisible();
    };
    const fillForm = async (name: string, description: string) => {
      const form = tagsBox.locator("[data-project-tag-form]");
      const nameField = form.getByLabel(m.settingsProjectsTagsName(), { exact: true });
      await expect(nameField).toBeFocused();
      await nameField.selectText();
      await typeInto(nameField, name);
      await pressKey(nameField, "Tab");
      const descriptionField = form.getByLabel(m.settingsProjectsTagsDescription(), {
        exact: true,
      });
      await expect(descriptionField).toBeFocused();
      await descriptionField.selectText();
      await typeInto(descriptionField, description);
      await pressKey(descriptionField, "Enter");
    };

    await test.step("Add a tag saves a name and description; the same name in another case is refused", async () => {
      await openTags();
      await expect(tagsBox.locator("[data-project-tags-empty]")).toHaveText(
        m.settingsProjectsTagsEmpty(),
      );
      await pressKey(tagsBox.locator("[data-tag-add]"), "Enter");
      await fillForm("bug", "Something that worked does not: a crash or a wrong result.");
      await expect(tagRow("bug")).toContainText(m.settingsProjectsTagsTasks({ count: 0 }));
      await expect(tagRow("bug").locator("[data-tag-edit]")).toBeFocused();

      await pressKey(tagsBox.locator("[data-tag-add]"), "Enter");
      await fillForm("Bug", "Another description.");
      await expect(tagsBox.locator("[data-project-tag-form]")).toContainText(
        m.settingsProjectsTagsNameTaken({ name: "bug" }),
      );
      await pressKey(
        tagsBox.locator("[data-project-tag-form]").getByLabel(m.settingsProjectsTagsDescription()),
        "Escape",
      );
      await expect(tagsBox.locator("[data-project-tag-form]")).toHaveCount(0);
      await expect(tagsBox.locator("[data-tag-add]")).toBeFocused();
      // Escape put the form away and left Settings open.
      await expect(tagsBox).toBeVisible();
    });

    await test.step("Edit renames the tag in its row", async () => {
      await pressKey(tagRow("bug").locator("[data-tag-edit]"), "Enter");
      await fillForm("defect", "Something that worked does not: a crash or a wrong result.");
      await expect(tagRow("defect")).toBeVisible();
      await expect(tagsBox.locator("[data-project-tag]")).toHaveCount(1);
      await pressWindowKey(app, "Escape");
      await pressWindowKey(app, "Escape");
      await expect(tagsBox).toHaveCount(0);
    });

    await test.step("Edit tags in command search ticks the tag on the shown record", async () => {
      await expandDock(page, "now");
      await openGroup(page, "backlog");
      await pressRow(page, task.key);
      await expectRecordBody(page);
      const facts = recordCard(page).locator("[data-record-tags-row]");
      await expect(facts).toContainText(m.recordTagsNone());
      await runFromSearch(app, page, "task.edit-tags");
      const item = page.getByRole("menuitemcheckbox", { name: /^defect/ });
      await expect(item).toHaveAttribute("aria-checked", "false");
      await pressKey(item, "Enter");
      await expect(item).toHaveAttribute("aria-checked", "true");
      await expect(facts).toContainText("defect");
      await expect(facts).not.toContainText(m.recordTagsNone());
      await page.keyboard.press("Escape");
      expect(
        (await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id)).tags,
      ).toMatchObject([{ name: "defect", by: "captain" }]);
    });

    await test.step("Remove asks once naming the task count, then takes the tag off the task", async () => {
      await openTags();
      await expect(tagRow("defect")).toContainText(m.settingsProjectsTagsTasks({ count: 1 }));
      await pressKey(tagRow("defect").locator("[data-tag-remove]"), "Enter");
      const asking = tagsBox.locator("[data-project-tag-asking]");
      await expect(asking).toContainText(
        m.settingsProjectsTagsRemoveQuestion({ name: "defect", count: 1 }),
      );
      const cancel = asking.getByRole("button", { name: m.settingsProjectsTagsCancel() });
      await expect(cancel).toBeFocused();
      await pressKey(cancel, "Tab");
      await expect(asking.locator("[data-tag-remove-confirm]")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(tagsBox.locator("[data-project-tag]")).toHaveCount(0);
      await expect(tagsBox.locator("[data-tag-add]")).toBeFocused();
      expect(
        (await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id)).tags,
      ).toBeUndefined();
    });
  } finally {
    await launched.close();
  }
});
