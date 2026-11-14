import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import {
  buildUpdateTarget,
  type UpdateTarget,
  upgradeCommandFor,
} from "../../src/core/update/updateChannels";
import { pillWords } from "../../src/renderer/src/devices/viewWords";
import { PROTOCOL_MAJORS_BEHIND, PROTOCOL_VERSION } from "../../src/shared/ipc";
import type { UpdateChannel, UpdateStatus } from "../../src/shared/update";
import {
  UPDATE_NOTICES,
  UPDATE_PROBLEMS,
  UPDATE_STEP_WORDS,
  UPDATE_WORDS,
} from "../../src/shared/updateWords";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { within } from "./layout";
import { promptInput } from "./prompt";
import { writeInstallerMarker } from "./savedDataFixtures";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * Channel-aware update notices (docs/alpha.md "Update channels"): the
 * installer's remembered subscription in the data root chooses which
 * published target an installation is offered, and with it the cask the
 * upgrade command names. Each journey runs the real app against a stand-in
 * of the public tap whose targets come from the producer the release
 * writer uses (`buildUpdateTarget`). An app controlling Firstmate on
 * another Mac is offered its own update the same way (docs/view.md).
 */

const artifacts = () => test.info().outputPath("update-channels");

/** An HTTP answer. */
type Reply = { status: number; body?: unknown };

/** The public tap as the update reader sees it: the targets file and the legacy release list. */
type Tap = {
  reply: { targets: Reply; releases: Reply };
  env: Record<string, string>;
  close: () => Promise<void>;
};

async function startTap(): Promise<Tap> {
  const reply: Tap["reply"] = { targets: { status: 404 }, releases: { status: 200, body: [] } };
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    const answer =
      path === "/targets" ? reply.targets : path === "/releases" ? reply.releases : { status: 404 };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? null),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    reply,
    env: {
      INFINITARY_SIMULATE_UPDATE: "0",
      INFINITARY_UPDATE_TARGETS_URL: `${base}/targets`,
      INFINITARY_UPDATE_RELEASES_URL: `${base}/releases`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function target(version: string): UpdateTarget {
  return buildUpdateTarget({
    version,
    assetName: `Infinitary-${version}-universal.zip`,
    sha256: "5".repeat(64),
    sourceCommit: "7".repeat(40),
  });
}

function published(entries: Partial<Record<UpdateChannel, UpdateTarget>>): Reply {
  return { status: 200, body: { schemaVersion: 1, targets: entries } };
}

let tap: Tap | undefined;
let running: LaunchedApp | undefined;

test.afterEach(async () => {
  await running?.close();
  running = undefined;
  await tap?.close();
  tap = undefined;
});

/** The installed app at `version`, on a throwaway data root and HOME. */
async function launchInstalled(userDataDir: string, version: string): Promise<LaunchedApp> {
  if (!tap) throw new Error("start the tap first");
  await running?.close();
  const homeDir = scratchDir("fm-update-home-");
  running = await launchApp({
    userDataDir,
    homeDir,
    env: { ...tap.env, INFINITARY_UPDATE_CURRENT_VERSION: version, CFFIXED_USER_HOME: homeDir },
  });
  await recordOpenedPages(running);
  return running;
}

/** The system browser, replaced by a recorder: nothing here opens a page. */
function recordOpenedPages(launched: LaunchedApp): Promise<void> {
  return launched.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

function updateStatus(page: Page): Promise<UpdateStatus> {
  return page.evaluate(() => window.infinitary.update.status());
}

/**
 * The indicator offers `version` on `channel` to an app running `installed`:
 * the panel names the channel, the offered and the installed versions, shows
 * that channel's cask command and opens the target's release page.
 */
async function expectOffer(
  launched: LaunchedApp,
  offer: { version: string; installed: string; channel: UpdateChannel; picture: string },
): Promise<void> {
  const { page, app } = launched;
  expect(await updateStatus(page)).toMatchObject({
    currentVersion: offer.installed,
    channel: offer.channel,
    latestVersion: offer.version,
    updateAvailable: true,
    releaseUrl: target(offer.version).releaseUrl,
    upgradeCommand: upgradeCommandFor(offer.channel),
  });
  const indicator = page.getByRole("button", { name: `Update available: ${offer.version}` });
  await expect(indicator).toBeVisible();
  await indicator.click();
  const panel = page.locator("[data-update-channel]");
  await expect(panel).toHaveAttribute("data-update-channel", offer.channel);
  await expect(panel.locator("[data-update-line]")).toContainText(offer.version);
  await expect(panel.locator("[data-update-installed]")).toContainText(offer.installed);
  await expect(panel.getByText(upgradeCommandFor(offer.channel), { exact: true })).toBeVisible();
  // The top bar's right end, with the indicator and the open panel.
  const box = await panel.boundingBox();
  const pageWidth = await page.evaluate(() => window.innerWidth);
  if (box) {
    mkdirSync(artifacts(), { recursive: true });
    const left = Math.max(0, box.x - 120);
    await page.screenshot({
      path: `${artifacts()}/${offer.picture}.png`,
      clip: { x: left, y: 0, width: pageWidth - left, height: box.y + box.height + 16 },
    });
  }
  // INF-3405, the captain's direction B: the offered version is the link to its release page.
  await panel.getByRole("button", { name: offer.version, exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []))
    .toEqual([target(offer.version).releaseUrl]);
}

/** Nothing is offered: the typed status says so and the indicator stays away. */
async function expectNoOffer(page: Page, expected: Partial<UpdateStatus>): Promise<void> {
  expect(await updateStatus(page)).toMatchObject({ ...expected, updateAvailable: false });
  await expect(page.getByRole("button", { name: /Update available/ })).toHaveCount(0);
}

test("an alpha installation is offered alpha.10 over alpha.2 with the alpha cask", async () => {
  tap = await startTap();
  tap.reply.targets = published({ stable: target("0.1.24"), alpha: target("0.1.25-alpha.10") });
  const userDataDir = scratchDir("fm-update-alpha-");
  writeInstallerMarker(userDataDir, "alpha");
  const launched = await launchInstalled(userDataDir, "0.1.25-alpha.2");
  await expectOffer(launched, {
    version: "0.1.25-alpha.10",
    installed: "0.1.25-alpha.2",
    channel: "alpha",
    picture: "alpha-next",
  });
});

test("a Mac controlling a newer Firstmate on another Mac is offered its own update", async () => {
  tap = await startTap();
  tap.reply.targets = published({ alpha: target("0.1.30-alpha.5") });
  // The Mac where Firstmate lives runs the newest alpha, on a contract major
  // that broke views, beyond the window this Mac's own contract is answered in (docs/contract.md).
  const newerMajor = Number(PROTOCOL_VERSION.split(".")[0]) + PROTOCOL_MAJORS_BEHIND + 1;
  const pro = await launchApp({
    withMockProvider: true,
    env: {
      ...tap.env,
      INFINITARY_DEVICE_NAME: "MacBook Pro",
      INFINITARY_UPDATE_CURRENT_VERSION: "0.1.30-alpha.5",
      INFINITARY_CONTRACT_VERSION: `${newerMajor}.0.0`,
      // A major that broke views moves the floor to itself (docs/contract.md).
      INFINITARY_VIEW_FLOOR: `${newerMajor}`,
    },
  });
  let air: LaunchedApp | undefined;
  try {
    const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    // This Mac runs an older alpha, and joins it with the link.
    air = await launchApp({
      env: {
        ...tap.env,
        INFINITARY_DEVICE_NAME: "MacBook Air",
        INFINITARY_UPDATE_CURRENT_VERSION: "0.1.28-alpha.3",
      },
    });
    await recordOpenedPages(air);
    // Joining starts the window over, so its answer may never return to this page.
    await air.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    // It reads, and names this Mac as the one to update before buttons come back; a home on a
    // newer major still hears this Mac's plain words (INF-4012 piece 2, docs/contract.md).
    const pill = pillWords({
      role: "view",
      name: "MacBook Pro",
      address: "127.0.0.1",
      joinedAt: 0,
      contact: "in-reach",
      readOnly: "newer-there",
      messagesWhileReading: true,
      heardAt: null,
      caughtUp: 0,
    });
    await expect(air.page.locator('[data-view-pill="newer-there"]')).toContainText(pill ?? "");
    // INF-4012 piece 2: the message box stays on, and plain words reach the first mate there. A home
    // from major 16 on says it hears them by its version; an older one does not, so this pair owns the proof.
    const words = "Merge the harbour fix";
    await promptInput(air.page).fill(words);
    await air.page.keyboard.press("Enter");
    await expect
      .poll(
        async () => (await pro.page.evaluate(() => window.infinitary.conversation.lastTurn()))?.you,
      )
      .toBe(words);
    await expect(promptInput(air.page)).toHaveValue("");
    // The way to act on it: this Mac's own notice, as the other Mac shows its own.
    await expectOffer(air, {
      version: "0.1.30-alpha.5",
      installed: "0.1.28-alpha.3",
      channel: "alpha",
      picture: "view-newer-there",
    });
    // That notice is this Mac's, not the other one's: that Mac is offered nothing.
    await expectNoOffer(pro.page, { currentVersion: "0.1.30-alpha.5", channel: "alpha" });
  } finally {
    await air?.close();
    await pro.close();
  }
});

// INF-2073, the captain's direction A: Check for updates on a copy that reads the targets file
// (Homebrew, Linux and runs from source), past the 4-hour saved answer.
// INF-2670, the captain's answers: the up-to-date line says when it checked, and the command
// shows in the Version row with Copy command, as in the notice.
// INF-3405, the captain's direction B: Check for updates stays beside Copy command.
test("Check for updates reads the targets file again within four hours, and says when it cannot", async () => {
  tap = await startTap();
  tap.reply.targets = published({ stable: target("0.1.30") });
  const userDataDir = scratchDir("fm-update-check-");
  writeInstallerMarker(userDataDir, "stable");
  const { app, page } = await launchInstalled(userDataDir, "0.1.30");
  await runFromSearch(app, page, "updates.check");
  const version = page.locator('[data-setting="version"]');
  const button = version.getByRole("button", { name: UPDATE_WORDS.check, exact: true });
  const line = version.locator("[data-update-line]");
  await expect(line).toHaveText(
    `${UPDATE_NOTICES.latest("stable")} ${UPDATE_STEP_WORDS.checked("now")}`,
  );
  await expect(button).toBeFocused();
  // INF-2917, the captain: the button "being vertically centered looks really odd", so it sits
  // at the section's top right, above the update line, which runs to the same right edge.
  const [buttonBox, lineBox] = await Promise.all([button.boundingBox(), line.boundingBox()]);
  if (!buttonBox || !lineBox) throw new Error("the Version row is not drawn");
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(lineBox.y);
  // The line spans the button's columns too: the text runs the row's full width.
  expect(within({ ...lineBox, x: buttonBox.x, width: buttonBox.width }, lineBox)).toEqual([]);
  // Published since: the saved answer holds, and a press reads the file now.
  tap.reply.targets = published({ stable: target("0.1.31") });
  expect(await updateStatus(page)).toMatchObject({ updateAvailable: false });
  await pressKey(button, "Enter");
  await expect(line).toHaveText(new RegExp(UPDATE_NOTICES.available("0.1.31")));
  await expect(page.getByRole("button", { name: "Update available: 0.1.31" })).toBeVisible();
  await expect(version.getByText(upgradeCommandFor("stable"), { exact: true })).toBeVisible();
  await expect(version.getByRole("button", { name: UPDATE_WORDS.copy })).toBeVisible();
  await expect(button).toBeVisible();
  await pressKey(page.getByRole("button", { name: "Update available: 0.1.31" }), "Enter");
  await expect(
    page.locator("[data-update-channel]").getByText(upgradeCommandFor("stable"), { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // INF-3405, the captain's direction B: a refused read says so and keeps the version it found,
  // beside Check for updates and Copy command; it never says the copy is up to date.
  tap.reply.targets = { status: 500 };
  await runFromSearch(app, page, "updates.check");
  await expect(line).toHaveText(
    `${UPDATE_PROBLEMS.checkFailed} ${UPDATE_NOTICES.stillAvailable("0.1.31")} ${UPDATE_STEP_WORDS.command}`,
  );
  await expect(button).toBeFocused();
  await expect(version.getByRole("button", { name: UPDATE_WORDS.copy })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update available: 0.1.31" })).toBeVisible();
});
