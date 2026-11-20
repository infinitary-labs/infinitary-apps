import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinHome } from "@core/helper/join";
import { expect, type Page, test } from "@playwright/test";
import { COMPUTER } from "@shared/deviceNames";
import { PAIRING_LINK_PREFIX } from "@shared/devices";
import { INTEGRATION_KIND_NAMES, INTEGRATION_NOTICES } from "@shared/integrations";
import electronPath from "electron";
import { HOST_CARD_PRIORITY, PROVIDER_SIGN_IN_TITLE } from "../../src/core/orchestrator/hostCards";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { RUN_WORDS } from "../../src/main/runCommand";
import { RETURN_PASTE_WORDS } from "../../src/renderer/src/devices/viewWords";
import { builtinManifest } from "../../src/renderer/src/plugins/builtin/manifest";
import { FOLDER_THERE_WORDS } from "../../src/renderer/src/settings/addProjectWords";
import { claimedPort } from "../helpers/claimedPort";
import {
  type GoogleStandIn,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../helpers/googleStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { BUILDER, linkInTab, openDevices, selectDevice } from "./deviceFixtures";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { knowledgePanel } from "./knowledgeBrowser";
import { seedKnowledge } from "./knowledgeSeed";
import {
  builtAppDir,
  defaultClaudeStubDir,
  hermeticEnv,
  type LaunchedApp,
  launchApp,
} from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { mockModelsJson } from "./mockModels";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { readSavedData } from "./savedData";
import { launchSecrets, secretsEntry } from "./secretsHarness";
import { settingRow, settingsSection } from "./settings";
import { showCard, shownCard } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * INF-1228's approved plan, piece 6, the captain's answer control=all:
 * "everything the window does, including subscription and custom API
 * sign-ins, projects, computers, phones, integrations, and card buttons that
 * open Settings", for a first mate started by a command (docs/run.md,
 * "Control from another computer"), and INF-1352's plan, pieces 1 and 2, the
 * captain's answer one_rule=every-view: the same from a first mate with its
 * window. Promised result: from another computer's Infinitary, a card's Open
 * settings button opens Settings there; its Projects, Intelligence, Usage,
 * Automation and Integrations open by keys; a projects folder typed there is
 * checked and saved where the first mate lives; a Google sign-in started there
 * opens Google's page in that computer's browser, never the first mate's, and
 * is kept where the first mate lives; and its Devices adds a stand-in computer
 * to the first mate and removes it again, and its Knowledge shows there.
 * INF-3454's plan, the captain's answers direction=catch-here and
 * proof=linux-journey: Google's return is caught by the computer the person
 * is at and handed to the first mate, or pasted when that computer cannot
 * listen on its port. Data: the real built app started as `<app> run`, or as
 * the ordinary app with its window, in a disposable HOME and data folder,
 * with the mock provider, a mock Claude client and the Google stand-in, and a
 * second app at its first launch that joins with a link; no credentials or
 * real Keychain. Google's stand-in sends the browser back to 127.0.0.1 at the
 * first mate's port: on Linux the joined app listens at 127.0.0.2 instead, so
 * the test plays its computer's browser there and the return is caught; with
 * the window, the first mate holds that port on this one computer, so the
 * joined app asks for the address and the test pastes it. Completion: the
 * joined app's Settings rows, the page each app's recorded browser opened,
 * and the first mate's saved data. Platform: Linux needs Xvfb for the run,
 * and is where the return is caught; a Mac pastes it. Shared resources:
 * loopback ports this test claims, and the first mate's sign-in port at
 * 127.0.0.2.
 */

/** The joined computer's name, and the name the run's computer goes by. */
const VIEW_NAME = "MacBook Air";
const RUN_NAME = "Mac mini";

/** The seeded sign-in card's one button, named once where it goes in and where it is pressed. */
const OPEN_SETTINGS_LABEL = "Open settings";

/** A built-in Settings tab's name, read from the manifest that declares it. */
function tabLabel(id: string): string {
  const section = builtinManifest.contributes.settingsSections.find((entry) => entry.id === id);
  if (!section) throw new Error(`No Settings section ${id}`);
  return section.label;
}

const children: { child: ChildProcessWithoutNullStreams; exited: Promise<number | null> }[] = [];
let view: LaunchedApp | undefined;
let provider: MockProviderServer | undefined;
let google: GoogleStandIn | undefined;
test.afterEach(async () => {
  await view?.close();
  view = undefined;
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
  await provider?.close();
  provider = undefined;
  await google?.close();
  google = undefined;
});

/** The app's own command, or `entry` in place of the built app (`secretsEntry`). */
function command(env: Record<string, string>, args: string[], entry = builtAppDir()) {
  const child = spawn(electronPath as unknown as string, [entry, ...args], {
    env,
    cwd: scratchDir("run-control-cwd-"),
  });
  let out = "";
  let error = "";
  let ready: () => void = () => {};
  let ended: (reason: Error) => void = () => {};
  // Settled by the start line, or by the command ending before it, with what it said.
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    ended = reject;
  });
  started.catch(() => {});
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    if (out.split("\n").includes(RUN_WORDS.started)) ready();
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  void exited.then((code) =>
    ended(new Error(`The command ended (${code}) before it started:\n${out}\n${error}`)),
  );
  children.push({ child, exited });
  return { child, exited, started, out: () => out, error: () => error };
}

/**
 * The card the app raises when a provider needs signing in again
 * (`addAuthDecisionCard`), whose one button lands on Intelligence.
 */
function signInCard(data: string): void {
  const db = openDatabase(data);
  try {
    new CardStore(db).upsert({
      id: "auth-provider",
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: PROVIDER_SIGN_IN_TITLE,
      meta: "Codex",
      body: "<p>Codex stopped answering: its sign-in ran out.</p>",
      actions: [
        {
          id: "open-settings",
          label: OPEN_SETTINGS_LABEL,
          variant: "primary",
          effect: { kind: "open", target: "subscriptions" },
        },
      ],
      status: "ready",
      createdAt: Date.now(),
    });
  } finally {
    db.close();
  }
}

/** The page the joined app's browser opened, recorded in its main process. */
async function recordOpened(app: LaunchedApp["app"]): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __runOpened?: string[] }).__runOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { __runOpened?: string[] }).__runOpened ?? []);
}

async function joinWith(page: Page, link: string): Promise<void> {
  await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible();
  await page.locator("[data-join-chip]").click();
  await page.getByLabel(`The link from your other ${COMPUTER.one}`).fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Control it from here" }).click();
  await expect(page.locator("[data-remote-control]")).toHaveAttribute(
    "data-remote-control",
    "in-reach",
    { timeout: 30_000 },
  );
}

/** A card's button that opens Settings opens it on this computer. */
async function cardOpensSettingsHere(page: Page): Promise<void> {
  await test.step("a card's Open settings button opens Intelligence here", async () => {
    await showCard(page, PROVIDER_SIGN_IN_TITLE);
    const card = shownCard(page, PROVIDER_SIGN_IN_TITLE);
    await pressKey(card.getByRole("button", { name: OPEN_SETTINGS_LABEL, exact: true }), "Enter");
    await expect(settingsSection(page, "subscriptions")).toBeVisible();
    await expect(
      page.getByRole("tab", { name: tabLabel("subscriptions"), exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
}

/**
 * How the browser's return reaches the first mate: `caught` by this
 * computer's own listener at another address of its own, as a second
 * computer's would be, or `pasted` when this computer cannot listen on the
 * port because the first mate's computer, the same one here, holds it.
 */
type ReturnWay = "caught" | "pasted";

/** The loopback address the joined app catches Google's return on, as a second computer would. */
const VIEW_RETURN_HOST = "127.0.0.2";

/** On Linux any 127.x address is this computer's own; a Mac has only 127.0.0.1. */
const RETURN_WAY: ReturnWay = process.platform === "linux" ? "caught" : "pasted";

/**
 * A Google sign-in started on this computer opens here, its return comes
 * back here, caught or pasted, and the sign-in is kept where the first mate
 * lives.
 */
async function googleSignInFromHere(
  { app, page }: LaunchedApp,
  opened: () => Promise<string[]>,
  way: ReturnWay,
): Promise<void> {
  await test.step(`a Google sign-in started here opens Google's page here, its return ${way} here, and is kept where the first mate lives`, async () => {
    const stand = google as GoogleStandIn;
    await runFromSearch(app, page, "settings.integrations");
    const tab = settingsSection(page, "integrations");
    await pressKey(tab.locator('[data-integration-add="google"] button'), "Enter");
    const notice = tab.locator('[data-integration-notice="google"]');
    // Both computers can take the return: the notice says nothing of the other computer.
    await expect(notice).toBeVisible();
    await expect(notice.locator("[data-integration-notice-there]")).toHaveCount(0);
    const accept = INTEGRATION_NOTICES.google?.accept ?? "";
    await pressKey(notice.getByRole("button", { name: accept, exact: true }), "Enter");
    await expect.poll(async () => (await opened()).length, { timeout: 30_000 }).toBe(1);
    const [consent = ""] = await opened();
    expect(consent.startsWith(`${stand.base}/o/oauth2/v2/auth?`)).toBe(true);
    // This computer's browser approves on Google's page, which sends it back to 127.0.0.1.
    const approved = await fetch(consent, { redirect: "manual" });
    const back = new URL(approved.headers.get("location") ?? "");
    expect(back.hostname).toBe("127.0.0.1");
    const paste = tab.locator("[data-integration-return-paste]");
    if (way === "caught") {
      await expect
        .poll(() => page.evaluate(() => window.infinitary.devices.thisMac()))
        .toMatchObject({ role: "view", signInReturn: { caught: true } });
      // 127.0.0.1 on this computer is VIEW_RETURN_HOST in the journey's two-computer play.
      back.hostname = VIEW_RETURN_HOST;
      const shown = await fetch(back);
      expect(await shown.text()).toContain("Signed in to Google");
      await expect(paste).toHaveCount(0);
    } else {
      // The first mate's own listener holds the port here, so Settings asks for the address.
      const google = INTEGRATION_KIND_NAMES.google;
      const field = paste.getByLabel(RETURN_PASTE_WORDS.label(google));
      await expect(field).toBeVisible();
      await field.fill(back.href);
      await pressKey(field, "Enter");
    }
    await expect(tab.locator('[data-integration-row="google"]')).toContainText(
      `as ${STAND_IN_ACCOUNT}`,
    );
    await expect(paste).toHaveCount(0);
  });
}

test("another computer controls a first mate started by a command: its Settings, its sign-ins and a card's Settings button", async () => {
  test.setTimeout(240_000);
  const data = scratchDir("run-control-data-");
  signInCard(data);
  provider = await startMockProvider();
  mkdirSync(join(data, "auth"), { recursive: true });
  writeFileSync(join(data, "auth", "models.json"), mockModelsJson(provider.port));
  google = await startGoogleStandIn();
  const {
    DISPLAY: _display,
    WAYLAND_DISPLAY: _wayland,
    ...base
  } = hermeticEnv({
    userDataDir: data,
    homeDir: scratchDir("run-control-home-"),
    loopbackPort: String(await claimedPort()),
  });
  const env = {
    ...base,
    INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(data)),
    INFINITARY_DEVICE_NAME: RUN_NAME,
    INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
    INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
    INFINITARY_GOOGLE_URL: google.base,
  };
  // The Google sign-in keeps its key in Secrets (docs/integrations.md, "Keys"):
  // the run carries disposable Secrets, as `launchSecrets` gives a window.
  const run = command(env, ["run"], await secretsEntry({ run: true }));
  await run.started;
  const asked = command(env, ["link", "--json"]);
  expect(await asked.exited, asked.error()).toBe(0);
  const link = String((JSON.parse(asked.out()) as { link: string }).link);

  view = await launchApp({
    env: {
      INFINITARY_DEVICE_NAME: VIEW_NAME,
      ...(RETURN_WAY === "caught" ? { INFINITARY_SIGN_IN_RETURN_HOST: VIEW_RETURN_HOST } : {}),
    },
  });
  const { app, page } = view;
  const opened = await recordOpened(app);
  await joinWith(page, link);

  await cardOpensSettingsHere(page);

  await test.step("its Settings sections open by keys, beside this computer's own look and keys", async () => {
    await runFromSearch(app, page, "settings.usage");
    await expect(settingsSection(page, "usage")).toBeVisible();
    // INF-1339: Automation opens by its command too.
    await runFromSearch(app, page, "settings.automation");
    await expect(settingsSection(page, "automation")).toBeVisible();
    const tabs = page.getByRole("tab");
    for (const id of [
      "general",
      "appearance",
      "keyboard",
      "projects",
      "subscriptions",
      "usage",
      "automation",
      "integrations",
      "devices",
    ])
      await expect(tabs.filter({ hasText: tabLabel(id) })).toHaveCount(1);
  });

  await test.step("a projects folder typed here is checked and saved where the first mate lives", async () => {
    await pressKey(page.getByRole("tab", { name: tabLabel("projects"), exact: true }), "Enter");
    const row = settingRow(page, "projects-folder");
    const choose = row.getByRole("button", { name: "Choose folder", exact: true });
    // The button waits for the first mate's answer of where the folder is now.
    await expect(choose).toBeEnabled();
    await pressKey(choose, "Enter");
    const field = row.getByLabel(FOLDER_THERE_WORDS.label(RUN_NAME));
    await expect(field).toBeFocused();
    const missing = join(scratchDir("run-control-missing-"), "nowhere");
    await field.fill(missing);
    await pressKey(field, "Enter");
    // The first mate's computer has no such folder, and says so by its path.
    await expect(row.getByRole("alert")).toContainText(missing);
    const folder = scratchDir("run-control-projects-");
    await field.fill(folder);
    await pressKey(field, "Enter");
    await expect(row.locator("[data-projects-folder-path]")).toHaveText(folder);
  });

  await googleSignInFromHere(view, opened, RETURN_WAY);

  // What the first mate keeps, read from its own data once its run stops.
  run.child.kill("SIGTERM");
  expect(await run.exited).toBe(0);
  expect(
    readSavedData(
      data,
      (db) =>
        (
          db.prepare("SELECT value FROM settings WHERE key = 'projects-folder'").get() as
            | { value: string }
            | undefined
        )?.value,
    ),
  ).toContain("run-control-projects-");
  // The Google sign-in is kept in the first mate's own folder, never here.
  expect(existsSync(join(data, "integrations", "google.json"))).toBe(true);
});

test("another computer controls a first mate with its window: a card's Settings button and a sign-in opened there, not on the first mate's computer, and its computers and Knowledge", async () => {
  test.setTimeout(240_000);
  const data = scratchDir("run-control-windowed-");
  signInCard(data);
  await seedKnowledge(data);
  google = await startGoogleStandIn();
  const runs: HelperRun[] = [];
  // Its Google sign-in keeps its key in Secrets, here on disposable custody.
  const home = await launchSecrets({
    userDataDir: data,
    withMockProvider: false,
    env: {
      INFINITARY_DEVICE_NAME: RUN_NAME,
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: google.base,
    },
  });
  try {
    const openedThere = await recordOpened(home.app);
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    view = await launchApp({ env: { INFINITARY_DEVICE_NAME: VIEW_NAME } });
    const opened = await recordOpened(view.app);
    await joinWith(view.page, invite.link);

    await cardOpensSettingsHere(view.page);
    await googleSignInFromHere(view, opened, "pasted");
    expect(await openedThere()).toEqual([]);
    // The Google sign-in is kept in the first mate's own folder, never here.
    expect(existsSync(join(data, "integrations", "google.json"))).toBe(true);

    await test.step("its Knowledge shows here and opens", async () => {
      // The panels sit on the home screen, so Settings closes first.
      await (view as LaunchedApp).page.keyboard.press("Escape");
      await expect((view as LaunchedApp).page.locator("[data-screen-label]")).not.toHaveAttribute(
        "data-screen-label",
        "Settings",
      );
      // Its header's open button opens it, by keys. The panel's own page
      // says when it shows, and Settings closed that page, so the panel is
      // back but hidden until the page loads again: wait for the button to
      // show, since a key pressed on a hidden button reaches nothing.
      const open = knowledgePanel(view?.page as Page).locator(
        '[data-panel-header-button="open"] button',
      );
      await expect(open).toBeVisible({ timeout: 30_000 });
      await pressKey(open, "Enter");
      await expect(
        (view as LaunchedApp).page.locator('[data-panel-card="knowledge/browser"]'),
      ).toBeVisible();
    });

    await test.step("its Devices adds a stand-in computer to the first mate and removes it", async () => {
      const { page } = view as LaunchedApp;
      await page.keyboard.press("Escape");
      await openDevices(page);
      // A command for another user of the first mate's computer, made here.
      await pressKey(page.locator('[data-device-add="user"]'), "Enter");
      const made = (await linkInTab(page).textContent()) ?? "";
      const link = made.slice(made.indexOf(PAIRING_LINK_PREFIX), made.lastIndexOf("'"));
      const dataDir = scratchDir("run-control-stand-in-");
      const joined = await joinHome({
        text: link,
        dataDir,
        io: { say: () => {}, ask: async () => "yes" },
        device: { name: "iMac", user: BUILDER },
        timeoutMs: 5_000,
      });
      if (!joined.ok) throw new Error(joined.reason);
      const deviceId = joined.grant.deviceId;
      await pressKey(page.getByRole("button", { name: "Done", exact: true }), "Enter");
      const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
      if (!started.ok) throw new Error(started.reason);
      runs.push(started.run);
      await expect
        .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
        .toBe("in-reach");
      // It is the first mate's computer, listed there and here.
      expect(
        (await home.page.evaluate(() => window.infinitary.devices.list())).map(({ id }) => id),
      ).toContain(deviceId);
      const row = await selectDevice(page, deviceId);
      await expect(row).toBeVisible();
      await pressKey(row.getByRole("button", { name: /^Remove / }), "Enter");
      const question = page.locator(`[data-device-removing="${deviceId}"]`);
      await pressKey(question.getByRole("button", { name: "Remove", exact: true }), "Enter");
      expect(await started.run.ended).toBe("removed");
      await expect(row).toHaveCount(0);
      expect(
        (await home.page.evaluate(() => window.infinitary.devices.list())).map(({ id }) => id),
      ).not.toContain(deviceId);
    });
  } finally {
    await Promise.all(runs.map((run) => run.stop()));
    await home.close();
  }
});
