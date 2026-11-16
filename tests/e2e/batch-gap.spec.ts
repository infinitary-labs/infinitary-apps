import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { PROJECT_POLICY_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { BATCH_GAP_WORDS } from "../../src/shared/batches";
import { PROJECT_DELIVERY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { heroShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { projectRow } from "./projects";
import { readSavedData } from "./savedData";
import { focusOn, pressKey } from "./windowKeys";

/**
 * The captain's approved plan to run a batched project's batch check less
 * often, piece 1: "In Settings → Projects under Batched pull requests, for
 * any batched project, with “As soon as a change is approved” as
 * everyone's default", reached from the keyboard like every control.
 *
 * A project on GitHub with batched pull requests, served by a disposable
 * GitHub with the app's real sign-in. The captain opens its row by keys,
 * reaches When a batch starts with Tab right after Where changes go, picks
 * at most every 3 hours, then puts it back. The completion signal is the
 * saved project record (`batch_gap_minutes`). The line's rule itself is
 * `src/core/batches/batches.test.ts`'s. Requires desktop Electron and local
 * git; no real sign-in or shared pull request.
 */
test("a batched project's batch gap is set by keys in Settings → Projects and saved on the project", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-batch-gap-");
  const { repoDir } = seedRepo(userDataDir);
  const github = await startGitHubStub();
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repoDir,
    name: "meterlab",
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "queue-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  const launched = await launchApp({ withMockProvider: true, userDataDir, env: github.env });
  try {
    const { page } = launched;
    const saved = () =>
      readSavedData(
        userDataDir,
        (savedDb) =>
          (
            savedDb
              .prepare("SELECT batch_gap_minutes FROM repos WHERE id = ?")
              .get("repo-meterlab") as { batch_gap_minutes: number | null }
          ).batch_gap_minutes,
      );

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    const row = projectRow(page, "repo-meterlab");
    const header = row.getByRole("button", { expanded: false });
    await expect(header).toBeVisible();
    await pressKey(header, "Enter");
    const batched = row.getByRole("radio", {
      name: PROJECT_DELIVERY_WORDS["queue-pr"],
      exact: true,
    });
    await expect(batched).toBeChecked();

    // Everyone's default: a batch starts as soon as a change is approved.
    const gap = row.getByRole("combobox", { name: BATCH_GAP_WORDS.title });
    await expect(gap).toHaveValue("now");
    await expect(gap.locator("option:checked")).toHaveText(BATCH_GAP_WORDS.label(null));
    await expect(row).toContainText(BATCH_GAP_WORDS.description);
    expect(await saved()).toBeNull();

    // Tab from Where changes go reaches it, before Require pull request checks.
    await focusOn(batched);
    await pressKey(batched, "Tab");
    await expect(gap).toBeFocused();
    await gap.selectOption({ label: BATCH_GAP_WORDS.label(180) });
    await expect.poll(saved).toBe(180);
    await expect(gap.locator("option:checked")).toHaveText(BATCH_GAP_WORDS.label(180));
    await pressKey(gap, "Tab");
    await expect(row.getByRole("switch", { name: PROJECT_POLICY_WORDS.checksTitle })).toBeFocused();

    const inView = () => gap.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await inView();
    await heroShot(launched.app, page, {
      region: gap,
      anchors: [row.getByRole("radiogroup", { name: "Where changes go" })],
      name: "batch-gap",
      ready: inView,
    });

    // Put back: the project starts a batch as soon as a change is approved again.
    await focusOn(gap);
    await gap.selectOption("now");
    await expect.poll(saved).toBeNull();
  } finally {
    await launched.close();
    await github.close();
  }
});
