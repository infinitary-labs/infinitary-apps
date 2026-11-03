import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { OpenDialogOptions } from "electron";
import { PROJECT_ROW_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { startGitHubStub } from "./githubStub";
import { gitCloneHome } from "./homeFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { addedProjects, addFromSetupCard, projectRow, projectRowWords } from "./projects";
import { promptInput } from "./prompt";
import {
  CLONE_REPO_PROMPT_MARKER,
  INIT_REPO_PROMPT_MARKER,
  projectSetup,
} from "./scenarios/projectSetup";
import { assertReadableSettingsFeedback, assertSettingsFits, settingRow } from "./settings";

/**
 * Where new projects go (Settings -> Projects, docs/fleet.md): the person
 * picks a folder with the system's folder picker, Firstmate clones and
 * starts new projects there - each still indexed in the fleet root by a
 * link - and the choice survives a restart. Projects already set up never
 * move, and a folder the app cannot use is refused beside the row.
 *
 * The picker is the system's own sheet, so the test answers it in the main
 * process and records where each call opened.
 */

type PickerProbe = { infinitaryPickerOpenedAt?: (string | undefined)[] };

/** The next folder picker answers with `answer`, or is cancelled when null. */
async function answerFolderPicker(app: ElectronApplication, answer: string | null) {
  await app.evaluate(({ dialog }, answer) => {
    const probe = globalThis as PickerProbe;
    probe.infinitaryPickerOpenedAt ??= [];
    const opened = probe.infinitaryPickerOpenedAt;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      opened.push((args.at(-1) as OpenDialogOptions).defaultPath);
      return answer === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [answer] };
    }) as typeof dialog.showOpenDialog;
  }, answer);
}

async function pickerOpenedAt(app: ElectronApplication): Promise<(string | undefined)[]> {
  return app.evaluate(() => (globalThis as PickerProbe).infinitaryPickerOpenedAt ?? []);
}

async function openProjectsSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  return settingRow(page, "projects-folder");
}

async function ask(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

function initGitRepo(): string {
  const dir = scratchDir("infinitary-origin-");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );
  return dir;
}

test("new projects go in the folder chosen in Settings, and the choice survives a restart", async () => {
  const homeDir = scratchDir("infinitary-home-");
  const mockProvider: MockProviderServer = await startMockProvider({ scenarios: [projectSetup] });
  const chosen = realpathSync(scratchDir("infinitary-projects-"));
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchApp({ homeDir, reuseMockProvider: mockProvider });
    const { app, page, userDataDir } = launched;
    const fleet = join(userDataDir, "fleet");

    // 1. The default: the app's own folder, marked as the default.
    let row = await openProjectsSettings(page);
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(fleet);
    await expect(row.getByText("default", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Use default" })).toHaveCount(0);

    // 2. Choosing a folder: the picker opens where new projects go today,
    // and the row shows the pick once the app has kept it.
    await answerFolderPicker(app, chosen);
    await row.getByRole("button", { name: "Choose folder" }).click();
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(chosen);
    await expect(row.getByText("default", { exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Use default" })).toBeVisible();
    expect(await pickerOpenedAt(app)).toEqual([fleet]);
    expect(await page.evaluate(() => window.infinitary.repos.folder())).toEqual({
      path: chosen,
      custom: true,
    });
    await assertSettingsFits(page);
    await page.screenshot({ path: test.info().outputPath("projects-folder-chosen.png") });
    await page.keyboard.press("Escape");

    // 3. Starting and cloning projects by asking: both land in the chosen
    // folder as real repositories, and the fleet root links each.
    await ask(page, `${INIT_REPO_PROMPT_MARKER}nebula`);
    await addFromSetupCard(page, "nebula");
    await expect.poll(() => addedProjects(page), { timeout: 30_000 }).toHaveLength(1);
    await waitForFirstmateIdle(page);
    const origin = initGitRepo();
    await ask(page, `${CLONE_REPO_PROMPT_MARKER}${origin}`);
    await addFromSetupCard(page, basename(origin));
    await expect.poll(() => addedProjects(page), { timeout: 30_000 }).toHaveLength(2);
    const repos = await addedProjects(page);
    const nebula = repos.find((repo) => repo.setupKind === "init");
    const cloned = repos.find((repo) => repo.setupKind === "clone");
    expect(nebula?.path).toBe(join(chosen, "nebula"));
    expect(cloned).toMatchObject({ origin, delivery: "direct-pr" });
    expect(cloned?.path).toBe(join(chosen, cloned?.name as string));
    for (const repo of [nebula, cloned]) {
      const path = repo?.path as string;
      expect(execFileSync("git", ["-C", path, "rev-parse", "--verify", "HEAD"]).toString()).toMatch(
        /^[0-9a-f]{40}/,
      );
      const link = join(fleet, repo?.name as string);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(path);
    }
    row = await openProjectsSettings(page);
    // In the projects folder, nebula's closed row names no folder; opening it
    // shows where it is (INF-1495).
    const nebulaRow = projectRow(page, nebula?.id as string);
    await expect(projectRowWords(page, nebula?.id as string)).toHaveText([
      PROJECT_ROW_WORDS.localMerge,
    ]);
    await expect(nebulaRow.locator("[data-project-path]")).toHaveCount(0);
    await nebulaRow.getByRole("button", { expanded: false }).click();
    await expect(nebulaRow.getByLabel("Project folder")).toHaveValue(join(chosen, "nebula"));
    await page.screenshot({ path: test.info().outputPath("projects-folder-new-projects.png") });
    await page.keyboard.press("Escape");

    // 4. A restart reads the same folder.
    await launched.close();
    launched = await launchApp({ userDataDir, homeDir, reuseMockProvider: mockProvider });
    row = await openProjectsSettings(launched.page);
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(chosen);

    // 5. Back to the default: new projects go in the app's own folder
    // again, and the ones in the chosen folder stay where they are.
    await row.getByRole("button", { name: "Use default" }).click();
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(fleet);
    await expect(row.getByText("default", { exact: true })).toBeVisible();
    // nebula stays in the chosen folder, now outside the projects folder, so
    // its closed row calls it linked and shows where it is (INF-1495).
    await expect(projectRowWords(launched.page, nebula?.id as string)).toHaveText([
      PROJECT_ROW_WORDS.linked,
      PROJECT_ROW_WORDS.localMerge,
    ]);
    await expect(
      projectRow(launched.page, nebula?.id as string).locator("[data-project-path]"),
    ).toHaveText(join(chosen, "nebula"));
    await launched.page.screenshot({ path: test.info().outputPath("projects-folder-default.png") });
    await launched.page.keyboard.press("Escape");
    await ask(launched.page, `${INIT_REPO_PROMPT_MARKER}comet`);
    await addFromSetupCard(launched.page, "comet");
    await expect
      .poll(() => (launched ? addedProjects(launched.page) : undefined), {
        timeout: 30_000,
      })
      .toHaveLength(3);
    const after = await launched.page.evaluate(() => window.infinitary.repos.list());
    expect(after.find((repo) => repo.name === "comet")?.path).toBe(join(fleet, "comet"));
    expect(lstatSync(join(fleet, "comet")).isDirectory()).toBe(true);
    expect(after.find((repo) => repo.name === "nebula")?.path).toBe(join(chosen, "nebula"));
    expect(existsSync(join(chosen, "nebula", ".git"))).toBe(true);
  } finally {
    await launched?.close();
    await mockProvider.close();
  }
});

test("a cancelled pick changes nothing, and a folder the app cannot use is refused beside the row", async () => {
  const launched = await launchApp();
  const { app, page, userDataDir } = launched;
  try {
    const fleet = join(userDataDir, "fleet");
    const row = await openProjectsSettings(page);
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(fleet);

    // Cancelled: nothing is saved and nothing is said.
    await answerFolderPicker(app, null);
    await row.getByRole("button", { name: "Choose folder" }).click();
    await expect.poll(() => pickerOpenedAt(app)).toHaveLength(1);
    await expect(row.getByRole("button", { name: "Choose folder" })).toBeEnabled();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(fleet);

    // Inside the app's own data: refused with the reason, and the row keeps
    // the folder it had.
    const inside = join(userDataDir, "infinitary-not-here");
    mkdirSync(inside, { recursive: true });
    await answerFolderPicker(app, inside);
    await row.getByRole("button", { name: "Choose folder" }).click();
    await assertReadableSettingsFeedback(
      row.getByRole("alert"),
      "is inside Infinitary's own data. Choose a folder outside it.",
    );
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(fleet);
    expect(await page.evaluate(() => window.infinitary.repos.folder())).toEqual({
      path: fleet,
      custom: false,
    });
    await page.screenshot({ path: test.info().outputPath("projects-folder-refused.png") });
  } finally {
    await launched.close();
  }
});

test("a refused clone offers Firstmate's sign-in way and opens Projects with a code", async () => {
  const github = await startGitHubStub();
  const mockProvider = await startMockProvider({ scenarios: [projectSetup] });
  const origin = "https://github.com/octo/private.git";
  const missing = join(scratchDir("infinitary-clone-refusal-"), "missing.git");
  const launched = await launchApp({
    reuseMockProvider: mockProvider,
    env: github.env,
    prepareHome: gitCloneHome(origin, missing),
  });
  try {
    const { page } = launched;
    await openProjectsSettings(page);
    const add = page.locator("[data-add-project]");
    await add.getByRole("button", { name: "GitHub repo", exact: true }).click();
    await add.getByLabel("Paste a GitHub link").fill(origin);
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add.getByRole("status")).not.toBeEmpty();
    expect(
      (await page.evaluate(() => window.infinitary.repos.list())).some(
        (repo) => repo.origin === origin,
      ),
    ).toBe(false);
    await page.screenshot({ path: test.info().outputPath("clone-settings-refusal.png") });
    await page.keyboard.press("Escape");
    await ask(page, `${CLONE_REPO_PROMPT_MARKER}${origin}`);
    await addFromSetupCard(page, "private");
    const signIn = page.getByRole("button", { name: "Sign in to GitHub", exact: true });
    await expect(signIn).toBeVisible();
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    expect(
      cards.some((card) =>
        card.actions?.some(
          (action) =>
            action.effect?.kind === "open" &&
            action.effect.target === "projects" &&
            action.effect.signIn === "github.com",
        ),
      ),
    ).toBe(true);
    // Wait for the card body to paint before capturing visual evidence.
    await cardBody(page, "Sign in before cloning your project").locator("p").first().waitFor();
    await page.screenshot({ path: test.info().outputPath("clone-firstmate-sign-in.png") });
    await signIn.click();
    await expect(page.locator("[data-forge-code]")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("clone-sign-in-code.png") });
    await page.locator("[data-forge-flow]").getByRole("button", { name: "Cancel" }).click();
  } finally {
    writeFileSync(
      test.info().outputPath("clone-provider-requests.json"),
      JSON.stringify(
        mockProvider.requestBodies().map((body) => JSON.parse(body)),
        null,
        2,
      ),
    );
    await launched.close();
    await mockProvider.close();
    await github.close();
  }
});
