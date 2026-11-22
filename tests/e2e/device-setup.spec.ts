import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { startComputerAccounts } from "../../src/core/helper/accounts";
import { joinHome } from "../../src/core/helper/join";
import { startSignIns } from "../../src/core/helper/signIns";
import { configureGitSignIn } from "../../src/core/hostEnv";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import {
  DEVICE_SETUP_ACTIONS,
  deviceForgeSignInTitle,
  deviceForgeWaitLine,
  deviceSetupCardId,
  deviceSetupDoneLine,
  deviceSetupTitle,
} from "../../src/shared/deviceSetup";
import { INTEGRATIONS_WORDS } from "../../src/shared/integrations";
import { signInPlace } from "../../src/shared/signIns";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, STUB_USER_CODE, startGitHubStub } from "./githubStub";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { openProject } from "./projects";
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
  const startWork = async () => {
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
    await expect
      .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");
    return started.run;
  };
  return { page, deviceId: joined.grant.deviceId, work: await startWork(), startWork };
}

/** Playwright's words for a read whose page was replaced before it answered. */
const PAGE_REPLACED = /Execution context was destroyed/;

/**
 * Read and compare all row states from one snapshot of the shown card body.
 * The host revises the card while the computer connects and reports its
 * sign-ins, and each revision loads a new page into the body's frame. A read
 * that page replaces fails, and `expect.poll` does not look again after its
 * callback throws, so that read answers the failure's words and the poll
 * reads the next page.
 */
async function expectRows(page: Page, expected: readonly string[]): Promise<void> {
  const items = cardBody(shownCard(page, CARD), CARD).locator("[data-setup-row]");
  await expect
    .poll(() =>
      items
        .evaluateAll((elements) =>
          elements.map(
            (element) =>
              `${element.getAttribute("data-setup-row")}:${element.getAttribute("data-done")}`,
          ),
        )
        .catch((error: unknown) => {
          if (error instanceof Error && PAGE_REPLACED.test(error.message)) return [error.message];
          throw error;
        }),
    )
    .toEqual(expected);
}

async function setupCard(page: Page, deviceId: string) {
  const id = deviceSetupCardId(deviceId);
  const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (entry) => entry.id === id,
  );
  if (!card) throw new Error(`No setup card ${id} is up`);
  return card;
}

async function setupAction(page: Page, deviceId: string, id: string) {
  const action = (await setupCard(page, deviceId)).actions.find((entry) => entry.id === id);
  if (!action) throw new Error(`The setup card has no ${id} action`);
  return action;
}

async function runProjectThere(page: Page, deviceId: string): Promise<void> {
  const { repo } = await page.evaluate(
    (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
    githubProject(),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  const row = await openProject(page, repo.id);
  await row.getByRole("combobox", { name: "Runs on" }).selectOption(deviceId);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.repos.list())).find(
          (entry) => entry.name === "website",
        )?.runsOn,
    )
    .toBe(deviceId);
  // Escape goes back to the list, then closes Settings.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

test("a computer that joins gets its setup card, whose buttons open each step, revised as each need is met until it comes down done", async () => {
  const { page, deviceId } = await homeAndComputer();

  await test.step("the card is up at join, every row open", async () => {
    await expect(shownCard(page, CARD)).toBeVisible();
    await expectRows(page, ["subscription:false", "github:false", "project:false"]);
  });

  await test.step("Add a subscription opens Intelligence; a sign-in there marks the row done", async () => {
    const { label } = await setupAction(page, deviceId, DEVICE_SETUP_ACTIONS.subscription);
    await page.getByRole("button", { name: label, exact: true }).click();
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
    await expect(shownCard(page, CARD)).toBeVisible();
    await expectRows(page, ["subscription:true", "github:false", "project:false"]);
    expect((await setupCard(page, deviceId)).actions.map((action) => action.id)).not.toContain(
      DEVICE_SETUP_ACTIONS.subscription,
    );
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  });

  await test.step("Sign in to GitHub opens Integrations with the computer's sign-in started; its code approved marks the row done", async () => {
    await page
      .getByRole("button", { name: `Sign in to GitHub ${PLACE.where}`, exact: true })
      .click();
    // The computer's own GitHub sign-in is only in Integrations (the captain's word).
    await expect(
      page.getByRole("tab", { name: INTEGRATIONS_WORDS.title, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const forgeRow = page.locator(`[data-device-forge-row="${deviceId}"]`);
    const aside = page.locator('[data-device-sign-in-provider="github.com"]');
    await expect(aside.locator("[data-device-sign-in-code]")).toHaveText(STUB_USER_CODE);
    github?.device.approve("gho_e2e_computer_1350");
    await expect(forgeRow).toHaveAttribute("data-forge-state", "ok");
    await page.keyboard.press("Escape");
    await expect(shownCard(page, CARD)).toBeVisible();
    await expectRows(page, ["subscription:true", "github:true", "project:false"]);
  });

  await test.step("a project set to run there is the last row: the card comes down, and the feed says it is set up", async () => {
    await runProjectThere(page, deviceId);
    await expectNoCard(page, CARD);
    await expect(
      feedLine(page, deviceSetupDoneLine({ place: PLACE, runs: ["website"] })),
    ).toBeVisible();
  });
});

// INF-4843: only a changed setup need, not a connection change, returns an answered card.
test("an answered setup card stays closed across reconnect until a setup need changes", async () => {
  const { page, deviceId, work, startWork } = await homeAndComputer();
  const signIns = () =>
    page.evaluate(
      async (id) =>
        (await window.infinitary.devices.signIns()).find((device) => device.deviceId === id),
      deviceId,
    );
  const cardId = deviceSetupCardId(deviceId);
  const cardIsUp = () =>
    page.evaluate(
      async (id) => (await window.infinitary.cards.list()).some((card) => card.id === id),
      cardId,
    );

  await expectRows(page, ["subscription:false", "github:false", "project:false"]);
  const { label } = await setupAction(page, deviceId, DEVICE_SETUP_ACTIONS.subscription);
  const before = await signIns();
  if (before?.asOf === undefined) throw new Error("The computer has not reported its sign-ins");
  await shownCard(page, CARD).getByRole("button", { name: label, exact: true }).click();
  await expectNoCard(page, CARD);
  await page.keyboard.press("Escape");

  await work.stop();
  await expect.poll(async () => (await signIns())?.reach).toBe("out-of-reach");
  expect(await cardIsUp()).toBe(false);
  await startWork();
  await expect.poll(async () => (await signIns())?.asOf ?? 0).toBeGreaterThan(before.asOf);
  expect(await cardIsUp()).toBe(false);

  await runProjectThere(page, deviceId);
  await expectRows(page, ["subscription:false", "github:false", "project:true"]);
  expect((await setupCard(page, deviceId)).id).toBe(cardId);
});

test("Not now takes the setup card down for good, and a GitHub project set to run there then raises the GitHub card until the computer signs in", async () => {
  const { page, deviceId } = await homeAndComputer();
  await expect(shownCard(page, CARD)).toBeVisible();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expectNoCard(page, CARD);

  await runProjectThere(page, deviceId);
  await expect(feedLine(page, deviceForgeWaitLine("website's next task", PLACE.who))).toBeVisible();
  const forgeCard = deviceForgeSignInTitle(PLACE.where);
  await expect(shownCard(page, forgeCard)).toBeVisible();
  await expectNoCard(page, CARD);

  await page.getByRole("button", { name: forgeCard, exact: true }).click();
  await expect(
    page.getByRole("tab", { name: INTEGRATIONS_WORDS.title, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
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
