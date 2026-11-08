import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { COMPUTER } from "@shared/deviceNames";
import { INTEGRATION_NOTICES } from "@shared/integrations";
import electronPath from "electron";
import { HOST_CARD_PRIORITY, PROVIDER_SIGN_IN_TITLE } from "../../src/core/orchestrator/hostCards";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { RUN_WORDS } from "../../src/main/runCommand";
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
import { settingRow, settingsSection } from "./settings";
import { showCard, shownCard } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * INF-1228's approved plan, piece 6, the captain's answer control=all:
 * "everything the window does, including subscription and custom API
 * sign-ins, projects, computers, phones, integrations, and card buttons that
 * open Settings", for a first mate started by a command (docs/run.md,
 * "Control from another computer"). This journey covers the part built so
 * far: that first mate's Settings, its sign-ins and a card's Settings button.
 * Promised result: from another computer's Infinitary, a card's Open settings
 * button opens Settings there; its Projects, Intelligence, Usage and
 * Integrations open by keys; a projects folder typed there is checked and
 * saved where the first mate lives; and a Google sign-in started there opens
 * Google's page in that computer's browser and is kept where the first mate
 * lives. Data: the real built app started as `<app> run` in a disposable HOME
 * and data folder, with the mock provider, a mock Claude client and the
 * Google stand-in, and a second app at its first launch that joins with the
 * link `link --json` prints; no credentials or real Keychain. Google's
 * stand-in sends its page back to the first mate's own loopback address,
 * which the test reaches because both apps run on one computer. Completion:
 * the joined app's Settings rows, the page its recorded browser opened, and
 * the run's saved data. Platform: Linux needs Xvfb for the run. Shared
 * resources: loopback ports this test claims.
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

function command(env: Record<string, string>, args: string[]) {
  const child = spawn(electronPath as unknown as string, [builtAppDir(), ...args], {
    env,
    cwd: scratchDir("run-control-cwd-"),
  });
  let out = "";
  let error = "";
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    if (out.split("\n").includes(RUN_WORDS.started)) ready();
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
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
  const run = command(env, ["run"]);
  await run.started;
  const asked = command(env, ["link", "--json"]);
  expect(await asked.exited, asked.error()).toBe(0);
  const link = String((JSON.parse(asked.out()) as { link: string }).link);

  view = await launchApp({ env: { INFINITARY_DEVICE_NAME: VIEW_NAME } });
  const { app, page } = view;
  const opened = await recordOpened(app);
  await joinWith(page, link);

  await test.step("a card's Open settings button opens Intelligence here", async () => {
    await showCard(page, PROVIDER_SIGN_IN_TITLE);
    const card = shownCard(page, PROVIDER_SIGN_IN_TITLE);
    await pressKey(card.getByRole("button", { name: OPEN_SETTINGS_LABEL, exact: true }), "Enter");
    await expect(settingsSection(page, "subscriptions")).toBeVisible();
    await expect(
      page.getByRole("tab", { name: tabLabel("subscriptions"), exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });

  await test.step("its Settings sections open by keys, beside this computer's own look and keys", async () => {
    await runFromSearch(app, page, "settings.usage");
    await expect(settingsSection(page, "usage")).toBeVisible();
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

  await test.step("a Google sign-in started here opens Google's page here and is kept where the first mate lives", async () => {
    const stand = google as GoogleStandIn;
    await runFromSearch(app, page, "settings.integrations");
    const tab = settingsSection(page, "integrations");
    await pressKey(tab.locator('[data-integration-add="google"] button'), "Enter");
    const notice = tab.locator('[data-integration-notice="google"]');
    const accept = INTEGRATION_NOTICES.google?.accept ?? "";
    await pressKey(notice.getByRole("button", { name: accept, exact: true }), "Enter");
    await expect.poll(async () => (await opened()).length, { timeout: 30_000 }).toBe(1);
    const [consent = ""] = await opened();
    expect(consent.startsWith(`${stand.base}/o/oauth2/v2/auth?`)).toBe(true);
    // This computer's browser: Google's page sends it back to the first mate.
    const back = await fetch(consent);
    expect(await back.text()).toContain("Signed in to Google");
    await expect(tab.locator('[data-integration-row="google"]')).toContainText(
      `as ${STAND_IN_ACCOUNT}`,
    );
  });

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
