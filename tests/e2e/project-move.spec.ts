import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { MOVE_CARD_SAID } from "../../src/core/workspace/repositoryMove";
import { englishOf } from "../../src/shared/i18n/said";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import { PROJECT_MOVE_MARKER, projectMove } from "./scenarios/projectMove";
import { expectNoCard, shownCard } from "./stack";
import { runFromSearch, untilFocused } from "./windowKeys";

/**
 * INF-5005's plan, part 1, with the captain's rule that every feature works
 * from the keyboard: the first mate proposes moving two repositories into a
 * third project, and the app's move card answers by keys alone, from where
 * the window's focus is: Go to the card's buttons lands on Apply move with
 * its ring, Shift-Tab reaches Not now with its ring, and Enter there moves
 * nothing; on the second card, Enter on Apply move moves both
 * repositories. The completion signal is each repository's saved project (`repos.project_id`). The move's own rules are
 * `src/core/core.projects.test.ts`'s. Requires desktop Electron and local
 * git; no real sign-in or shared resource.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
const REPOS = [
  { id: "repo-ledger-app", name: "ledger-app", key: "LED" },
  { id: "repo-ledger-business", name: "ledger-business", key: "LEB" },
  { id: "repo-ledger-infra", name: "ledger-infra", key: "LEI" },
] as const;
const MOVED = [REPOS[1], REPOS[2]] as const;
const TARGET = REPOS[0];

test("the move card answers by keys from the window: Shift-Tab to Not now moves nothing, Enter on Apply move moves both repositories", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-project-move-");
  const db = openDatabase(userDataDir);
  REPOS.forEach(({ id, name, key }, index) => {
    const dir = join(userDataDir, name);
    git("init", "--quiet", "--initial-branch=main", dir);
    git(
      "-C",
      dir,
      "-c",
      "user.name=E2E",
      "-c",
      "user.email=e2e@localhost",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    );
    seedProject(db, {
      id,
      path: dir,
      name,
      key,
      setupKind: "init",
      origin: null,
      runsOn: null,
      delivery: "local-only",
      addedAt: index + 1,
    });
  });
  seedTask(new TaskService({ db }), {
    id: "invoice-export",
    title: "Add the invoice export",
    repoId: MOVED[0].id,
    status: "queued",
    startPolicy: "on-request",
  });
  db.close();
  const projectOf = (repoId: string) =>
    readSavedData(
      userDataDir,
      (saved) =>
        (
          saved
            .prepare(
              "SELECT p.key FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.id = ?",
            )
            .get(repoId) as { key: string }
        ).key,
    );
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [projectMove({ repoIds: MOVED.map((repo) => repo.id), project: TARGET.key })],
    userDataDir,
  });
  try {
    const { app, page } = launched;
    const title = englishOf(
      MOVE_CARD_SAID.title({
        repos: MOVED.map(({ id, name }) => ({ id, name, from: id })),
        sources: [],
        target: { kind: "existing", id: TARGET.id, key: TARGET.key, name: TARGET.name },
      }),
    );
    const ask = async () => {
      const input = promptInput(page);
      await input.fill(PROJECT_MOVE_MARKER);
      await input.press("Enter");
      const card = shownCard(page, title);
      await expect(card).toBeVisible({ timeout: 45_000 });
      await expect(cardBody(page, title).locator("body")).toBeVisible({ timeout: 45_000 });
      return {
        apply: card.getByRole("button", { name: englishOf(MOVE_CARD_SAID.apply), exact: true }),
        notNow: card.getByRole("button", { name: englishOf(MOVE_CARD_SAID.notNow), exact: true }),
      };
    };
    const ringed = (button: ReturnType<typeof page.locator>) =>
      button.evaluate((element) => element.matches(":focus-visible"));

    // From where the window's focus is, the message box after the ask, Go
    // to the card's buttons lands on the default with its ring.
    await test.step("Shift-Tab from Apply move reaches Not now, and Enter moves nothing", async () => {
      const { notNow, apply } = await ask();
      await runFromSearch(app, page, "focus.card-actions");
      await untilFocused(apply);
      expect(await ringed(apply)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await untilFocused(notNow);
      expect(await ringed(notNow)).toBe(true);
      await page.keyboard.press("Enter");
      await expectNoCard(page, title);
      expect(MOVED.map((repo) => projectOf(repo.id))).toEqual(MOVED.map((repo) => repo.key));
    });

    await test.step("Enter on Apply move moves both repositories", async () => {
      const { apply } = await ask();
      await runFromSearch(app, page, "focus.card-actions");
      await untilFocused(apply);
      expect(await ringed(apply)).toBe(true);
      await page.keyboard.press("Enter");
      await expectNoCard(page, title);
      await expect
        .poll(() => MOVED.map((repo) => projectOf(repo.id)), { timeout: 15_000 })
        .toEqual([TARGET.key, TARGET.key]);
    });
  } finally {
    await launched.close();
  }
});
