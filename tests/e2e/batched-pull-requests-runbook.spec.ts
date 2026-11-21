import { expect, test } from "@playwright/test";
import { offerInUse } from "../../src/core/runbooks/runbooks";
import { openDatabase } from "../../src/core/storage/db";
import { PROJECT_POLICY_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { BATCHED_PULL_REQUESTS_OFFER } from "../../src/shared/runbooks";
import { PROJECT_DELIVERY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { leaveSettings } from "./handoverCards";
import { launchApp } from "./launch";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { projectLine, projectSettings } from "./projects";
import { readSavedData } from "./savedData";
import { settingRow } from "./settings";
import { focusOn, pressKey } from "./windowKeys";

/**
 * The captain's ask (INF-4754's approved plan): "by default the batch pull
 * request runbook is off, and when it's off we don't show the option in
 * project settings. only when the user turns it on, then we allow the
 * option."
 *
 * A project on GitHub on pull requests, served by a disposable GitHub with
 * the app's real sign-in, on a fresh install. Its page lists only a local
 * merge and pull requests and never names a batch; the captain turns
 * Batched pull requests on in Settings → Runbooks by keys, then picks
 * batched pull requests on the project page by keys. The runbook's Batches
 * panel arrives when it is turned on and leaves when it is turned off before
 * any project batches, with no restart. Turning the runbook off while the
 * project uses it is refused with its reason. Completion
 * signals are the saved project record (`delivery`) and the saved switch.
 * Requires desktop Electron and local git; no real sign-in or shared pull
 * request.
 */
/** The project this spec seeds, named in the refusal it reads back. */
const PROJECT = "meterlab";

test("batched pull requests appear in a project's settings only once their runbook is turned on by keys", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-batches-runbook-");
  const { repoDir } = seedRepo(userDataDir);
  const github = await startGitHubStub();
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repoDir,
    name: PROJECT,
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({ withMockProvider: true, userDataDir, env: github.env });
  try {
    const { page } = launched;
    const delivery = () =>
      readSavedData(
        userDataDir,
        (savedDb) =>
          (
            savedDb.prepare("SELECT delivery FROM repos WHERE id = ?").get("repo-meterlab") as {
              delivery: string;
            }
          ).delivery,
      );
    const choices = () =>
      projectSettings(page, "repo-meterlab")
        .getByRole("radiogroup", { name: "Where changes go" })
        .getByRole("radio");
    const openProject = async () => {
      await page.getByRole("tab", { name: "Projects", exact: true }).click();
      const line = projectLine(page, "repo-meterlab").getByRole("button");
      await expect(line).toBeVisible();
      await pressKey(line, "Enter");
    };

    // A fresh install: the project offers a local merge and pull requests, and no word names a batch.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await openProject();
    const row = projectSettings(page, "repo-meterlab");
    await expect(choices()).toHaveCount(2);
    await expect(
      row.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["direct-pr"], exact: true }),
    ).toBeChecked();
    await expect(row).toContainText(PROJECT_POLICY_WORDS.delivery(false));
    await expect(row).not.toContainText(PROJECT_POLICY_WORDS.delivery(true));
    await expect(
      row.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["queue-pr"], exact: true }),
    ).toHaveCount(0);

    // The rails draw only at home: the runbook's Batches panel follows its switch
    // there with no restart, arriving when the runbook is turned on and, with no
    // project batching yet, leaving when it is turned off (docs/runbooks.md,
    // "Built-in panels"). Activity, which every build draws, shows the rails are up.
    const panel = page.locator('[data-side-panel="batches-panel"]');
    const batches = settingRow(page, "runbook-batches").getByRole("switch");
    const onTheRail = async (count: number) => {
      await leaveSettings(page);
      await expect(page.locator('[data-side-panel="activity"]')).toHaveCount(1);
      await expect(panel).toHaveCount(count);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Runbooks", exact: true }).click();
      await focusOn(batches);
    };
    const turn = async (on: boolean) => {
      await pressKey(batches, "Space");
      await expect(batches).toHaveAttribute("aria-checked", String(on));
    };

    // Settings → Runbooks: Batched pull requests starts off, and the captain turns it on by keys.
    await onTheRail(0);
    await expect(batches).toHaveAttribute("aria-checked", "false");
    await turn(true);
    await onTheRail(1);
    await turn(false);
    await onTheRail(0);
    await turn(true);
    await onTheRail(1);

    // Back on the project page, batched pull requests are the third choice, picked by keys.
    await openProject();
    await expect(choices()).toHaveCount(3);
    await expect(choices().nth(2)).toHaveAccessibleName(PROJECT_DELIVERY_WORDS["queue-pr"]);
    await expect(row).toContainText(PROJECT_POLICY_WORDS.delivery(true));
    const pullRequests = row.getByRole("radio", {
      name: PROJECT_DELIVERY_WORDS["direct-pr"],
      exact: true,
    });
    await focusOn(pullRequests);
    await pressKey(pullRequests, "ArrowRight");
    await expect(
      row.getByRole("radio", { name: PROJECT_DELIVERY_WORDS["queue-pr"], exact: true }),
    ).toBeChecked();
    await expect.poll(delivery).toBe("queue-pr");

    // While the project uses them, the runbook cannot be turned off; Settings says which project.
    await page.getByRole("tab", { name: "Runbooks", exact: true }).click();
    const again = settingRow(page, "runbook-batches").getByRole("switch");
    await focusOn(again);
    await pressKey(again, "Space");
    await expect(page.locator('[data-settings-error="runbooks"]')).toContainText(
      offerInUse(BATCHED_PULL_REQUESTS_OFFER, [PROJECT]),
    );
    await expect(again).toHaveAttribute("aria-checked", "true");
    const saved = await page.evaluate(() => window.infinitary.settings.getRunbooks());
    expect(saved.find((book) => book.id === "batches")?.enabled).toBe(true);
    expect(await delivery()).toBe("queue-pr");
  } finally {
    await launched.close();
    await github.close();
  }
});
