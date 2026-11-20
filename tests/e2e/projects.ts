import { execFileSync } from "node:child_process";
import { expect, type Locator, type Page } from "@playwright/test";
import { SETUP_CARD_WORDS } from "../../src/shared/projectSetup";
import { showCard, shownCard } from "./stack";

/**
 * The projects the captain added, oldest first: every registered one but the
 * personal workspace, which is a project from the first start so a panel
 * instruction can be a direction scoped to it (INF-1054).
 */
export async function addedProjects(page: Page) {
  return (await page.evaluate(() => window.infinitary.repos.list())).filter(
    (repo) => repo.kind !== "personal",
  );
}

/**
 * One project's line in Settings -> Projects' list, by the registered id of
 * its repository: a project of one repository, or the personal workspace.
 */
export function projectLine(page: Page, id: string): Locator {
  return page.locator(`[data-project-line-of="${id}"]`);
}

/**
 * The quiet words after a project's name on its list line, one locator per
 * word: only how the project differs from a new one (`projectRowWords`).
 */
export function projectRowWords(page: Page, id: string): Locator {
  return projectLine(page, id).locator("[data-project-word]");
}

/**
 * One repository's settings on its project's page in Settings -> Projects,
 * by its registered id: the panel under its chosen tab, or the personal
 * workspace's rows.
 */
export function projectSettings(page: Page, id: string): Locator {
  return page.locator(`[data-project="${id}"]`);
}

/**
 * Opens, from Settings -> Projects' list, the page of the project whose one
 * repository is `id`, and returns that repository's settings.
 */
export async function openProject(page: Page, id: string): Promise<Locator> {
  await projectLine(page, id).getByRole("button").click();
  const settings = projectSettings(page, id);
  await expect(settings).toBeVisible();
  return settings;
}

/**
 * The setup card a Firstmate proposal put up for the project named `name`
 * (docs/fleet.md, "Asking the first mate to add a project"), as the stage shows it.
 */
export function setupCard(page: Page, name: string): Locator {
  return shownCard(page, SETUP_CARD_WORDS.title(name));
}

/** Brings the setup card for `name` forward once the app has put it up. */
export async function showSetupCard(page: Page, name: string): Promise<void> {
  const title = SETUP_CARD_WORDS.title(name);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (card) => card.title === title,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await showCard(page, title);
}

/**
 * The captain's Add project on the setup card for `name`: its own footer
 * button, which alone adds the project, with whatever its questions hold.
 * The card leaves the stage on the click.
 */
export async function addFromSetupCard(page: Page, name: string): Promise<void> {
  await showSetupCard(page, name);
  await page
    .locator("[data-card-layer]")
    .getByRole("button", { name: SETUP_CARD_WORDS.add, exact: true })
    .click();
  await expect(setupCard(page, name)).toHaveCount(0, { timeout: 10_000 });
}

/**
 * The task working copies git lists for a project: every working copy on a
 * branch but the project's own folder, which git lists first. The warm
 * pool's spare copies are detached (`worktreePool.ts`), so they are none. A
 * task's branch is named from the first mate's words or the task's title
 * (docs/architecture.md, "A task's branch"), so a task's working copy is
 * never told by its branch's name.
 */
export function taskWorktrees(repoDir: string): string[] {
  return execFileSync("git", ["-C", repoDir, "worktree", "list"])
    .toString()
    .trim()
    .split("\n")
    .slice(1)
    .filter((line) => !line.includes("(detached HEAD)"));
}

/** The branch a task's record names, the one its start made: empty before it starts. */
export async function taskBranch(page: Page, taskId: string): Promise<string> {
  const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
  return detail?.repo?.branch ?? "";
}
