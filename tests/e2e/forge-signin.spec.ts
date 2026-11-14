import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cardLabelKey, parsePlainLabelRows } from "../../scripts/interaction-metrics";
import {
  parseApiRequest,
  presentationCommitMessage,
  presentationMarkdown,
} from "../../src/core/forge";
import { MERGE_WRITE_REFUSAL } from "../../src/core/forge/apiWriteGuard";
import { SYNC_CAP_MS } from "../../src/core/jobs/jobManager";
import { PERSONAL_WORKSPACE_NAME } from "../../src/core/paths";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import {
  FORGE_CLI_WORDS,
  FORGE_SECTION_WORDS,
  forgeKeyPage,
  forgeKeyProblemText,
  forgeRefusedText,
  forgeSignInTitle,
  GITHUB_ENTERPRISE,
  LOCAL_PROJECTS_UNAFFECTED,
} from "../../src/shared/forges";
import { INTEGRATIONS_WORDS } from "../../src/shared/integrations";
import {
  CHECK_WORDS,
  MERGE_WORDS,
  PROJECT_DELIVERY_WORDS,
  sendWriteWords,
} from "../../src/shared/vocabulary";
import { NEVER_SENT_AGAIN } from "../../src/shared/writeAsk";
import { BUNDLED_NAMING } from "../helpers/namingRunbook";
import { scratchDir } from "../helpers/scratchDirs";
import {
  API_WRITE_GUARD_MARKER,
  mergeWriteCases,
  PAGED_REPOSITORY,
  READS_ANYWHERE_MARKER,
  savedWriteAsks,
  WRITE_ASK_ANSWER_MARKER,
  WRITE_ASK_CARD_TITLE,
  WRITE_ASK_MARKER,
  writeAskCall,
} from "./apiWriteCases";
import { cardBody } from "./frames";
import {
  type GitHubStub,
  STUB_JOB_FAILURE_LINE,
  STUB_LOGIN,
  STUB_NOTIFICATION_TITLE,
  STUB_SECOND_PAGE_TITLE,
  STUB_USER_CODE,
  seedGitHubSignIn,
  startGitHubStub,
  stubRefreshToken,
  stubRenewedToken,
} from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, overflows, resizeWindow, within } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { addedProjects } from "./projects";
import { promptInput } from "./prompt";
import { putInLine } from "./rails";
import { readSavedData } from "./savedData";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  CONTINUE_CHANGE_CARD_TITLE,
  CONTINUE_CHANGE_PROMPT_MARKER,
  CONTINUE_CHANGE_TITLE,
  continueChange,
  MOCK_CONTINUE_CHANGE,
  MOCK_CONTINUE_STORY,
} from "./scenarios/continueChange";
import {
  forgeSignin,
  LOCATE_PROJECTS_PROMPT_MARKER,
  MOCK_LOCATED_CARD_TITLE,
  MOCK_PROJECT_LIVES_CARD_TITLE,
  PROJECT_LIVES_PROMPT_MARKER,
  WORKFLOW_DISPATCH_MARKER,
  WORKFLOW_EVIDENCE_MARKER,
} from "./scenarios/forgeSignin";
import { forgeSigninReads } from "./scenarios/forgeSigninReads";
import {
  GITHUB_CHANGE_PROMPT_MARKER,
  githubChange,
  MOCK_GITHUB_CHANGE,
  MOCK_GITHUB_CHANGE_CARD_TITLE,
} from "./scenarios/githubChange";
import { mergeWriteGuard } from "./scenarios/mergeWriteGuard";
import { assertSettingsFits } from "./settings";
import { clickInBody, expectNoCard, factsStrip, noteDone, shownCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * The app's own GitHub sign-in (git integration PR 1.2, `docs/forge.md`),
 * the way a person meets it. GitHub is a local stand-in (`./githubStub.ts`)
 * that speaks GitHub's device flow and REST API; the app runs its real
 * sign-in service, its real forge, its real health read, its real git
 * helper and its real Settings section against it. Nothing here reaches
 * github.com, opens a browser, or raises a keychain or password prompt:
 * the system browser is replaced in the main process by a recorder, and
 * every push goes to a bare repository on this Mac through git's own
 * `insteadOf`.
 *
 * Settings -> Integrations offers the sign-in as optional, and Settings ->
 * Projects points there (INF-775, the captain's q2); a code the person
 * cancels, refuses on GitHub, or lets run out ends quietly or with a fresh
 * code on request; an approved code signs in and the row says who; the
 * Firstmate lists the projects there; a crewmate sends its branch up, opens
 * the proposed change and reads its checks with its own two tools, and the
 * captain's click puts it in on GitHub; when GitHub stops accepting the
 * sign-in, the one host card appears, its "Sign in again" lands on the code
 * in Settings and approving it takes the card down; a project kept on this
 * Mac never names a host; and signing out leaves the one quiet line.
 *
 * Each test arranges its own app, projects and stand-in (`arrange`). The
 * device flow is the first test's subject; every other test that needs a
 * sign-in starts with one already made (`seedGitHubSignIn`), so no test
 * borrows an earlier one's sign-in, change or health log (docs/testing.md).
 */

/** The hand-scored plain-language sample (roadmap 1.5). */
const PLAIN_LABELS = join(process.cwd(), "tests", "fixtures", "plain-language", "labels.jsonl");

/** The host's one card for a sign-in GitHub refused. */
const SIGN_IN_AGAIN = forgeSignInTitle("GitHub");

/** How many open cards the core holds under `title`. */
async function cardsTitled(page: Page, title: string): Promise<number> {
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  return cards.filter((card) => card.title === title).length;
}

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

let launched: LaunchedApp;
let github: GitHubStub;
let userDataDir: string;
let bare: string;
/** Stops what this test started, however it ended. */
let stop: (() => Promise<void>) | undefined;

/** A project whose origin is on GitHub while every push lands on a bare repository here. */
function seedGitHubProject(dir: string, origin: string, remote?: string) {
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".github/workflows/verify.yml"),
    "name: verify\non:\n  workflow_dispatch:\n    inputs:\n      profile:\n        type: string\n      perf:\n        type: boolean\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo verified\n",
  );
  git("-C", dir, "add", ".github/workflows/verify.yml");
  git("-C", dir, "commit", "-m", "chore: seed verification");
  git("-C", dir, "remote", "add", "origin", origin);
  if (remote) {
    git("-C", dir, "config", `url.${remote}.insteadOf`, origin);
    git("-C", dir, "push", "origin", "HEAD:refs/heads/main");
  }
}

/**
 * A fresh app over two projects on GitHub - meterlab, whose pushes land on a
 * bare repository here, and ledger, which the captain keeps on this Mac -
 * and a fresh GitHub stand-in. With `signedIn`, the app starts with its
 * sign-in already made and the test waits until GitHub has answered it.
 * With `host`, the projects and the stand-in live on that GitHub
 * Enterprise host instead, which the app does not know yet.
 */
async function arrange({
  signedIn,
  host = "github.com",
  keptHere = false,
  githubCli,
}: {
  signedIn: boolean;
  host?: string;
  /** A stand-in GitHub CLI the app finds on this computer, by its path. */
  githubCli?: string;
  /** Also a project with no origin at all, kept on this computer: notebook. */
  keptHere?: boolean;
}): Promise<void> {
  userDataDir = scratchDir("infinitary-forge-signin-");
  bare = join(userDataDir, "github-meterlab.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const meterlab = join(userDataDir, "meterlab");
  seedGitHubProject(meterlab, `https://${host}/octo/meterlab.git`, bare);
  const ledger = join(userDataDir, "ledger");
  seedGitHubProject(ledger, `https://${host}/octo/ledger.git`);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: meterlab,
    name: "meterlab",
    setupKind: "clone",
    origin: `https://${host}/octo/meterlab.git`,
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
    addedAt: 1,
  });
  // On GitHub, but the captain keeps it on this Mac.
  seedProject(db, {
    id: "repo-ledger",
    path: ledger,
    name: "ledger",
    setupKind: "clone",
    origin: `https://${host}/octo/ledger.git`,
    runsOn: null,
    delivery: "local-only",
    rigor: "quick",
    addedAt: 2,
  });
  if (keptHere) {
    const notebook = join(userDataDir, "notebook");
    git("init", "--initial-branch=main", notebook);
    git("-C", notebook, "config", "user.name", "Test");
    git("-C", notebook, "config", "user.email", "test@localhost");
    git("-C", notebook, "commit", "--allow-empty", "-m", "init");
    seedProject(db, {
      id: "repo-notebook",
      path: notebook,
      name: "notebook",
      setupKind: "clone",
      delivery: "local-only",
      rigor: "quick",
      addedAt: 3,
    });
  }
  db.close();
  if (signedIn) seedGitHubSignIn(userDataDir);

  github = await startGitHubStub({ host });
  stop = () => github.close();
  github.setProjects([
    { fullName: "octo/meterlab", private: true, updatedAt: "2026-09-22T10:00:00Z" },
    { fullName: "octo/website", updatedAt: "2026-09-01T10:00:00Z" },
  ]);
  github.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [githubChange, continueChange, forgeSignin, forgeSigninReads, mergeWriteGuard],
    userDataDir,
    env: { ...github.env, ...(githubCli ? { INFINITARY_GITHUB_CLI: githubCli } : {}) },
  });
  // `launched` is read when the test ends, so a relaunch is the one stopped.
  stop = async () => {
    await launched.close();
    await github.close();
  };
  // The system browser, replaced by a recorder: nothing here opens a page.
  await launched.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  if (signedIn) {
    await expect
      .poll(() => signInStates(launched.page), { timeout: 15_000 })
      .toEqual([["github.com", "ok"]]);
  }
}

test.afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** Each sign-in's host and health, off the typed surface Settings renders. */
function signInStates(page: Page): Promise<[string, string][]> {
  return page.evaluate(async () =>
    (await window.infinitary.forges.list()).signIns.map((signIn): [string, string] => [
      signIn.host,
      signIn.state,
    ]),
  );
}

/**
 * The health log's lines without their dates. Every sign-in, change of
 * health and sign-out leaves one dated line with GitHub's answer - never
 * the sign-in itself - and the log outlives signing out.
 */
function healthLines(): string[] {
  const healthLog = readFileSync(join(userDataDir, "forges", "health.log"), "utf8");
  expect(healthLog).not.toMatch(/gh[or]_/);
  const lines = healthLog.trimEnd().split("\n");
  for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
  return lines.map((line) => line.slice(line.indexOf(" ") + 1));
}

async function openProjects(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
}

/** Settings -> Integrations, where the github.com sign-in lives (INF-775, the captain's q2). */
async function openIntegrations(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: INTEGRATIONS_WORDS.title }).click();
}

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** The tab that holds GitHub's sign-in. */
const section = (page: Page) => page.locator("[data-integrations]");

test("Settings -> Integrations offers the GitHub sign-in as optional, and each way a code can end", async () => {
  await arrange({ signedIn: false });
  const { page } = launched;
  // GitHub's sign-in is only in Integrations; that Projects holds none is
  // device-sign-ins.spec.ts's, with a computer's own row there too.
  await openIntegrations(page);
  const forges = section(page);
  expect(await signInStates(page)).toEqual([]);
  await expect(forges).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("forge-signin-optional.png") });

  // The chip starts GitHub's device flow; the aside shows the code, and
  // "Open GitHub" hands GitHub's page to the system browser.
  const chip = page.getByRole("button", { name: "Sign in to GitHub", exact: true });
  await chip.click();
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE);
  await page.screenshot({ path: test.info().outputPath("forge-signin-code.png") });
  await forges.getByRole("button", { name: "Open GitHub" }).click();
  await expect
    .poll(() =>
      launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []),
    )
    .toEqual([`${github.url}/login/device`]);

  // Cancel: the code is gone and nothing else changed.
  await forges.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-forge-flow]")).toHaveCount(0);
  await expect(page.locator("[data-integrations-quiet]")).toBeVisible();

  // The person says no on GitHub's page: quiet - the aside simply closes.
  await chip.click();
  await expect(page.locator("[data-forge-code]")).toBeVisible();
  github.device.deny();
  await expect(page.locator("[data-forge-flow]")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-forge-ended]")).toHaveCount(0);
  await expect(page.locator("[data-forge-row]")).toHaveCount(0);

  // The code runs out: said plainly, with a fresh one on request.
  await chip.click();
  await expect(page.locator("[data-forge-code]")).toBeVisible();
  github.device.expire();
  await expect(page.locator('[data-forge-ended="expired"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Get a new code" }).click();
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE);

  // Approved on GitHub: the row says who, and the quiet line and chip go.
  github.device.approve();
  const row = page.locator('[data-forge-row="github.com"]');
  await expect(row).toContainText("GitHub", { timeout: 15_000 });
  await expect(row).toContainText(STUB_LOGIN);
  await expect(row).toHaveAttribute("data-forge-state", "ok");
  await expect(page.locator("[data-integrations-quiet]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in to GitHub", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("forge-signin-signed-in.png") });

  // The sign-in lives in its own 0700 folder and 0600 file, and no surface
  // the window reads ever carries it.
  const dir = join(userDataDir, "forges", "github.com");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "sign-in.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, "sign-in.json"), "utf8")).toContain("gho_e2e_sign_in");
  const view = await page.evaluate(() => window.infinitary.forges.list());
  expect(JSON.stringify(view)).not.toContain("gho_");
  // Only the sign-in left a line: a cancelled, refused or expired code did not.
  expect(healthLines()).toEqual(["github.com sign-in none -> ok (signed in, answered 200)"]);

  // The words: nothing a person reads here names the machinery.
  const words = (await forges.innerText()).toLowerCase();
  for (const never of ["token", "credential", "oauth", "keyring", "device code", " cli", " gh "]) {
    expect(words, never).not.toContain(never);
  }
  await page.keyboard.press("Escape");
});

/** A private clipboard stand-in: no test reads or changes the person's clipboard. */
type CopyProbe = { writes: string[]; finish?: (success: boolean) => void };
const copyProbe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fmCopy: CopyProbe }).__fmCopy.writes);
const finishCopy = (page: Page, success: boolean) =>
  page.evaluate(
    (ok) => (window as unknown as { __fmCopy: CopyProbe }).__fmCopy.finish?.(ok),
    success,
  );

test("the GitHub code can be copied by keyboard, with honest feedback scoped to the current code", async () => {
  await arrange({ signedIn: false });
  const { page } = launched;
  await openIntegrations(page);
  await page.evaluate(() => {
    const probe: CopyProbe = { writes: [] };
    (window as unknown as { __fmCopy: CopyProbe }).__fmCopy = probe;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          probe.writes.push(text);
          return new Promise<void>((resolve, reject) => {
            probe.finish = (ok) => (ok ? resolve() : reject(new Error("Clipboard unavailable")));
          });
        },
      },
    });
  });
  const forges = section(page);
  const chip = page.getByRole("button", { name: "Sign in to GitHub", exact: true });
  const code = page.locator("[data-forge-code]");
  const copy = forges.getByRole("button", { name: "Copy code", exact: true });
  const feedback = forges.getByRole("status");
  const open = forges.getByRole("button", { name: "Open GitHub" });
  await chip.click();
  await expect(code).toHaveText(STUB_USER_CODE);
  await expect(feedback).toHaveAttribute("aria-live", "polite");
  await expect(feedback).toHaveAttribute("aria-atomic", "true");

  // The button is beside the code and reachable in the normal tab order.
  await pressKey(open, "Shift+Tab");
  await expect(copy).toBeFocused();
  await copy.press("Enter");
  const copying = forges.getByRole("button", { name: "Copying...", exact: true });
  await expect(copying).toBeDisabled();
  await expect(copying).toHaveAttribute("aria-busy", "true");
  await expect(feedback).toBeEmpty(); // pending is not success
  expect(await copyProbe(page)).toEqual([STUB_USER_CODE]);
  expect(github.exchanges()).toBe(0);
  await finishCopy(page, true);
  await expect(feedback).toHaveText(FORGE_SECTION_WORDS.copied);
  await expect(copy).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("forge-copy-success.png") });

  // A rejected write says so, leaves the code selectable and permits retry.
  await copy.press("Space");
  await expect(feedback).toBeEmpty();
  await finishCopy(page, false);
  await expect(feedback).toHaveText(FORGE_SECTION_WORDS.copyFailed);
  await expect(code).toHaveText(STUB_USER_CODE);
  await expect(copy).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("forge-copy-failure.png") });
  await copy.click();
  await finishCopy(page, true);
  await expect(feedback).toHaveText(FORGE_SECTION_WORDS.copied);

  // A late clipboard answer for an expired code cannot confirm a fresh code.
  await copy.click();
  await expect(copying).toBeDisabled();
  github.device.expire();
  await expect(page.locator('[data-forge-ended="expired"]')).toBeVisible({ timeout: 15_000 });
  github.device.setCode("FRESH-CODE");
  await page.getByRole("button", { name: "Get a new code" }).click();
  await expect(code).toHaveText("FRESH-CODE");
  await finishCopy(page, true);
  await expect(feedback).toBeEmpty();
  await expect(copy).toBeEnabled();
  await copy.click();
  await finishCopy(page, true);
  await expect(feedback).toHaveText(FORGE_SECTION_WORDS.copied);
  expect(await copyProbe(page)).toEqual([
    STUB_USER_CODE,
    STUB_USER_CODE,
    STUB_USER_CODE,
    STUB_USER_CODE,
    "FRESH-CODE",
  ]);

  // An absent clipboard API is also an honest failure; narrow layout still fits.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  await copy.click();
  await expect(feedback).toHaveText(FORGE_SECTION_WORDS.copyFailed);
  await resizeWindow(launched.app, page, await minimumWindowSize(launched.app));
  expect(await overflows(forges)).toBe(0);
  const narrowCopy = await copy.boundingBox();
  const container = await forges.boundingBox();
  if (!narrowCopy || !container) throw new Error("Copy button or its container has no visible box");
  expect(within(narrowCopy, container)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("forge-copy-narrow.png") });
  await assertSettingsFits(page);

  // Copy never opens GitHub or signs in; the existing controls still do their jobs.
  expect(
    await launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened),
  ).toEqual([]);
  await open.click();
  expect(
    await launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened),
  ).toEqual([`${github.url}/login/device`]);
  await forges.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-forge-flow]")).toHaveCount(0);
  await chip.click();
  await expect(code).toHaveText("FRESH-CODE");
  await expect(feedback).toBeEmpty();
  github.device.approve();
  await expect(page.locator('[data-forge-row="github.com"]')).toHaveAttribute(
    "data-forge-state",
    "ok",
    { timeout: 15_000 },
  );
  expect(github.exchanges()).toBe(1);
  expect(healthLines()).toEqual(["github.com sign-in none -> ok (signed in, answered 200)"]);
});

test("a refused native clipboard write leaves the GitHub sign-in code available", async () => {
  await arrange({ signedIn: false });
  const { page } = launched;
  await launched.app.evaluate(({ BrowserWindow }) => {
    const requested: string[] = [];
    (globalThis as { __fmPermissions?: string[] }).__fmPermissions = requested;
    const session = BrowserWindow.getAllWindows()[0]?.webContents.session;
    session?.setPermissionCheckHandler(() => false);
    session?.setPermissionRequestHandler((_contents, permission, callback) => {
      requested.push(permission);
      callback(false); // no native clipboard read or write is permitted by this probe
    });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await openIntegrations(page);
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
  const forges = section(page);
  const copy = forges.getByRole("button", { name: "Copy code", exact: true });
  await focusOn(copy);
  await copy.press("Enter");
  await expect(forges.getByRole("status")).toContainText(FORGE_SECTION_WORDS.copyFailed);
  expect(
    await launched.app.evaluate(
      () => (globalThis as { __fmPermissions?: string[] }).__fmPermissions,
    ),
  ).toEqual(["clipboard-sanitized-write"]);
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE);
  await expect(copy).toBeEnabled();
  expect(github.exchanges()).toBe(0);
});

test("the Firstmate lists the projects there with the app's own sign-in", async () => {
  await arrange({ signedIn: true });
  const { page } = launched;
  await send(page, `${LOCATE_PROJECTS_PROMPT_MARKER}website`);
  const card = cardBody(page, MOCK_LOCATED_CARD_TITLE);
  await expect(card.locator("li")).toHaveText(["octo/website"], { timeout: 30_000 });
  expect(github.requests()).toContain("GET /user/repos");
  await noteDone(page).click();
});

/** The context's `lives` fact for each project, as the Firstmate was served it (PR 1.3). */
async function servedLives(page: Page): Promise<string[]> {
  await send(page, PROJECT_LIVES_PROMPT_MARKER);
  const card = cardBody(page, MOCK_PROJECT_LIVES_CARD_TITLE);
  await expect(card.locator("li").first()).toBeVisible({ timeout: 30_000 });
  // The personal workspace lives nowhere else; these journeys read the projects the captain added.
  const lives = (await card.locator("li").allTextContents()).filter(
    (line) => !line.startsWith(`${PERSONAL_WORKSPACE_NAME}:`),
  );
  await noteDone(page).click();
  // Gone from the stack, read off the cards the app holds: the feed's
  // latest-activity line still names the card it just dismissed.
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.infinitary.cards.list()).map((held) => held.title)),
    )
    .not.toContain(MOCK_PROJECT_LIVES_CARD_TITLE);
  return lives;
}

test("a crewmate opens its change on GitHub with its own tools, and the captain's click puts it in", async () => {
  await arrange({ signedIn: true });
  const { page } = launched;
  const title = `meterlab ${GITHUB_CHANGE_PROMPT_MARKER}`;
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);

  // The completion card cleared the checks gate: the change the crewmate
  // opened was found on GitHub and its checks read passed.
  await expect(shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  const task = board.tasks.find((row) => row.title === title);
  expect(task).toBeDefined();
  const branch = `fm/task-${task?.id}`;
  // The branch went up through git with the app's helper answering, and
  // the change opened on GitHub carries exactly that version.
  const sentUp = git("-C", bare, "rev-parse", `refs/heads/${branch}`);
  // The author waited for the background completion rather than repeating git.
  expect(git("-C", bare, "rev-list", "--count", `refs/heads/main..refs/heads/${branch}`)).toBe("1");
  expect(github.requests()).toContain("POST /repos/octo/meterlab/pulls");

  const frame = cardBody(page, MOCK_GITHUB_CHANGE_CARD_TITLE);
  const facts = factsStrip(frame);
  const link = facts.change.locator('a[href="https://github.com/octo/meterlab/pull/100"]');
  await expect(link).toHaveText("#100");
  await expect(facts.checks).toHaveText(CHECK_WORDS.green);
  // The pull request link beside the buttons opens the change on GitHub.
  await clickInBody(link);
  await expect
    .poll(() =>
      launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []),
    )
    .toEqual(["https://github.com/octo/meterlab/pull/100"]);
  // INF-467: the real publication path reads one short story in two tiers.
  const presentation = readSavedData(
    launched.userDataDir,
    (db) => new TaskStore(db).get(task?.id as string)?.delivery?.presentation,
  );
  expect(presentation?.revisions.at(-1)?.version).toBe(2);
  expect(presentation?.revisions.at(-1)?.title).toBe(MOCK_GITHUB_CHANGE.title);
  const published = presentation?.published?.region ?? "";
  expect(published).toContain(`- [x] ${MOCK_GITHUB_STORY.checked[0]?.check}`);
  expect(published).not.toContain(sentUp);
  // A version-two story publishes in two tiers, never the version-one form:
  // no paragraph only that form writes (its checks line, its required
  // actions and not-done headings) is in the description.
  const story = presentation?.revisions.at(-1);
  if (!story) throw new Error("No saved story revision");
  const tiered = presentationMarkdown(story, new Map(), "pending");
  const legacyOnly = presentationMarkdown({ ...story, version: 1 }, new Map(), "pending")
    .split("\n\n")
    .filter((paragraph) => paragraph.trim() && !tiered.includes(paragraph));
  expect(legacyOnly).not.toEqual([]);
  for (const paragraph of legacyOnly) expect(published).not.toContain(paragraph);
  await expect(frame.locator("li").last()).toContainText(
    MOCK_GITHUB_STORY.checked[0]?.result ?? "",
  );
  const evidence = frame.locator("details");
  await expect(evidence).toHaveCount(1);
  await expect(evidence).not.toHaveAttribute("open", "");
  await expect(evidence.locator("p")).toBeHidden();
  const pictureDir = process.env.INFINITARY_STORY_PICTURES;
  await resizeWindow(launched.app, page, { width: 1280, height: 1000 });
  await regionShot(
    shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE),
    pictureDir
      ? join(pictureDir, "card-after.png")
      : test.info().outputPath("forge-signin-completion-card.png"),
  );
  await focusOn(evidence.locator("summary"));
  await pressKey(evidence.locator("summary"), "Enter");
  await expect(evidence.locator("p")).toHaveText(MOCK_GITHUB_STORY.verification);
  if (pictureDir) {
    await regionShot(
      shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE),
      join(pictureDir, "card-details-after.png"),
    );
    writeFileSync(join(pictureDir, "published-story.md"), published);
  }

  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
  await expect(putInLine(page, task?.key as string)).toBeVisible({ timeout: 30_000 });
  // A squash of exactly the change the crewmate opened, at the version it
  // sent up, with the typed story's plain summary (captain's INF-228 F2).
  expect(github.merges()).toEqual([
    {
      number: 100,
      sha: sentUp,
      method: "squash",
      title: MOCK_GITHUB_CHANGE.title,
      message: presentationCommitMessage(MOCK_GITHUB_STORY, BUNDLED_NAMING),
    },
  ]);
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), task?.id as string))
    .toMatchObject({ status: "done", closedReason: "merged" });
});

/**
 * A stand-in GitHub CLI signed in to github.com with the stand-in GitHub's
 * own sign-in: it answers `gh auth token --hostname github.com` and logs
 * every call, as the person's own GitHub CLI would answer the app.
 */
function standInGitHubCli(): { path: string; calls: () => string[] } {
  const dir = scratchDir("infinitary-github-cli-");
  const log = join(dir, "gh-calls.log");
  const path = join(dir, "gh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1 $2 $3 $4" = "auth token --hostname github.com" ]; then echo gho_e2e_sign_in; exit 0; fi\necho "no oauth token found for $4" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  return {
    path,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
  };
}

test("an organization that blocks the app: GitHub CLI's sign-in, chosen under the code, carries a crewmate's change", async () => {
  // INF-1775, the captain: "provide an alternative way for them to connect
  // infinitary with their github, which is through gh cli which they have
  // already setup on their machine".
  const cli = standInGitHubCli();
  await arrange({ signedIn: false, githubCli: cli.path });
  const { page } = launched;
  await openIntegrations(page);
  const forges = section(page);

  // The code stays first; GitHub CLI's one line sits under it, and nothing
  // asks GitHub CLI until the person clicks.
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE);
  const line = forges.locator('[data-forge-cli="github.com"]');
  await expect(line).toContainText(FORGE_CLI_WORDS.offer);
  expect(cli.calls()).toEqual([]);
  await regionShot(
    forges.locator("[data-forge-flow]"),
    test.info().outputPath("forge-signin-github-cli-line.png"),
  );
  await line.getByRole("button", { name: FORGE_CLI_WORDS.use }).click();

  // The row says who, and through what; the code is gone.
  const row = page.locator('[data-forge-row="github.com"]');
  await expect(row).toHaveAttribute("data-forge-state", "ok", { timeout: 15_000 });
  await expect(row).toContainText(`as ${STUB_LOGIN} · ${FORGE_CLI_WORDS.through}`);
  await expect(page.locator("[data-forge-flow]")).toHaveCount(0);
  await regionShot(row, test.info().outputPath("forge-signin-github-cli-row.png"));
  expect(cli.calls()).toContain("auth token --hostname github.com");
  // The app keeps the way and the program, never GitHub CLI's sign-in.
  const file = readFileSync(join(userDataDir, "forges", "github.com", "sign-in.json"), "utf8");
  expect(file).not.toContain("gho_");
  expect(JSON.parse(file)).toMatchObject({ way: "cli", program: cli.path, login: STUB_LOGIN });
  expect(healthLines()).toEqual([
    "github.com sign-in none -> ok (signed in through GitHub CLI, answered 200)",
  ]);
  await page.keyboard.press("Escape");

  // Every GitHub reach above the sign-in is unchanged: a crewmate opens its
  // change with GitHub CLI's sign-in, and its checks clear the gate.
  const title = `meterlab ${GITHUB_CHANGE_PROMPT_MARKER}`;
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
  await expect(shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
  expect(github.requests()).toContain("POST /repos/octo/meterlab/pulls");
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  const task = board.tasks.find((entry) => entry.title === title);
  expect(
    git("-C", bare, "rev-list", "--count", `refs/heads/main..refs/heads/fm/task-${task?.id}`),
  ).toBe("1");
});

test("a crewmate cannot merge or move the default branch through raw GitHub writes", async () => {
  await arrange({ signedIn: true });
  git("-C", bare, "branch", "topic", "main");
  const title = `meterlab ${API_WRITE_GUARD_MARKER}`;
  await send(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
  let id = "";
  await expect
    .poll(
      async () => {
        const task = (
          await launched.page.evaluate(() => window.infinitary.tasks.board())
        ).tasks.find((row) => row.title === title);
        id = task?.id ?? "";
        return task?.activity;
      },
      { timeout: 45_000 },
    )
    .toBe("idle");
  const detail = await launched.page.evaluate(
    (taskId) => window.infinitary.tasks.detail(taskId),
    id,
  );
  const outcome = detail?.outcome ?? "";
  const calls = mergeWriteCases("github", "/repos/octo/meterlab");
  expect(outcome.split("(refused)").length - 1).toBe(calls.length);
  // INF-2744: the refusal points at the merge card, in its owner's words.
  expect(outcome).toContain(MERGE_WRITE_REFUSAL.split(";")[0]);
  expect(
    github.requests().filter((request) => /^(POST|PUT|PATCH|DELETE) \/repos\//.test(request)),
  ).toEqual(["PATCH /repos/octo/meterlab/git/refs/heads/topic"]);
  expect(outcome).toContain('"status": 200');
  expect(github.merges()).toEqual([]);
  const transcript = `${outcome}\n\nRequests:\n${github.requests().join("\n")}`;
  await test.info().attach("merge-api-guard", { body: transcript, contentType: "text/plain" });
  if (process.env.INFINITARY_TASK_EVIDENCE_DIR)
    writeFileSync(
      join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "github-merge-api-guard.txt"),
      transcript,
    );
});

/** The gateway's own refusal of a GraphQL read, as its request parser words it. */
function graphqlRefusal(): string {
  try {
    parseApiRequest("GET", "/graphql", null);
  } catch (caught) {
    return (caught as Error).message;
  }
  throw new Error("The gateway's request parser took a GraphQL read");
}

test("a crewmate on a project kept on this computer reads past the old list through the github.com sign-in, page by page, and never GraphQL", async () => {
  await arrange({ signedIn: true, keptHere: true });
  const title = `notebook ${READS_ANYWHERE_MARKER}`;
  await send(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
  let id = "";
  await expect
    .poll(
      async () => {
        const task = (
          await launched.page.evaluate(() => window.infinitary.tasks.board())
        ).tasks.find((row) => row.title === title);
        id = task?.id ?? "";
        return task?.activity;
      },
      { timeout: 45_000 },
    )
    .toBe("idle");
  const outcome =
    (await launched.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id))
      ?.outcome ?? "";
  // The person's notifications, which the old list kept closed, come back as GitHub answered.
  expect(outcome).toContain(STUB_NOTIFICATION_TITLE);
  // A repository listing's next page by repository id is a path the crewmate reads.
  const next = `/repositories/${PAGED_REPOSITORY.id}/pulls?per_page=1&page=2`;
  expect(outcome).toContain(`"nextPath": "${next}"`);
  expect(outcome).toContain(STUB_SECOND_PAGE_TITLE);
  expect(outcome).toContain(graphqlRefusal());
  // Every read went to GitHub with the app's sign-in; GraphQL never left the app.
  expect(github.requests()).toEqual(
    expect.arrayContaining([
      "GET /notifications",
      `GET /repos/${PAGED_REPOSITORY.fullName}/pulls`,
      `GET /repositories/${PAGED_REPOSITORY.id}/pulls`,
    ]),
  );
  expect(github.requests()).not.toContain("GET /graphql");
  const transcript = `${outcome}\n\nRequests:\n${github.requests().join("\n")}`;
  await test.info().attach("reads-anywhere", { body: transcript, contentType: "text/plain" });
  if (process.env.INFINITARY_TASK_EVIDENCE_DIR)
    writeFileSync(join(process.env.INFINITARY_TASK_EVIDENCE_DIR, "reads-anywhere.txt"), transcript);
});

/**
 * A crewmate's write that waits on its card (FI3-1571 piece 4): the card
 * shows the exact call the app kept, nothing reaches GitHub before the
 * captain's key, then the call goes once; the crewmate hears GitHub's
 * answer once, and the same ask on a revised card sends nothing again.
 */
async function writeAskJourney(title: string, evidenceName: string): Promise<string> {
  const { page } = launched;
  const call = writeAskCall(title);
  const request = `${call.method} ${call.path}`;
  const sent = () => github.requests().filter((entry) => entry === request);
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
  const card = shownCard(page, WRITE_ASK_CARD_TITLE);
  await expect(card).toBeVisible({ timeout: 45_000 });
  // The host drew the call it kept: the method, the path and the JSON body.
  const strip = cardBody(page, WRITE_ASK_CARD_TITLE).locator('[data-inf-call="write"]');
  await expect(strip.locator("[data-inf-call-line]")).toHaveText(request);
  await expect(strip.locator("[data-inf-call-body]")).toHaveText(
    JSON.stringify(JSON.parse(call.body ?? "{}"), null, 2),
  );
  expect(sent()).toEqual([]);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    await resizeWindow(launched.app, page, { width: 1100, height: 860 });
    await page.screenshot({ path: join(evidence, `${evidenceName}.png`) });
    if (evidenceName === "write-ask-other-repository") {
      await heroShot(launched.app, page, {
        region: card,
        anchors: [page.getByRole("button", { name: sendWriteWords("GitHub"), exact: true })],
        name: "write-asks",
      });
    }
  }
  await pressKey(
    page.getByRole("button", { name: sendWriteWords("GitHub"), exact: true }),
    "Enter",
  );
  await expect.poll(sent, { timeout: 20_000 }).toEqual([request]);
  let id = "";
  await expect
    .poll(
      async () => {
        const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
          (row) => row.title === title,
        );
        id = task?.id ?? "";
        const detail = id
          ? await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id)
          : undefined;
        return detail?.outcome ?? "";
      },
      { timeout: 45_000 },
    )
    .toMatch(
      new RegExp(
        `Asking again: Card refused[^\\n]*${NEVER_SENT_AGAIN}[\\s\\S]*The answer I heard: 201`,
      ),
    );
  expect(sent()).toEqual([request]);
  const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
  expect(savedWriteAsks(userDataDir, id)).toEqual([
    expect.objectContaining({
      method: call.method,
      path: call.path,
      body: call.body,
      sentAt: expect.any(Number),
      outcome: expect.objectContaining({ kind: "answered", status: 201 }),
    }),
  ]);
  const transcript = `${detail?.outcome ?? ""}\n\nRequests:\n${github.requests().join("\n")}`;
  await test.info().attach(evidenceName, { body: transcript, contentType: "text/plain" });
  if (evidence) writeFileSync(join(evidence, `${evidenceName}.txt`), transcript);
  return id;
}

test("a crewmate's write to another repository waits on its card and goes once on the captain's key", async () => {
  await arrange({ signedIn: true });
  await writeAskJourney(`meterlab ${WRITE_ASK_MARKER} website issue`, "write-ask-other-repository");
});

test("a project kept on this computer asks to create its repository through the github.com sign-in", async () => {
  await arrange({ signedIn: true, keptHere: true });
  await writeAskJourney(`notebook ${WRITE_ASK_MARKER} publish notebook`, "write-ask-publish");
});

test("a task that only answers asks before writing even to its own project, and stays open after the send", async () => {
  await arrange({ signedIn: true });
  const id = await writeAskJourney(`meterlab ${WRITE_ASK_ANSWER_MARKER}`, "write-ask-answer-task");
  const detail = await launched.page.evaluate(
    (taskId) => window.infinitary.tasks.detail(taskId),
    id,
  );
  expect(detail?.status).toBe("active");
});

for (const signedIn of [true, false]) {
  test(`a crewmate runs project workflow operations with GitHub signed ${signedIn ? "in" : "out"}`, async () => {
    await arrange({ signedIn });
    const title = `meterlab ${WORKFLOW_DISPATCH_MARKER}`;
    await send(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
    let id = "";
    await expect
      .poll(
        async () => {
          const task = (
            await launched.page.evaluate(() => window.infinitary.tasks.board())
          ).tasks.find((row) => row.title === title);
          id = task?.id ?? "";
          return task?.activity;
        },
        { timeout: 45_000 },
      )
      .toBe("idle");
    const detail = await launched.page.evaluate(
      (taskId) => window.infinitary.tasks.detail(taskId),
      id,
    );
    const outcome = detail?.outcome ?? "";
    // The account-level write is kept for the captain's click, never sent.
    const asks = savedWriteAsks(userDataDir, id);
    expect(asks).toEqual([expect.objectContaining({ method: "POST", path: "/user/keys" })]);
    expect(asks[0]?.sentAt).toBeUndefined();
    expect(outcome).not.toMatch(/gho_/);
    if (signedIn) {
      const headSha = git("-C", bare, "rev-parse", "refs/heads/main");
      expect(github.dispatches()).toEqual([
        { workflow: "verify.yml", ref: "main", headSha, inputs: { profile: "alpha", perf: true } },
      ]);
      expect(outcome).toContain('"status": 204');
      expect(outcome).toContain(headSha);
      expect(outcome).toContain('"status": "queued"');
      expect(outcome).toContain('"status": 202');
      expect(outcome).toContain('"conclusion": "cancelled"');
      expect(detail?.delivery?.ci).not.toBe("green");
    } else {
      expect(outcome).toContain("(sign-in)");
      expect(github.requests().some((request) => request.includes("/actions/"))).toBe(false);
    }
    expect(github.requests()).not.toContain("POST /user/keys");
    const transcript = `${outcome}\n\nAccepted requests:\n${JSON.stringify(github.dispatches(), null, 2)}\n\nRequests:\n${github.requests().join("\n")}`;
    await test
      .info()
      .attach("verification-dispatch", { body: transcript, contentType: "text/plain" });
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence)
      writeFileSync(
        join(evidence, `workflow-operations-signed-${signedIn ? "in" : "out"}.txt`),
        transcript,
      );
  });
}

test("a crewmate reads a failed job and downloads measurement evidence with the app's sign-in", async ({
  browserName: _browserName,
}, testInfo) => {
  await arrange({ signedIn: true });
  const headSha = git("-C", bare, "rev-parse", "main");
  github.serveWorkflowEvidence(headSha);
  const title = `meterlab ${WORKFLOW_EVIDENCE_MARKER}`;
  await send(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
  let id = "";
  await expect
    .poll(
      async () => {
        const task = (
          await launched.page.evaluate(() => window.infinitary.tasks.board())
        ).tasks.find((row) => row.title === title);
        id = task?.id ?? "";
        return task?.activity;
      },
      { timeout: 45_000 },
    )
    .toBe("idle");
  const detail = await launched.page.evaluate(
    (taskId) => window.infinitary.tasks.detail(taskId),
    id,
  );
  expect(detail?.outcome).toContain(STUB_JOB_FAILURE_LINE);
  expect(detail?.outcome).toContain(headSha);
  expect(detail?.outcome).toContain('"controlSeconds":88.41,"candidateSeconds":86.41,"pairs":5');
  expect(detail?.outcome).not.toMatch(/gho_|signed=disposable/);
  const row = readSavedData(
    userDataDir,
    (db) =>
      db.prepare("SELECT worktree_dir AS cwd FROM tasks WHERE id = ?").get(id) as { cwd: string },
  );
  const archive = join(row.cwd, ".infinitary-artifacts/run-10/artifact-30.zip");
  expect(readFileSync(archive)).toEqual(readFileSync("tests/fixtures/forge/measurement.zip"));
  expect(statSync(archive).mode & 0o777).toBe(0o600);
  expect(github.requests()).toEqual(
    expect.arrayContaining([
      "GET /repos/octo/meterlab/actions/runs",
      "GET /repos/octo/meterlab/actions/runs/10/attempts/1/jobs",
      "GET /repos/octo/meterlab/actions/runs/10/artifacts",
      "GET /repos/octo/meterlab/actions/jobs/20/logs",
      "GET /repos/octo/meterlab/actions/artifacts/30/zip",
      "GET /workflow-storage/job.log",
      "GET /workflow-storage/measurement.zip",
    ]),
  );
  await testInfo.attach("workflow-evidence-transcript", {
    body: `${detail?.outcome}\n\nRequests:\n${github.requests().join("\n")}`,
    contentType: "text/plain",
  });
  expect(
    github
      .requests()
      .some((request) => request.startsWith("POST /repos/") || request.startsWith("PUT /repos/")),
  ).toBe(false);
});

test("workflow evidence without the app's GitHub sign-in reports a blocker without contacting GitHub", async ({
  browserName: _browserName,
}, testInfo) => {
  await arrange({ signedIn: false });
  const title = `meterlab ${WORKFLOW_EVIDENCE_MARKER}`;
  await send(launched.page, `${SPAWN_PROMPT_MARKER} ${title}`);
  let outcome = "";
  await expect
    .poll(
      async () => {
        const task = (
          await launched.page.evaluate(() => window.infinitary.tasks.board())
        ).tasks.find((row) => row.title === title);
        if (!task) return "";
        const detail = await launched.page.evaluate(
          (id) => window.infinitary.tasks.detail(id),
          task.id,
        );
        outcome = detail?.outcome ?? "";
        return outcome;
      },
      { timeout: 45_000 },
    )
    .toContain("Not signed in to GitHub");
  expect(github.requests().some((request) => request.includes("/actions/"))).toBe(false);
  await testInfo.attach("workflow-signin-refusal", { body: outcome, contentType: "text/plain" });
});

test("the first change goes in and its continuation starts from the landed project", async ({
  browserName: _browserName,
}, testInfo) => {
  await arrange({ signedIn: true });
  // INF-1099: the host takes a second longer than the crewmate's shell
  // waits, as a busy Mac does, so the push always finishes as a background
  // job and the crewmate carries on from that job's exit.
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nsleep ${SYNC_CAP_MS / 1000 + 1}\n`);
  chmodSync(hook, 0o755);
  const { page, mockProvider } = launched;
  github.onPutIn((sha) => {
    git("-C", bare, "update-ref", "refs/heads/main", sha);
  });
  const title = `meterlab ${CONTINUE_CHANGE_PROMPT_MARKER}`;
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
  await expect(shownCard(page, CONTINUE_CHANGE_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
  const origin = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
    (row) => row.title === title,
  );
  expect(origin).toBeDefined();
  const continuation = async () =>
    (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (row) => row.title === CONTINUE_CHANGE_TITLE,
    );
  // The report turn had no card, so Firstmate linked the origin before
  // making the filing ready and steering the crewmate to show this card.
  await expect.poll(continuation, { timeout: 30_000 }).toMatchObject({
    status: "open",
    startPolicy: "when-ready",
  });
  const next = await continuation();
  const edges = readSavedData(
    userDataDir,
    (db) =>
      db.prepare("SELECT from_id, to_id, type FROM task_links WHERE type = 'blocks'").all() as {
        from_id: string;
        to_id: string;
        type: string;
      }[],
  );
  expect(edges).toContainEqual({ from_id: origin?.id, to_id: next?.id, type: "blocks" });
  await page.screenshot({ path: testInfo.outputPath("continuation-before-put-in.png") });
  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), origin?.id as string), {
      timeout: 30_000,
    })
    .toMatchObject({ status: "done", closedReason: "merged" });
  await expect.poll(continuation, { timeout: 30_000 }).toMatchObject({ status: "active" });
  const landedHead = git("-C", bare, "rev-parse", "refs/heads/main");
  expect(git("-C", bare, "rev-parse", `refs/heads/fm/task-${origin?.id}`)).toBe(landedHead);
  const nextDir = join(userDataDir, "worktrees", next?.id as string);
  // The row becomes active at "starting"; the pooled checkout follows it.
  await expect
    .poll(
      () => {
        if (!existsSync(nextDir)) return null;
        try {
          return git("-C", nextDir, "rev-parse", "HEAD");
        } catch {
          return null; // the warm working copy may not have its checkout yet
        }
      },
      { timeout: 30_000 },
    )
    .toBe(landedHead);
  const originKey = origin?.key;
  // The continuation starts from its origin's recorded findings.
  await expect
    .poll(
      () =>
        (mockProvider?.requestBodies() ?? []).some(
          (body) =>
            body.includes(CONTINUE_CHANGE_TITLE) &&
            body.includes(`(${originKey})`) &&
            body.includes(`Recorded origin ${originKey}`),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  // One merge: the origin's, at the version that landed; the continuation
  // has only started.
  expect(github.merges()).toEqual([
    {
      number: 100,
      sha: landedHead,
      method: "squash",
      title: MOCK_CONTINUE_CHANGE.title,
      message: presentationCommitMessage(MOCK_CONTINUE_STORY, BUNDLED_NAMING),
    },
  ]);
});

test("when GitHub stops accepting the sign-in: one card, gone once signed in again", async () => {
  await arrange({ signedIn: true });
  const { page } = launched;
  const logged = healthLines().length;
  const refuse = async () => {
    github.rejectSignIn();
    // A request GitHub refuses - here the open-changes read a personal
    // panel makes - makes the app ask GitHub who the sign-in is; GitHub's
    // own refusal is the proof, and the card is raised once.
    await page.evaluate(() => window.infinitary.forges.changes());
  };
  const card = shownCard(page, SIGN_IN_AGAIN);

  await refuse();
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(await cardsTitled(page, SIGN_IN_AGAIN)).toBe(1);
  const body = cardBody(page, SIGN_IN_AGAIN);
  // No proposed change is open, so none is waiting on the sign-in.
  await expect(body.locator("p").first()).toHaveText(forgeRefusedText("GitHub"));
  await expect(body.locator("body")).toContainText(LOCAL_PROJECTS_UNAFFECTED);
  // The card's words were read by hand in the plain-language sample (PR
  // 1.3): the row keyed by exactly these words must exist and say plain, so
  // a copy change here is read again before it ships.
  const shown = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (entry) => entry.id === "card-forge-github.com",
  );
  expect(shown).toBeDefined();
  const label = parsePlainLabelRows(readFileSync(PLAIN_LABELS, "utf8")).find(
    (row) => row.key === cardLabelKey({ title: shown?.title ?? "", body: shown?.body ?? "" }),
  );
  expect(label).toMatchObject({ plain: true, from: "tests/e2e/forge-signin.spec.ts" });
  await page.screenshot({ path: test.info().outputPath("forge-signin-again-card.png") });

  // Signed in again from the row itself: the card takes itself down the
  // moment GitHub answers again.
  await openIntegrations(page);
  const row = page.locator('[data-forge-row="github.com"]');
  await expect(row).toHaveAttribute("data-forge-state", "needs_reauth");
  await expect(row).toContainText(FORGE_SECTION_WORDS.reauth);
  await page.screenshot({ path: test.info().outputPath("forge-signin-row-again.png") });
  await row.getByRole("button", { name: "Sign in again" }).click();
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE);
  github.acceptSignIn();
  github.device.approve();
  await expect(row).toHaveAttribute("data-forge-state", "ok", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expectNoCard(page, SIGN_IN_AGAIN);

  // Refused again: the card's one action is the one-step way back - it
  // lands on Settings -> Integrations with the code already on screen.
  await refuse();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in again", exact: true }).click();
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE, { timeout: 15_000 });
  github.acceptSignIn();
  github.device.approve();
  await expect(page.locator('[data-forge-row="github.com"]')).toHaveAttribute(
    "data-forge-state",
    "ok",
    { timeout: 15_000 },
  );
  await page.keyboard.press("Escape");
  await expectNoCard(page, SIGN_IN_AGAIN);

  // Each refusal and each sign-in again left its one line.
  expect(healthLines().slice(logged)).toEqual([
    "github.com sign-in ok -> needs_reauth (answered 401)",
    "github.com sign-in needs_reauth -> ok (signed in, answered 200)",
    "github.com sign-in ok -> needs_reauth (answered 401)",
    "github.com sign-in needs_reauth -> ok (signed in, answered 200)",
  ]);
});

test("a project kept on this Mac never names a host or a sign-in, and signing out leaves the quiet line", async () => {
  await arrange({ signedIn: true });
  const { page } = launched;
  const logged = healthLines().length;
  await openProjects(page);
  const ledger = page.getByRole("button", { name: "ledger, collapsed" });
  await expect(ledger).toContainText(PROJECT_DELIVERY_WORDS["local-only"]);
  await expect(ledger).not.toContainText("GitHub");
  await ledger.click();
  const expanded = page.getByRole("button", { name: "ledger, expanded" });
  await expect(expanded).not.toContainText(/GitHub|sign in/i);
  await expanded.click();

  // Sign out and remove in Integrations: the folder goes, and the tab reads as it did at first.
  await page.getByRole("tab", { name: INTEGRATIONS_WORDS.title }).click();
  await page.getByRole("button", { name: "GitHub actions" }).click();
  await page.getByRole("menuitem", { name: "Sign out and remove" }).click();
  await expect(page.locator("[data-integrations-quiet]")).toHaveText(INTEGRATIONS_WORDS.quiet);
  await expect(page.locator("[data-forge-row]")).toHaveCount(0);
  expect(existsSync(join(userDataDir, "forges", "github.com"))).toBe(false);
  await page.keyboard.press("Escape");

  // The sign-out left its one dated line, and the log outlives signing out
  // - so a sign-in GitHub stops accepting says when.
  expect(healthLines().slice(logged)).toEqual(["github.com sign-in ok -> none (signed out)"]);

  // Signed out, the Firstmate is told so - and still nothing about the
  // project kept here.
  expect(await servedLives(page)).toEqual(["meterlab: github (not signed in)", "ledger: github"]);
});

test("a sign-in on file is still signed in after a real quit and start of the app", async () => {
  // A sign-in on file, then a real quit and a real start of the app over
  // the same folder: the captain does not sign in again.
  await arrange({ signedIn: true });
  await launched.close();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [forgeSignin, forgeSigninReads, mergeWriteGuard],
    userDataDir,
    env: github.env,
  });
  const { page } = launched;
  await openIntegrations(page);
  await expect(page.locator('[data-forge-row="github.com"]')).toHaveAttribute(
    "data-forge-state",
    "ok",
    { timeout: 15_000 },
  );
  await page.keyboard.press("Escape");
});

test("a sign-in GitHub makes short-lived renews itself when its eight hours run out: no card, and git's helper answers with the new one", async () => {
  await arrange({ signedIn: false });
  const { page } = launched;
  // GitHub's default for an OAuth App registered since 2026-08-14 - the
  // owner's first sign-in died eight hours in when the app kept only the
  // access token.
  github.issueShortLived();
  await openIntegrations(page);
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
  await expect(page.locator("[data-forge-code]")).toHaveText(STUB_USER_CODE, { timeout: 15_000 });
  // The access token GitHub hands this sign-in, eight hours long.
  const shortLived = "gho_e2e_short_lived";
  github.device.approve(shortLived);
  const row = page.locator('[data-forge-row="github.com"]');
  await expect(row).toHaveAttribute("data-forge-state", "ok", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  // One approved code, one sign-in handed over and kept, with its renewal.
  expect(github.exchanges()).toBe(1);
  const file = join(userDataDir, "forges", "github.com", "sign-in.json");
  const stored = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(stored()).toMatchObject({
    token: shortLived,
    refreshToken: stubRefreshToken(1),
  });
  expect(Number(stored().expiresAt)).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);

  // Eight hours on, GitHub stops accepting the access token. The next
  // request GitHub refuses renews it - the owner's "sign in again" never comes.
  github.endAccess();
  await page.evaluate(() => window.infinitary.forges.changes());
  await expect.poll(() => stored().token, { timeout: 15_000 }).toBe(stubRenewedToken(1));
  expect(stored().refreshToken).toBe(stubRefreshToken(2));
  expect(github.refreshes()).toEqual([stubRefreshToken(1)]);
  await openIntegrations(page);
  await expect(row).toHaveAttribute("data-forge-state", "ok");
  await page.keyboard.press("Escape");
  await expectNoCard(page, SIGN_IN_AGAIN);

  // Git asks the app's own helper, which answers with the renewed sign-in.
  const answer = execFileSync(
    join(process.cwd(), "resources", "git-askpass"),
    ["Password for 'https://x-access-token@github.com': "],
    {
      env: { PATH: process.env.PATH ?? "", INFINITARY_GIT_SIGNIN_DIR: join(userDataDir, "forges") },
    },
  ).toString();
  expect(answer).toBe(`${stubRenewedToken(1)}\n`);
  expect(healthLines()).toContainEqual(
    expect.stringMatching(/^github\.com sign-in renewed, short-lived until \d{4}-\d\d-\d\dT/),
  );
});

/** A GitHub Enterprise host the app has never seen, and the key the captain makes there. */
const ENTERPRISE = "github.example.com";
const ENTERPRISE_KEY = "ghp_e2e_enterprise_key_0123456789";

test("a GitHub Enterprise host: signed in with a key made there, its projects are GitHub projects, listed, and a crewmate's change opens there for the captain to merge", async () => {
  await arrange({ signedIn: false, host: ENTERPRISE });
  const { page } = launched;
  const opened = () =>
    launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);

  // Before the app knows the host, its projects are a plain Git host's.
  expect(await servedLives(page)).toEqual([`meterlab: git (${ENTERPRISE})`, "ledger: git"]);

  // The captain signs in from Settings -> Integrations, by keys alone: the
  // chip, the address, the page where the key is made, and the key.
  await openIntegrations(page);
  await pressKey(
    page.getByRole("button", { name: `Sign in to ${GITHUB_ENTERPRISE.name}` }),
    "Enter",
  );
  const form = page.getByRole("form", { name: `Sign in to ${GITHUB_ENTERPRISE.name}` });
  const address = form.getByLabel(FORGE_SECTION_WORDS.address);
  await expect(address).toBeFocused();
  await address.fill(`https://${ENTERPRISE}/octo/meterlab`);
  await form.getByRole("button", { name: `Make a key on ${ENTERPRISE}` }).click();
  await expect.poll(opened).toEqual([forgeKeyPage(GITHUB_ENTERPRISE.kind, ENTERPRISE)]);

  // A key the host does not accept is kept nowhere, and the form says why.
  github.rejectSignIn();
  const key = form.getByLabel(FORGE_SECTION_WORDS.key);
  await key.fill("ghp_e2e_wrong_key_0123456789");
  await pressKey(key, "Enter");
  await expect(form.getByRole("status")).toHaveText(
    forgeKeyProblemText("refused", ENTERPRISE, GITHUB_ENTERPRISE),
  );
  expect(existsSync(join(userDataDir, "forges", ENTERPRISE))).toBe(false);
  github.acceptSignIn();
  await key.fill(ENTERPRISE_KEY);
  await pressKey(key, "Enter");
  await expect(form).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.infinitary.forges.list()))
    .toMatchObject({
      signIns: [
        {
          host: ENTERPRISE,
          name: ENTERPRISE,
          login: STUB_LOGIN,
          state: "ok",
          projects: 2,
          server: GITHUB_ENTERPRISE,
        },
      ],
    });
  await expect(page.locator(`[data-forge-row="${ENTERPRISE}"]`)).toHaveAttribute(
    "data-forge-state",
    "ok",
  );
  await page.keyboard.press("Escape");
  expect(github.requests()).toContain("GET /api/v3/user");

  // The key stays in its 0600 file on this Mac, with the name git gives the
  // host; nothing the window reads carries it, and the health log dates it.
  const file = join(userDataDir, "forges", ENTERPRISE, "sign-in.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    token: ENTERPRISE_KEY,
    login: STUB_LOGIN,
    kind: "github",
    gitUser: "x-access-token",
  });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(await page.evaluate(() => window.infinitary.forges.list()))).not.toContain(
    ENTERPRISE_KEY,
  );
  expect(readFileSync(join(userDataDir, "forges", "health.log"), "utf8")).not.toContain(
    ENTERPRISE_KEY,
  );
  expect(healthLines()).toContain(
    `${ENTERPRISE} sign-in none -> ok (signed in with a key, answered 200)`,
  );
  // Git asks the app's own helper, which answers the host with the key.
  const askpass = (prompt: string) =>
    execFileSync(join(process.cwd(), "resources", "git-askpass"), [prompt], {
      env: { PATH: process.env.PATH ?? "", INFINITARY_GIT_SIGNIN_DIR: join(userDataDir, "forges") },
    }).toString();
  expect(askpass(`Username for 'https://${ENTERPRISE}': `)).toBe("x-access-token\n");
  expect(askpass(`Password for 'https://x-access-token@${ENTERPRISE}': `)).toBe(
    `${ENTERPRISE_KEY}\n`,
  );

  // Its projects are GitHub projects now, and the Firstmate is told so.
  expect((await addedProjects(page)).map((repo) => repo.host)).toEqual([
    { kind: "github", name: ENTERPRISE },
    { kind: "github", name: ENTERPRISE },
  ]);
  expect(await servedLives(page)).toEqual([
    `meterlab: github (signed in as ${STUB_LOGIN})`,
    "ledger: github",
  ]);

  // The Firstmate lists the projects there, through the host's own API.
  await send(page, `${LOCATE_PROJECTS_PROMPT_MARKER}website`);
  const listing = cardBody(page, MOCK_LOCATED_CARD_TITLE);
  await expect(listing.locator("li")).toHaveText(["octo/website"], { timeout: 30_000 });
  expect(github.requests()).toContain("GET /api/v3/user/repos");
  await noteDone(page).click();

  // A crewmate sends its branch up and opens its change there with its own
  // tools; the completion card reads its checks there, and the captain's
  // click merges it there.
  const title = `meterlab ${GITHUB_CHANGE_PROMPT_MARKER}`;
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
  await expect(shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE)).toBeVisible({
    timeout: 45_000,
  });
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  const task = board.tasks.find((row) => row.title === title);
  expect(task).toBeDefined();
  const sentUp = git("-C", bare, "rev-parse", `refs/heads/fm/task-${task?.id}`);
  expect(github.requests()).toContain("POST /api/v3/repos/octo/meterlab/pulls");
  const facts = factsStrip(cardBody(page, MOCK_GITHUB_CHANGE_CARD_TITLE));
  await expect(
    facts.change.locator(`a[href="https://${ENTERPRISE}/octo/meterlab/pull/100"]`),
  ).toHaveText("#100");
  await expect(facts.checks).toHaveText(CHECK_WORDS.green);
  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
  await expect(putInLine(page, task?.key as string)).toBeVisible({ timeout: 30_000 });
  expect(github.merges()).toEqual([
    {
      number: 100,
      sha: sentUp,
      method: "squash",
      title: MOCK_GITHUB_CHANGE.title,
      // INF-1965: Enterprise squashes the saved story's summary, like public GitHub.
      message: presentationCommitMessage(MOCK_GITHUB_STORY, BUNDLED_NAMING),
    },
  ]);
  // A GitHub Enterprise Server documents no background merge: it answers that
  // call as a path it does not know, and the app merges directly.
  expect(github.mergeRequests()).toEqual([
    "PUT /api/v3/repos/octo/meterlab/pulls/100/merge-async",
    "PUT /api/v3/repos/octo/meterlab/pulls/100/merge",
  ]);
});
