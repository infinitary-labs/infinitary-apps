import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { startComputerAccounts } from "../../src/core/helper/accounts";
import { joinHome } from "../../src/core/helper/join";
import { type HelperRun, startHelper } from "../../src/core/helper/run";
import { startSignIns } from "../../src/core/helper/signIns";
import { configureGitSignIn } from "../../src/core/hostEnv";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import {
  deviceForgeSignInTitle,
  deviceForgeWaitLine,
  deviceSetupDoneLine,
  deviceSetupTitle,
} from "../../src/shared/deviceSetup";
import { signInPlace } from "../../src/shared/signIns";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, STUB_USER_CODE, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { feedLine } from "./rails";
import { expectNoCard, shownCard } from "./stack";

/**
 * Finishing a computer's setup (docs/devices.md, "Finishing its setup";
 * design skill `components/devices/FinishSetup`): the moment a computer
 * that runs work joins, the host files one card from typed facts, one row
 * per thing it still needs, each with the button that opens that step in
 * Settings. The card is revised as the computer reports a sign-in and a
 * project is set to run there, and comes down by itself once every row is
 * done. Not now takes it down for good, and a project that lives on GitHub
 * set to run on a computer with no GitHub sign-in of its own then raises
 * the GitHub card instead (`components/devices/SignInOnAMac`).
 *
 * The home is the built app. The computer is the helper as the work mode
 * composes it, in this test's own process, joined as another macOS user on
 * this Mac; GitHub is the local stand-in, and the project's origin names
 * GitHub without anything reaching it.
 */

const KEY = "sk-or-v1-e2e-setup-key-1350";
const ASKPASS = join(process.cwd(), "resources", "git-askpass");
const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };
/** How the home's words place another user on this Mac. */
const PLACE = signInPlace({ name: "Mac mini", user: BUILDER.name, onThisMac: true });
const CARD = deviceSetupTitle(PLACE);

let github: GitHubStub | undefined;
const runs: HelperRun[] = [];
const apps: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await catalogRefreshesSettled();
  for (const app of apps.splice(0)) await app.close();
  await github?.close();
  github = undefined;
  delete process.env.INFINITARY_GITHUB_OAUTH_URL;
  delete process.env.INFINITARY_GITHUB_API_URL;
  configureGitSignIn(undefined);
});

/** A project that lives on GitHub, as a clone here whose origin names it; nothing reaches GitHub. */
function githubProject(): string {
  const root = scratchDir("infinitary-e2e-device-setup-");
  const website = join(root, "website");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });
  git(root, ["init", "--quiet", "--initial-branch=main", website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  git(website, ["add", "-A"]);
  git(website, ["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "commit", "-qm", "start"]);
  git(website, ["remote", "add", "origin", "https://github.com/octo/website.git"]);
  return website;
}

/** The home, and a computer joined to it as another user on this Mac, running with no sign-ins. */
async function homeAndComputer() {
  process.env.PI_OFFLINE = "1";
  github = await startGitHubStub();
  Object.assign(process.env, github.env);
  const app = await launchApp({ withMockProvider: true, env: github.env });
  apps.push(app);
  const { page } = app;
  const invite = await page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const dataDir = scratchDir("infinitary-e2e-computer-");
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    gitAskpass: ASKPASS,
    signIns: (start) =>
      startSignIns({
        ...start,
        accounts: (accountsOptions) =>
          startComputerAccounts({
            ...accountsOptions,
            clock: false,
            claude: { available: () => false },
          }),
      }),
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect.poll(() => started.run.state().contact).toBe("in-reach");
  return { page, deviceId: joined.grant.deviceId };
}

/** The card's rows, by id and whether each is done, read from the facts the body carries. */
async function rows(page: Page): Promise<string[]> {
  const items = cardBody(page, CARD).locator("[data-setup-row]");
  await expect(items).toHaveCount(3);
  return items.evaluateAll((elements) =>
    elements.map(
      (element) => `${element.getAttribute("data-setup-row")}:${element.getAttribute("data-done")}`,
    ),
  );
}

/** Adopts the GitHub project and sets it to run on the computer, from Settings -> Projects' Runs on. */
async function runProjectThere(page: Page, deviceId: string): Promise<void> {
  const { repo } = await page.evaluate(
    (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
    githubProject(),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  const row = page.locator(`[data-project="${repo.id}"]`);
  await row.getByRole("button", { name: /^website, / }).click();
  await row.getByRole("combobox", { name: "Runs on" }).selectOption(deviceId);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.repos.list())).find(
          (entry) => entry.name === "website",
        )?.runsOn,
    )
    .toBe(deviceId);
  await page.keyboard.press("Escape");
}

test("a computer that joins gets its setup card, whose buttons open each step, revised as each need is met until it comes down done", async () => {
  const { page, deviceId } = await homeAndComputer();

  await test.step("the card is up at join, every row open", async () => {
    await expect(shownCard(page, CARD)).toBeVisible();
    expect(await rows(page)).toEqual(["subscription:false", "github:false", "project:false"]);
  });

  await test.step("Add a subscription opens Intelligence; a sign-in there marks the row done", async () => {
    await page.getByRole("button", { name: "Add a subscription", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Intelligence", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
    await group.locator('[data-connect-provider="openrouter"]').click();
    await group.getByRole("button", { name: "API key", exact: true }).click();
    const aside = group.locator('[data-device-sign-in-provider="openrouter"]');
    await aside.getByLabel(`The key for ${PLACE.who}`).fill(KEY);
    await aside.getByRole("button", { name: `Send to ${PLACE.who}`, exact: true }).click();
    await expect(group.locator("[data-account-row]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    // The card is back, revised: the subscription row done, the others open.
    await expect(shownCard(page, CARD)).toBeVisible();
    expect(await rows(page)).toEqual(["subscription:true", "github:false", "project:false"]);
    await expect(page.getByRole("button", { name: "Add a subscription", exact: true })).toHaveCount(
      0,
    );
  });

  await test.step("Sign in to GitHub opens Projects with the computer's sign-in started; its code approved marks the row done", async () => {
    await page
      .getByRole("button", { name: `Sign in to GitHub ${PLACE.where}`, exact: true })
      .click();
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const forgeRow = page.locator(`[data-device-forge-row="${deviceId}"]`);
    const aside = page.locator('[data-device-sign-in-provider="github.com"]');
    await expect(aside.locator("[data-device-sign-in-code]")).toHaveText(STUB_USER_CODE);
    github?.device.approve("gho_e2e_computer_1350");
    await expect(forgeRow).toHaveAttribute("data-forge-state", "ok");
    await page.keyboard.press("Escape");
    await expect(shownCard(page, CARD)).toBeVisible();
    expect(await rows(page)).toEqual(["subscription:true", "github:true", "project:false"]);
  });

  await test.step("a project set to run there is the last row: the card comes down, and the feed says it is set up", async () => {
    await runProjectThere(page, deviceId);
    await expectNoCard(page, CARD);
    await expect(
      feedLine(
        page,
        deviceSetupDoneLine({ deviceId, place: PLACE, signIns: null, runs: ["website"] }),
      ),
    ).toBeVisible();
  });
});

test("Not now takes the setup card down for good, and a GitHub project set to run there then raises the GitHub card until the computer signs in", async () => {
  const { page, deviceId } = await homeAndComputer();
  await expect(shownCard(page, CARD)).toBeVisible();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expectNoCard(page, CARD);

  // Runs on names a computer with no GitHub sign-in of its own: the feed
  // says its next task waits for it, and the GitHub card asks for it.
  await runProjectThere(page, deviceId);
  await expect(feedLine(page, deviceForgeWaitLine("website's next task", PLACE.who))).toBeVisible();
  const forgeCard = deviceForgeSignInTitle(PLACE.where);
  await expect(shownCard(page, forgeCard)).toBeVisible();
  // The setup card stays down: Not now meant it.
  await expectNoCard(page, CARD);

  // Its one button opens Projects with that sign-in started; the code
  // approved on GitHub's page takes the card down.
  await page.getByRole("button", { name: forgeCard, exact: true }).click();
  const aside = page.locator('[data-device-sign-in-provider="github.com"]');
  await expect(aside.locator("[data-device-sign-in-code]")).toHaveText(STUB_USER_CODE);
  github?.device.approve("gho_e2e_computer_1350");
  await expect(page.locator(`[data-device-forge-row="${deviceId}"]`)).toHaveAttribute(
    "data-forge-state",
    "ok",
  );
  await page.keyboard.press("Escape");
  await expectNoCard(page, forgeCard);
  await expectNoCard(page, CARD);
});
