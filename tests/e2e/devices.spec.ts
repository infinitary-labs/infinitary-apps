import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ownNetworkNames } from "@core/devices/computerName";
import { claimLink } from "@core/devices/dial";
import { shellWord } from "@core/devices/joinCommand";
import { JoinedHome } from "@core/devices/joinedHome";
import { OWN_KEY_COMMENT } from "@core/devices/ownKey";
import { writeInstalled } from "@core/helper/background";
import { joinHome } from "@core/helper/join";
import { type HelperRun, startHelper } from "@core/helper/run";
import { catalogRefreshesSettled } from "@core/pi/modelRuntime";
import { expect, type Page, test } from "@playwright/test";
import { CONNECTION_CLOSE } from "@shared/connection";
import {
  type DeviceView,
  deviceJoinedLine,
  deviceLabel,
  deviceWords,
  PAIRING_LINK_PREFIX,
  parsePairingLink,
} from "@shared/devices";
import { deviceUpdateBody, deviceUpdateCardId, deviceUpdateTitle } from "@shared/deviceUpdateNudge";
import type { FmEvent } from "@shared/events";
import { WORK_UPDATE_SINCE } from "@shared/ipc";
import { nearbyMacsWords } from "@shared/nearbyMacs";
import { remoteLoginWords, type WorkOutcome } from "@shared/remoteLogin";
import { sshConnectionWords } from "@shared/sshConnection";
import electronPath from "electron";
import {
  NO_NEW_WORK,
  PANEL_WORDS,
  RUNS_NO_PROJECT,
  removeLines,
  SEEN_WORDS,
} from "../../src/renderer/src/settings/devicesWords";
import { aDevice, COMPUTER } from "../../src/shared/deviceNames";
import { connectClient, freePort } from "../helpers/connectionClient";
import { standInDnsSd } from "../helpers/dnsSdStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../helpers/sshServer";
import {
  addStandInPayload,
  standInFirstmate,
  standInProgram,
  standInRecord,
} from "../helpers/standInFirstmate";
import { waitForFirstmateIdle } from "./crew";
import { builtAppDir, type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine, feedLineOf } from "./rails";
import { focusOn, pressKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * Settings -> Devices and Firstmate's cards for it (docs/devices.md): the
 * captain asks Firstmate to connect a Mac, clicks the card's button, and the
 * link stands in the tab alone; a device that knows only the wire joins
 * with it, Stop it closes a link, and Remove - in place or from a card -
 * cuts a device off. No card, feed line, record or saved file holds a link.
 */

/** Every file under `dir`, as bytes read as text, for a search. */
function savedText(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return savedText(path);
    if (!entry.isFile()) return [];
    return [{ file: path, text: readFileSync(path, "latin1") }];
  });
}

async function ask(page: Page, action: string, value: unknown) {
  const input = promptInput(page);
  await input.fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
  await input.press("Enter");
}

const linkInTab = (page: Page) => page.locator('[data-panel-state="open"] [data-device-link]');

/** + A Mac, then a link to paste into Firstmate there. */
/**
 * Firstmate at another app's first launch, as a device that knows only the
 * wire uses a link for a Mac: from this Mac itself it joins as a second app,
 * which only controls (docs/devices.md, "Joining").
 */
const AT_FIRST_LAUNCH = {
  kind: "mac",
  window: true,
  user: { name: userInfo().username, uid: process.getuid?.() ?? userInfo().uid },
} as const;

async function addMacByLink(page: Page) {
  await page.locator('[data-device-add="mac"]').click();
  await page
    .getByRole("button", { name: "Paste a link into Infinitary there", exact: true })
    .click();
}

test("a Mac joins with a link made from Firstmate's card, and Remove cuts it off", async () => {
  const app = await launchApp({ withMockProvider: true });
  const codes: string[] = [];
  try {
    const { page } = app;

    // Asked to connect a Mac, Firstmate offers one card; its button opens
    // Settings -> Devices and makes the link there.
    await ask(page, "device-invite", { name: "MacBook Air" });
    const make = page.getByRole("button", { name: "Make a link", exact: true });
    await expect(make).toBeVisible();
    const offered = await page.evaluate(() => window.infinitary.cards.list());
    expect(JSON.stringify(offered)).not.toContain(PAIRING_LINK_PREFIX);
    await waitForFirstmateIdle(page);
    await make.click();
    await expect(page.getByRole("tab", { name: "Devices", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const link = (await linkInTab(page).textContent()) ?? "";
    codes.push(parsePairingLink(link).code);

    // A device that knows only the wire uses it; the tab and the feed say so.
    const air = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "MacBook Air" });
    let airConnection = await connectClient(air);
    await expect(page.locator('[data-panel-state="joined"]')).toBeVisible();
    const airRow = page.locator(`[data-device-row="${air.deviceId}"]`);
    await expect(airRow).toContainText("MacBook Air");
    await expect(claimLink(link, { ...AT_FIRST_LAUNCH, name: "Again" })).rejects.toThrow();

    // While Firstmate is open there its row says it controls this Firstmate;
    // once it quits, the row says since when it is out of reach.
    const airListed = async () =>
      (await page.evaluate(() => window.infinitary.devices.list())).find(
        (device) => device.id === air.deviceId,
      );
    await expect(airRow).toHaveAttribute("data-controlling", "");
    expect(await airListed()).toMatchObject({ inReach: true, controlling: true });
    await airConnection.close();
    await expect(airRow).not.toHaveAttribute("data-controlling");
    expect(await airListed()).toMatchObject({
      inReach: false,
      controlling: false,
      seenAt: expect.any(Number),
    });
    airConnection = await connectClient(air);
    await expect(airRow).toHaveAttribute("data-controlling", "");

    // Stop it closes a link before anyone uses it.
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await addMacByLink(page);
    const stopped = (await linkInTab(page).textContent()) ?? "";
    codes.push(parsePairingLink(stopped).code);
    expect(stopped).not.toBe(link);
    await page.getByRole("button", { name: "Stop it", exact: true }).click();
    await expect(page.locator("[data-panel-state]")).toHaveCount(0);
    await expect(claimLink(stopped, { ...AT_FIRST_LAUNCH, name: "Late Mac" })).rejects.toThrow(
      "no open link",
    );

    // Remove asks once in place, then cuts the device off before it answers.
    await page.getByRole("button", { name: "Remove MacBook Air", exact: true }).click();
    const question = page.locator(`[data-device-removing="${air.deviceId}"]`);
    await question.getByRole("button", { name: "Remove", exact: true }).click();
    expect(await airConnection.closed).toBe(CONNECTION_CLOSE.unpaired);
    await expect(page.locator(`[data-device-row="${air.deviceId}"]`)).toHaveCount(0);

    // A second Mac from + A Mac, removed from Firstmate's card.
    await addMacByLink(page);
    const second = (await linkInTab(page).textContent()) ?? "";
    codes.push(parsePairingLink(second).code);
    const mini = await claimLink(second, { ...AT_FIRST_LAUNCH, name: "Mac mini" });
    const miniConnection = await connectClient(mini);
    await expect(page.locator(`[data-device-row="${mini.deviceId}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      feedLineOf(page, {
        type: "device_joined",
        deviceId: air.deviceId,
        name: "MacBook Air",
        kind: "view",
      }),
    ).toBeVisible();
    await ask(page, "device-remove", { deviceId: mini.deviceId });
    const removeMini = page.getByRole("button", { name: "Remove Mac mini", exact: true });
    await expect(removeMini).toBeVisible();
    await waitForFirstmateIdle(page);
    await removeMini.click();
    expect(await miniConnection.closed).toBe(CONNECTION_CLOSE.unpaired);
    await expect(page.locator(`[data-device-row="${mini.deviceId}"]`)).toHaveCount(0);
    expect(await page.evaluate(() => window.infinitary.devices.list())).toEqual([]);

    // Nothing the captain can read back, and nothing saved, holds a link.
    const readable = JSON.stringify([
      await page.evaluate(() => window.infinitary.cards.list()),
      await page.evaluate(() => window.infinitary.tasks.board()),
    ]);
    expect(readable).not.toContain(PAIRING_LINK_PREFIX);
    for (const code of codes) expect(readable).not.toContain(code);
    const holding = savedText(app.userDataDir)
      .filter(({ text }) => codes.some((code) => text.includes(code)))
      .map(({ file }) => file);
    expect(holding).toEqual([]);
  } finally {
    await app.close();
  }
});

const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };

/**
 * What a device is (docs/devices.md, "The shape"): each device says its
 * system and chip in its hello, the home keeps them beside its kind, and
 * Devices names it by them - a phone a phone, every computer a computer,
 * and one that never said a computer too.
 */
test("a device says what it is when it connects, and Devices names a phone a phone and a Linux computer a computer", async () => {
  const app = await launchApp({});
  const connections: Awaited<ReturnType<typeof connectClient>>[] = [];
  try {
    const { page } = app;
    const joined = async (name: string) => {
      const { link } = await page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
      return claimLink(link, { ...AT_FIRST_LAUNCH, name });
    };
    const pocket = await joined("Pocket");
    const studio = await joined("Studio");
    const quiet = await joined("Quiet");
    connections.push(await connectClient(pocket, { system: { system: "ios", chip: "arm64" } }));
    connections.push(await connectClient(studio, { system: { system: "linux", chip: "x64" } }));
    // A device too old to say what it is.
    connections.push(await connectClient(quiet));

    const listed = async (id: string) =>
      (await page.evaluate(() => window.infinitary.devices.list())).find(
        (device) => device.id === id,
      );
    await expect
      .poll(() => listed(pocket.deviceId))
      .toMatchObject({ kind: "view", system: "ios", chip: "arm64" });
    expect(await listed(studio.deviceId)).toMatchObject({ system: "linux", chip: "x64" });
    expect(await listed(quiet.deviceId)).not.toHaveProperty("system");

    await openDevices(page);
    const row = (deviceId: string) => page.locator(`[data-device-row="${deviceId}"]`);
    await expect(row(pocket.deviceId)).toContainText(aDevice({ system: "ios" }));
    await expect(row(studio.deviceId)).toContainText(aDevice({ system: "linux" }));
    await expect(row(quiet.deviceId)).toContainText(aDevice({}));
    await expect(row(studio.deviceId)).not.toContainText(aDevice({ system: "ios" }));
  } finally {
    for (const connection of connections) await connection.close();
    await app.close();
  }
});

/** Settings -> Devices, opened from the window's own Settings. */
async function openDevices(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Devices", exact: true }).click();
  await expect(page.locator("[data-devices]")).toBeVisible();
}

/**
 * This Mac's address changes: the app quits and starts again on the same
 * data, answering at another port, where a link made now sends a device.
 */
async function moveThisMac(app: LaunchedApp, env: Record<string, string> = {}) {
  const { userDataDir, homeDir, mockProvider } = app;
  await app.close();
  return launchApp({
    userDataDir,
    homeDir,
    ...(mockProvider ? { reuseMockProvider: mockProvider } : {}),
    env: { ...env, INFINITARY_CONNECTION_LOOPBACK_PORT: String(await freePort()) },
  });
}

/** A computer that runs work, as the work mode runs it in the background, from its data folder. */
function workRuns(runs: HelperRun[], dataDir: string) {
  return () => {
    const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return started.run;
  };
}

/** A project where it lives - a bare repository on this disk - and the home's clone of it. */
function projectWithOrigin(): string {
  const root = scratchDir("infinitary-e2e-computer-project-");
  const origin = join(root, "origin.git");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd });
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  git(website, ["add", "-A"]);
  git(website, ["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "commit", "-qm", "start"]);
  git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  return website;
}

test("another user on this Mac joins with a command made from Firstmate's card, Devices lists what it runs, and Remove takes it off", async () => {
  process.env.PI_OFFLINE = "1";
  const app: LaunchedApp = await launchApp({ withMockProvider: true });
  const runs: HelperRun[] = [];
  try {
    const { page } = app;
    const dataDir = scratchDir("infinitary-e2e-builder-");
    const run = () => {
      const started = startHelper({ dataDir, say: () => {}, retryMs: [50], log: () => {} });
      if (!started.ok) throw new Error(started.reason);
      runs.push(started.run);
      return started.run;
    };

    // Asked to run work as another user, Firstmate offers one card; its
    // button opens Devices and makes the command there.
    await ask(page, "device-invite", { how: "another-user" });
    const make = page.getByRole("button", { name: "Make the command", exact: true });
    await expect(make).toBeVisible();
    await waitForFirstmateIdle(page);
    await make.click();
    const panel = page.locator('[data-panel-state="open"][data-panel-holds="command"]');
    await expect(panel).toContainText(PANEL_WORDS["user-command"].say[0]);
    const command = (await linkInTab(page).textContent()) ?? "";
    expect(command).toContain("'work' 'join' '");
    const link = command.slice(command.indexOf(PAIRING_LINK_PREFIX), command.lastIndexOf("'"));
    expect(parsePairingLink(link).kind).toBe("work");
    expect(JSON.stringify(await page.evaluate(() => window.infinitary.cards.list()))).not.toContain(
      PAIRING_LINK_PREFIX,
    );

    // The command run as that user: it joins, and the panel and the feed say so.
    const joined = await joinHome({
      text: link,
      dataDir,
      io: { say: () => {}, ask: async () => "yes" },
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 5_000,
    });
    if (!joined.ok) throw new Error(joined.reason);
    const deviceId = joined.grant.deviceId;
    /** The computer as Devices lists it, for the words its row and Remove say. */
    const builder: DeviceView = {
      id: deviceId,
      kind: "work",
      name: "MacBook Pro",
      pairedAt: 0,
      user: "builder",
      onThisMac: true,
    };
    const set = deviceJoinedLine({
      name: "MacBook Pro",
      kind: "work",
      user: "builder",
      onThisMac: true,
    });
    await expect(page.locator('[data-panel-state="joined"]')).toContainText(set);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const helper = run();
    await expect.poll(() => helper.state().contact).toBe("in-reach");

    // Devices lists it with what it runs, its sign-ins, its tasks and when it was seen.
    const row = page.locator(`[data-device-row="${deviceId}"]`);
    await expect(row).toContainText(deviceLabel(builder));
    await expect(row).toContainText(SEEN_WORDS.now);
    await expect(row).toContainText(RUNS_NO_PROJECT);
    await expect(row).toContainText("idle");
    const { repo } = await page.evaluate(
      (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
      projectWithOrigin(),
    );
    await page.evaluate(([id, device]) => window.infinitary.devices.runsOn(id, device), [
      repo.id,
      deviceId,
    ] as const);
    await expect(row).toContainText("Runs website");

    // Out of reach, Remove asks whether to wait for it; waiting can be taken back.
    await helper.stop();
    await expect(row).toContainText(SEEN_WORDS.since);
    await row.getByRole("button", { name: "Remove Running as Builder", exact: true }).click();
    const question = page.locator(`[data-device-removing="${deviceId}"]`);
    await expect(question).toContainText(removeLines({ ...builder, inReach: false })[0]);
    await question.getByRole("button", { name: "Remove when it is back", exact: true }).click();
    await expect(row).toContainText(SEEN_WORDS.removedWhenBack);
    await row.getByRole("button", { name: "Keep it", exact: true }).click();
    await expect(row.getByRole("button", { name: "Remove Running as Builder" })).toBeVisible();

    // A new command from here, run as that user, finds this Mac again as the
    // same computer, as it does once this Mac's address changed.
    await page.locator('[data-device-add="user"]').click();
    const next = (await linkInTab(page).textContent()) ?? "";
    const found = await joinHome({
      text: next.slice(next.indexOf(PAIRING_LINK_PREFIX), next.lastIndexOf("'")),
      dataDir,
      io: { say: () => {}, ask: async () => "yes" },
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 5_000,
    });
    expect(found).toMatchObject({ ok: true, again: true, grant: { deviceId } });
    await expect(page.locator('[data-panel-state="joined"]')).toContainText(
      deviceJoinedLine({
        name: "MacBook Pro",
        kind: "work",
        user: "builder",
        onThisMac: true,
        again: true,
      }),
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(
      (await page.evaluate(() => window.infinitary.devices.list())).map(({ id }) => id),
    ).toEqual([deviceId]);
    await expect(row).toContainText("Runs website");

    // Back in reach, Remove brings its work here, then takes it off the list.
    const again = run();
    await expect.poll(() => again.state().contact).toBe("in-reach");
    await expect(row).toContainText(SEEN_WORDS.now);
    await row.getByRole("button", { name: "Remove Running as Builder", exact: true }).click();
    await expect(question).toContainText(removeLines({ ...builder, inReach: true })[0]);
    await question.getByRole("button", { name: "Remove", exact: true }).click();
    expect(await again.ended).toBe("removed");
    await expect(row).toHaveCount(0);
    expect((await page.evaluate(() => window.infinitary.repos.list()))[0]?.runsOn).toBeNull();
    await page.keyboard.press("Escape");
    await expect(
      feedLine(
        page,
        deviceWords.removed({
          id: deviceId,
          kind: "work",
          name: "MacBook Pro",
          pairedAt: 0,
          user: "builder",
          onThisMac: true,
          runs: ["website"],
        }),
      ),
    ).toBeVisible();
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
  }
});

test("the captain asks Firstmate to add a Mac at its address: Devices reaches it over SSH and sets it up, and a refusal says what to do", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  // The other Mac: a throwaway SSH server on loopback, a user there with a
  // home of its own, and the Firstmate this Mac sends, a stand-in that joins
  // at the wire as another user.
  const sshd = await startSshServer();
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const ssh = sshd.ssh({
    remote: {
      HOME: them,
      INFINITARY_HELPER_DATA_DIR: join(them, "work"),
      INFINITARY_DEVICE_NAME: "Mac mini",
    },
  });
  const app = await launchApp({
    withMockProvider: true,
    env: {
      INFINITARY_SSH: ssh.program,
      INFINITARY_APP_BUNDLE: standInFirstmate(record, BUILDER.uid),
    },
  });
  try {
    const { page } = app;

    // Asked to add the Mac at an address, Firstmate offers one card; its
    // button opens Devices and adds it there.
    await ask(page, "device-invite", { how: "address", address: sshd.address });
    const add = page.getByRole("button", { name: "Add it", exact: true });
    await expect(add).toBeVisible();
    await waitForFirstmateIdle(page);
    await add.click();
    await expect(page.getByRole("tab", { name: "Devices", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The first reach shows the check line and sends nothing until this is the Mac.
    const check = page.locator("[data-device-confirm-question]");
    await expect(check).toBeVisible();
    await expect(check).not.toContainText("Terminal");
    await check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }).click();
    // It joins and stands in the list, named as it joined.
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
      .toBe(1);
    const [device] = await page.evaluate(() => window.infinitary.devices.list());
    expect(device).toMatchObject({ kind: "work", user: "sam", remoteLogin: sshd.address });
    await expect(page.locator(`[data-device-row="${device?.id}"]`)).toContainText(
      deviceLabel({ name: "Mac mini", user: "sam", onThisMac: true }),
    );
    await expect(page.locator("[data-device-adding]")).toHaveCount(0);
    // The link went on the other Mac's input, never in its words.
    expect(readFileSync(record, "utf8")).toContain("link on its input");

    // + A Mac, by its address: an address nothing answers at says so, here and in the feed.
    await page.locator('[data-device-add="mac"]').click();
    await page.getByRole("button", { name: "By its address", exact: true }).click();
    await page.getByLabel(`The other ${COMPUTER.one}'s address`).fill("sam@no-such-mac.invalid");
    await page.getByRole("button", { name: "Add it", exact: true }).click();
    const refusedAddress = "sam@no-such-mac.invalid";
    const [what, todo] = remoteLoginWords.refused("unreachable", { address: refusedAddress });
    const question = page.locator("[data-device-address-question]");
    const field = question.getByRole("textbox");
    await expect(question).toBeVisible();
    await expect(field).toHaveValue(refusedAddress);
    await expect(question.locator("[data-device-address-refusal]")).toHaveCount(2);
    await expect(question).toContainText(what);
    await expect(question).toContainText(todo);
    const again = question.getByRole("button", { name: "Try again", exact: true });
    const cancel = question.getByRole("button", { name: "Cancel", exact: true });
    await focusOn(field);
    await page.keyboard.press("Tab");
    await expect(again).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    // Try again is the captain's own key. An address that never answers is said
    // again, and nothing is signed in to, so the feed does not say a key was used.
    await page.evaluate((said) => {
      const seen = window as Window & { __addressRefusals?: number };
      seen.__addressRefusals = 0;
      window.infinitary.events.on((event) => {
        if (event.type === "device_setup" && event.doing === "add" && event.text === said) {
          seen.__addressRefusals = (seen.__addressRefusals ?? 0) + 1;
        }
      });
    }, what);
    await pressKey(again, "Enter");
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __addressRefusals?: number }).__addressRefusals),
      )
      .toBe(1);
    await expect(field).toHaveValue(refusedAddress);
    await expect(question.locator("[data-device-address-refusal]")).toHaveCount(2);
    await pressKey(cancel, "Enter");
    await expect(question).toHaveCount(0);
    expect(await page.evaluate(() => window.infinitary.devices.list())).toHaveLength(1);

    await page.keyboard.press("Escape");
    // Try again said the same two lines again. Nothing else was added, and no key was used.
    await expect(feedLine(page, remoteLoginWords.reaching(refusedAddress))).toHaveCount(0);
    await expect(feedLine(page, what)).toHaveCount(2);
    await expect(feedLine(page, todo)).toHaveCount(2);
    for (const line of [
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      deviceJoinedLine({ name: "Mac mini", kind: "work", user: "sam", onThisMac: true }),
    ])
      await expect(feedLine(page, line)).toBeVisible();

    // Nothing the captain can read back, and nothing saved, holds the link.
    const { code, curl } = standInRecord(record);
    expect(code).toHaveLength(43);
    expect(curl).not.toEqual([]);
    expect(curl.filter((started) => started.includes(code))).toEqual([]);
    const readable = JSON.stringify([
      await page.evaluate(() => window.infinitary.cards.list()),
      await page.evaluate(() => window.infinitary.tasks.board()),
    ]);
    expect(readable).not.toContain(PAIRING_LINK_PREFIX);
    expect(readable).not.toContain(code);
    expect(
      savedText(app.userDataDir)
        .filter(({ text }) => text.includes(code))
        .map(({ file }) => file),
    ).toEqual([]);
  } finally {
    await app.close();
    await sshd.stop();
  }
});

test("a Mac whose user runs another Firstmate's work: Add it asks once, Cancel changes nothing, and Leave it and add, from the keyboard, adds it", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  // That user there runs work for another Firstmate already: its grant names that one's key.
  const sshd = await startSshServer();
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const work = join(them, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, "home.json"),
    `${JSON.stringify({ version: 1, grant: { homeKey: "O".repeat(43), deviceId: "old-mini" } })}\n`,
  );
  const ssh = sshd.ssh({
    remote: { HOME: them, INFINITARY_HELPER_DATA_DIR: work, INFINITARY_DEVICE_NAME: "Mac mini" },
  });
  const app = await launchApp({
    withMockProvider: true,
    env: {
      INFINITARY_SSH: ssh.program,
      INFINITARY_APP_BUNDLE: standInFirstmate(record, BUILDER.uid),
    },
  });
  const started = () => (existsSync(record) ? readFileSync(record, "utf8") : "");
  try {
    const { page } = app;
    await openDevices(page);
    const devices = page.locator("[data-devices]");
    const question = page.locator(`[data-device-leave-question="${sshd.address}"]`);
    const [found] = remoteLoginWords.leaveQuestion({ address: sshd.address, name: "Mac mini" });
    const addByAddress = async () => {
      await page.locator('[data-device-add="mac"]').click();
      await page.getByRole("button", { name: "By its address", exact: true }).click();
      await page.getByLabel(`The other ${COMPUTER.one}'s address`).fill(sshd.address);
      await page.keyboard.press("Enter");
    };

    // The check line comes first. This is the Mac, then the leave question.
    // Cancel holds the focus, and changes nothing.
    await addByAddress();
    const check = page.locator("[data-device-confirm-question]");
    await expect(check).toBeVisible();
    await pressKey(
      check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
      "Enter",
    );
    await expect(question).toContainText(String(found));
    await expect(question.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(question).toHaveCount(0);
    expect(started()).toBe("");
    expect(await page.evaluate(() => window.infinitary.devices.list())).toEqual([]);

    // Asked again, the captain's yes by keys: the join there is told to leave the other Firstmate.
    await addByAddress();
    await expect(question).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(
      question.getByRole("button", { name: "Leave it and add", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
      .toBe(1);
    const [device] = await page.evaluate(() => window.infinitary.devices.list());
    expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
    await expect(question).toHaveCount(0);
    expect(started()).toContain("leave on its input");
    if (!device) throw new Error("Nothing joined.");
    await expect(devices.locator(`[data-device-row="${device.id}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
    for (const line of remoteLoginWords.leftOther(device, { kept: 1, unremoved: 0 }))
      await expect(feedLine(page, line)).toBeVisible();
  } finally {
    await app.close();
    await sshd.stop();
  }
});

test("this Mac's address changes: a computer added by a command says how it comes back, and a new command brings it back as the same computer", async () => {
  process.env.PI_OFFLINE = "1";
  let app: LaunchedApp = await launchApp({ withMockProvider: true });
  const runs: HelperRun[] = [];
  const dataDir = scratchDir("infinitary-e2e-builder-");
  const run = workRuns(runs, dataDir);
  const runCommand = async (command: string) =>
    joinHome({
      text: command.slice(command.indexOf(PAIRING_LINK_PREFIX), command.lastIndexOf("'")),
      dataDir,
      io: { say: () => {}, ask: async () => "yes" },
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 5_000,
    });
  try {
    // Another user on this Mac joins with a command and runs website.
    await openDevices(app.page);
    await app.page.locator('[data-device-add="user"]').click();
    const joined = await runCommand((await linkInTab(app.page).textContent()) ?? "");
    if (!joined.ok) throw new Error(joined.reason);
    const deviceId = joined.grant.deviceId;
    await app.page.getByRole("button", { name: "Done", exact: true }).click();
    const first = run();
    await expect.poll(() => first.state().contact).toBe("in-reach");
    const { repo } = await app.page.evaluate(
      (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
      projectWithOrigin(),
    );
    await app.page.evaluate(([id, device]) => window.infinitary.devices.runsOn(id, device), [
      repo.id,
      deviceId,
    ] as const);
    await first.stop();

    // This Mac answers somewhere else now: Devices says the computer still
    // looks for it where it was, and offers the command that brings it back.
    app = await moveThisMac(app);
    const { page } = app;
    await openDevices(page);
    const row = page.locator(`[data-device-row="${deviceId}"]`);
    await expect(row.locator("[data-device-stranded]")).toBeVisible();
    const make = row.getByRole("button", { name: "Make a command", exact: true });
    await pressKey(make, "Enter");
    const panel = page.locator('[data-panel-state="open"][data-panel-holds="command"]');
    await expect(panel).toContainText(PANEL_WORDS["user-command"].say[0]);

    // Run as that user, it finds this Mac again as the same computer.
    const found = await runCommand((await linkInTab(page).textContent()) ?? "");
    expect(found).toMatchObject({ ok: true, again: true, grant: { deviceId } });
    await expect(page.locator('[data-panel-state="joined"]')).toContainText(
      deviceJoinedLine({
        name: "MacBook Pro",
        kind: "work",
        user: "builder",
        onThisMac: true,
        again: true,
      }),
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const back = run();
    await expect.poll(() => back.state().contact).toBe("in-reach");
    await expect(row).toContainText(SEEN_WORDS.now);
    await expect(row.locator("[data-device-stranded]")).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.infinitary.devices.list())).map(({ id }) => id),
    ).toEqual([deviceId]);
    expect((await page.evaluate(() => window.infinitary.repos.list()))[0]?.runsOn).toBe(deviceId);
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
    await app.mockProvider?.close();
  }
});

/**
 * The other Mac, reached over Remote Login: a throwaway SSH server on
 * loopback, a user there with a home of its own and the work folder its
 * Firstmate keeps, and the Firstmate this Mac sends, a stand-in that joins at
 * the wire and keeps its grant, whose controller is the built app's own.
 * `env` is what this Mac's app runs with to reach it; `removed` is what
 * removing it there answers.
 */
async function otherMacOverSsh(removed?: WorkOutcome) {
  const sshd = await startSshServer();
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const work = join(them, "work");
  const ssh = sshd.ssh({
    remote: {
      HOME: them,
      CFFIXED_USER_HOME: them,
      INFINITARY_HELPER_DATA_DIR: work,
      INFINITARY_DEVICE_NAME: "Mac mini",
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  const builtApp = join(scratchDir("infinitary-e2e-remote-app-"), "firstmate");
  writeFileSync(
    builtApp,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    { mode: 0o755 },
  );
  const bundle = standInFirstmate(record, BUILDER.uid, {
    joined: "running",
    updated: "running",
    connect: builtApp,
    ...(removed ? { removed } : {}),
  });
  return {
    sshd,
    them,
    work,
    bundle,
    env: { INFINITARY_SSH: ssh.program, INFINITARY_APP_BUNDLE: bundle },
  };
}

/** Whether a process is still running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** + A Mac, by its address, from the keyboard, in Devices: answers it once it joined. */
async function addByAddress(page: Page, address: string): Promise<DeviceView> {
  await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
  await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
  // The question takes the caret once it has drawn.
  await typeInto(page.locator("[data-device-address-question]").getByRole("textbox"), address);
  await page.keyboard.press("Enter");
  const check = page.locator("[data-device-confirm-question]");
  await expect(check).toBeVisible();
  await pressKey(
    check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
    "Enter",
  );
  await expect
    .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
    .toBe(1);
  await expect(page.locator("[data-device-adding]")).toHaveCount(0);
  await expect(page.locator("[data-device-address-question]")).toHaveCount(0);
  const [device] = await page.evaluate(() => window.infinitary.devices.list());
  if (!device) throw new Error("Nothing joined.");
  return device;
}

test("the first reach shows the check line and sends nothing until this is the Mac", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  test.setTimeout(120_000);
  process.env.PI_OFFLINE = "1";
  const sshd = await startSshServer();
  sshd.knownHosts("unknown");
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const ssh = sshd.ssh({
    remote: {
      HOME: them,
      CFFIXED_USER_HOME: them,
      INFINITARY_HELPER_DATA_DIR: join(them, "work"),
      INFINITARY_DEVICE_NAME: "Mac mini",
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  const bundle = standInFirstmate(record, BUILDER.uid, {
    joined: "running",
    updated: "running",
  });
  const app = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_SSH: ssh.program, INFINITARY_APP_BUNDLE: bundle },
  });
  try {
    const { page } = app;
    await openDevices(page);
    await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
    await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
    const question = page.locator("[data-device-address-question]");
    await typeInto(question.getByRole("textbox"), sshd.address);
    await page.keyboard.press("Enter");
    const check = page.locator("[data-device-confirm-question]");
    const [asked, compare] = remoteLoginWords.confirmQuestion(sshd.address);
    await expect(check).toBeVisible();
    await expect(check).toContainText(asked);
    await expect(check).toContainText(compare);
    await expect(check.locator("[data-device-check-line]")).toContainText("ED25519 SHA256:");
    await expect(check).not.toContainText("Terminal");
    await expect(page.locator("[data-device-adding]")).toHaveCount(0);
    const cancel = check.getByRole("button", { name: "Cancel", exact: true });
    const yes = check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(yes).toBeFocused();
    await pressKey(cancel, "Enter");
    await expect(check).toHaveCount(0);
    await expect(question.getByRole("textbox")).toHaveValue(sshd.address);
    expect(await page.evaluate(() => window.infinitary.devices.list())).toHaveLength(0);
    expect(existsSync(record)).toBe(false);
    await page.keyboard.press("Enter");
    await expect(check).toBeVisible();
    await pressKey(yes, "Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
      .toBe(1);
    await expect(check).toHaveCount(0);
    expect(readFileSync(record, "utf8")).toContain("link on its input");
  } finally {
    await app.close();
    await sshd.stop();
  }
});

test("adding a Mac by its address says how far the copy has gone: preparing it, what it sent so far, then starting it there", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  test.setTimeout(120_000);
  process.env.PI_OFFLINE = "1";
  const sshd = await startSshServer();
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const ssh = sshd.ssh({
    remote: {
      HOME: them,
      INFINITARY_HELPER_DATA_DIR: join(them, "work"),
      INFINITARY_DEVICE_NAME: "Mac mini",
    },
  });
  const bundle = standInFirstmate(record, BUILDER.uid);
  // Bytes that do not compress, so the copy takes many pieces.
  const payload = 8_000_000;
  addStandInPayload(bundle, randomBytes(payload));
  const app = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_SSH: ssh.program, INFINITARY_APP_BUNDLE: bundle },
  });
  try {
    const { page } = app;
    await openDevices(page);
    // Each step the core says as Settings hears it.
    await page.evaluate(() => {
      const seen = window as Window & { __setup?: unknown[] };
      seen.__setup = [];
      window.infinitary.events.on((event) => {
        if (event.type === "device_setup" && event.doing === "add") seen.__setup?.push(event);
      });
    });
    await addByAddress(page, sshd.address);
    const said = (await page.evaluate(
      () => (window as Window & { __setup?: unknown[] }).__setup ?? [],
    )) as Extract<FmEvent, { type: "device_setup" }>[];

    // Preparing it, then the bytes sent so far, each more than the last, then starting it there.
    const states = said.map((event) => event.copy?.state);
    const sending = said.filter((event) => event.copy?.state === "sending");
    const counts = sending.map((event) => event.copy?.sent ?? 0);
    expect(states.indexOf("preparing")).toBeGreaterThanOrEqual(0);
    expect(states.indexOf("sending")).toBeGreaterThan(states.indexOf("preparing"));
    expect(states.lastIndexOf("sending")).toBeLessThan(states.indexOf("starting"));
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const [index, count] of counts.entries())
      expect(count).toBeGreaterThan(index === 0 ? 0 : (counts[index - 1] ?? 0));
    expect(counts.at(-1)).toBeGreaterThan(payload);
    // No total rides it, and nothing says a share of one.
    for (const event of said) {
      expect(Object.keys(event.copy ?? {}).every((key) => key === "state" || key === "sent")).toBe(
        true,
      );
      expect(event.text).not.toContain("%");
    }

    // The feed keeps the count as one line, at all it sent, then says it is starting there.
    await page.keyboard.press("Escape");
    const last = sending.at(-1);
    if (!last) throw new Error("The copy's count was never said.");
    await expect(feedLineOf(page, last)).toBeVisible();
    await expect(feedLineOf(page, said[states.indexOf("starting")] as FmEvent)).toBeVisible();
    await expect(feedLineOf(page, sending[0] as FmEvent)).toHaveCount(0);
    expect(readFileSync(record, "utf8")).toContain("link on its input");
  } finally {
    await app.close();
    await sshd.stop();
  }
});

test("By its address lists Macs nearby but this one, and adds one picked and edited by keys", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  test.setTimeout(120_000);
  process.env.PI_OFFLINE = "1";
  const sshd = await startSshServer();
  sshd.knownHosts("unknown");
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const ssh = sshd.ssh({
    remote: {
      HOME: them,
      CFFIXED_USER_HOME: them,
      INFINITARY_HELPER_DATA_DIR: join(them, "work"),
      INFINITARY_DEVICE_NAME: "Mac mini",
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
    },
  });
  const bundle = standInFirstmate(record, BUILDER.uid, { joined: "running", updated: "running" });
  // Two Macs announce Remote Login: the throwaway SSH server on loopback, as
  // the Mac mini, and this Mac by its own name on the network.
  const [own = "this-mac.local"] = await ownNetworkNames();
  const dnsSd = standInDnsSd([
    { name: "Mac mini", at: "127.0.0.1" },
    { name: "This Mac", at: own },
  ]);
  const app = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_SSH: ssh.program, INFINITARY_APP_BUNDLE: bundle, INFINITARY_DNS_SD: dnsSd },
  });
  try {
    const { page } = app;
    const user = userInfo().username;
    await openDevices(page);
    await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
    await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
    const question = page.locator("[data-device-address-question]");
    const field = question.getByRole("textbox");
    const nearby = question.locator("[data-device-nearby-mac]");
    // This Mac is never a row: only the Mac mini, with your user name.
    await expect(nearby).toHaveCount(1);
    await expect(nearby).toContainText("Mac mini");
    await expect(nearby).toContainText(`${user}@127.0.0.1`);
    await expect(question).not.toContainText("This Mac");
    await expect(nearby.locator("[data-device-nearby-on-list]")).toHaveCount(0);

    // ↓ from the field reaches the list, and Enter fills the field with the
    // user name selected, to change before Add it.
    await pressKey(field, "ArrowDown");
    await expect(nearby).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(`${user}@127.0.0.1`);
    expect(
      await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
    ).toEqual([0, user.length]);
    await typeInto(field, "someone");
    await expect(field).toHaveValue("someone@127.0.0.1");
    // Only this test's own user is let in there, so it is typed back.
    await page.keyboard.press("Home");
    for (let left = "someone".length; left > 0; left -= 1) await page.keyboard.press("Delete");
    await typeInto(field, user);
    await expect(field).toHaveValue(sshd.address);
    await page.keyboard.press("Enter");
    const check = page.locator("[data-device-confirm-question]");
    await expect(check).toBeVisible();
    await pressKey(
      check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
      "Enter",
    );
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
      .toBe(1);
    await expect(page.locator("[data-device-address-question]")).toHaveCount(0);

    // Open again, the Mac just added is marked.
    await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
    await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
    await expect(nearby.locator("[data-device-nearby-on-list]")).toHaveText(nearbyMacsWords.onList);
    // Closed, it stops looking: no run of dns-sd is left.
    await pressKey(question.getByRole("button", { name: "Cancel", exact: true }), "Enter");
    const runs = readFileSync(join(dirname(dnsSd), "pids"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(runs.length).toBeGreaterThan(0);
    await expect.poll(() => runs.filter((pid) => running(Number(pid)))).toEqual([]);
  } finally {
    await app.close();
    await sshd.stop();
  }
});

test("By its address says when macOS has not allowed the local network, and still takes a typed address", async () => {
  const app = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_DNS_SD: standInDnsSd([], { denied: true }) },
  });
  try {
    const { page } = app;
    await openDevices(page);
    await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
    await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
    const question = page.locator("[data-device-address-question]");
    const [notAllowed, allowIt] = nearbyMacsWords.notAllowed;
    await expect(question.locator("[data-device-nearby-not-allowed]")).toContainText(notAllowed);
    await expect(question.locator("[data-device-nearby-not-allowed]")).toContainText(allowIt);
    await expect(question.locator("[data-device-nearby-mac]")).toHaveCount(0);
    // A private network's name still goes in, and Add it takes it.
    const field = question.getByRole("textbox");
    await typeInto(field, "sam@studio.tailnet-1a2b.ts.net");
    await expect(field).toHaveValue("sam@studio.tailnet-1a2b.ts.net");
    await expect(question.getByRole("button", { name: "Add it", exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("a Mac that did not let your SSH key in asks for that user's password once, says a wrong one, and adds it with Firstmate's own key, from the keyboard", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  test.setTimeout(120_000);
  // Invented for this test: no person's password, and never kept anywhere.
  const PASSWORD = "invented-e2e-pw-71d3";
  const WRONG = "not-the-e2e-pw-0a9c";
  const record = join(scratchDir("infinitary-e2e-remote-record-"), "started");
  const them = scratchDir("infinitary-e2e-remote-user-");
  const sshd = await startSshServer({ passwords: true, home: them });
  sshd.knownHosts("unknown");
  const ssh = sshd.ssh({
    key: "refused",
    password: PASSWORD,
    remote: {
      HOME: them,
      INFINITARY_HELPER_DATA_DIR: join(them, "work"),
      INFINITARY_DEVICE_NAME: "Mac mini",
    },
  });
  const app = await launchApp({
    withMockProvider: true,
    env: {
      INFINITARY_SSH: ssh.program,
      INFINITARY_APP_BUNDLE: standInFirstmate(record, BUILDER.uid),
    },
  });
  try {
    const { page } = app;
    await openDevices(page);
    await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
    await pressKey(page.getByRole("button", { name: "By its address", exact: true }), "Enter");
    await typeInto(
      page.locator("[data-device-address-question]").getByRole("textbox"),
      sshd.address,
    );
    await page.keyboard.press("Enter");
    const check = page.locator("[data-device-confirm-question]");
    await pressKey(
      check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
      "Enter",
    );

    // That Mac did not let the captain's key in: the password is asked, once, in its own field.
    const asked = page.locator("[data-device-password-question]");
    const [found, say] = remoteLoginWords.passwordQuestion(sshd.address);
    await expect(asked).toBeVisible();
    await expect(asked).toContainText(found);
    await expect(asked).toContainText(say);
    const field = asked.getByLabel(remoteLoginWords.passwordField(userInfo().username));
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toBeFocused();
    expect(existsSync(record)).toBe(false);

    // A wrong one is said there, and the field is empty again.
    await typeInto(field, WRONG);
    await page.keyboard.press("Enter");
    const [what, todo] = remoteLoginWords.refused("password-wrong", { address: sshd.address });
    await expect(asked.locator("[data-device-password-refusal]")).toHaveCount(2);
    await expect(asked).toContainText(what);
    await expect(asked).toContainText(todo);
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    const addIt = asked.getByRole("button", { name: "Add it", exact: true });
    const cancel = asked.getByRole("button", { name: "Cancel", exact: true });
    await typeInto(field, PASSWORD);
    await page.keyboard.press("Tab");
    await expect(addIt).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await pressKey(addIt, "Enter");

    // Firstmate's own key is let in there, and the Mac joins as any Mac added by its address.
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.devices.list())).length)
      .toBe(1);
    await expect(asked).toHaveCount(0);
    const [device] = await page.evaluate(() => window.infinitary.devices.list());
    expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
    expect(readFileSync(join(them, ".ssh", "authorized_keys"), "utf8")).toMatch(
      new RegExp(`^ssh-ed25519 \\S+ ${OWN_KEY_COMMENT}\n$`),
    );
    await page.keyboard.press("Escape");
    await expect(feedLine(page, remoteLoginWords.lettingIn(sshd.address)).first()).toBeVisible();
    await expect(feedLine(page, what)).toHaveCount(1);

    // Neither password is in the feed, a card, a task, a saved file, or any ssh's arguments.
    const readable = JSON.stringify([
      await page.evaluate(() => window.infinitary.cards.list()),
      await page.evaluate(() => window.infinitary.tasks.board()),
    ]);
    for (const typed of [PASSWORD, WRONG]) {
      await expect(feedLine(page, typed)).toHaveCount(0);
      expect(readable).not.toContain(typed);
      expect(
        savedText(app.userDataDir)
          .filter(({ text }) => text.includes(typed))
          .map(({ file }) => file),
      ).toEqual([]);
      expect(sshd.sshRuns().filter((run) => run.args.join(" ").includes(typed))).toEqual([]);
      expect(sshd.sshRuns().some((run) => run.envHeldPassword)).toBe(false);
    }
  } finally {
    await app.close();
    await sshd.stop();
  }
});

test("a Mac added by its address is reached over this Mac's own SSH: it comes back by itself when this Mac moves, says why when SSH stops it, and Try again and Change address work from the keyboard", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  process.env.PI_OFFLINE = "1";
  const { sshd, work, env } = await otherMacOverSsh();
  let app: LaunchedApp = await launchApp({ withMockProvider: true, env });
  const runs: HelperRun[] = [];
  // Its run there dials this Mac through the route its controller keeps.
  const run = workRuns(runs, work);
  try {
    await openDevices(app.page);
    const device = await addByAddress(app.page, sshd.address);
    const label = deviceLabel(device);
    const runner = run();
    await expect.poll(() => runner.state().contact, { timeout: 30_000 }).toBe("in-reach");
    const row = () => app.page.locator(`[data-device-row="${device.id}"]`);
    // Where this Mac's SSH connection to it stands, as the list says it.
    const ssh = async () =>
      (await app.page.evaluate(() => window.infinitary.devices.list()))[0]?.ssh;
    const connected = sshConnectionWords.detail({ state: "connected" }, device);
    await expect.poll(ssh).toEqual({ state: "connected" });
    await expect(row()).toContainText(connected);

    // This Mac quits and starts again at another port, and that Mac answers unlike
    // the key Firstmate remembered: this Mac stops trying, and Devices says why, with Try again.
    const trustPath = join(app.userDataDir, "devices", "host-trust.json");
    const remembered = readFileSync(trustPath, "utf8");
    const unlike = JSON.parse(remembered) as {
      hosts: Record<string, { publicKey: string; line: string }>;
    };
    const host = unlike.hosts[sshd.address];
    if (!host) throw new Error("Nothing was remembered for that address.");
    host.publicKey = "AQID";
    host.line = "ED25519 SHA256:not-this-mac";
    writeFileSync(trustPath, JSON.stringify(unlike), { mode: 0o600 });
    app = await moveThisMac(app, env);
    await openDevices(app.page);
    const [why] = sshConnectionWords.stopped("host-changed", { address: sshd.address, device });
    await expect.poll(ssh).toEqual({ state: "stopped", reason: "host-changed" });
    await expect(row().locator("[data-device-ssh-stopped]")).toContainText(why);
    await expect(
      row().getByRole("button", { name: `Try again to reach ${label}`, exact: true }),
    ).toBeVisible();

    // The remembered key matches again: this Mac starts again and reaches it.
    writeFileSync(trustPath, remembered, { mode: 0o600 });
    app = await moveThisMac(app, env);
    await openDevices(app.page);
    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "connected" });
    await expect(row().locator("[data-device-ssh-stopped]")).toHaveCount(0);
    expect(runner.state().contact).toBe("in-reach");

    // Change address, from the keyboard: the same Mac under another name.
    await pressKey(
      row().getByRole("button", { name: `Change the address of ${label}`, exact: true }),
      "Enter",
    );
    const field = app.page.getByLabel(sshConnectionWords.changeAddress(device));
    await expect(field).toBeFocused();
    await field.fill(sshd.alias);
    await app.page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await app.page.evaluate(() => window.infinitary.devices.list()))[0]?.remoteLogin,
        { timeout: 30_000 },
      )
      .toBe(sshd.alias);
    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "connected" });
    await expect(row()).toContainText(`${sshd.alias} · ${connected}`);

    // Stopped again after another restart, Try again by name in command search.
    sshd.knownHosts("changed");
    app = await moveThisMac(app, env);
    await openDevices(app.page);
    await expect.poll(ssh).toEqual({ state: "stopped", reason: "host-changed" });
    sshd.knownHosts("known");
    await runFromSearch(app.app, app.page, "devices.try-again");
    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "connected" });

    await app.page.keyboard.press("Escape");
    for (const line of [
      why,
      sshConnectionWords.back(device),
      sshConnectionWords.addressChanged(device, sshd.alias),
    ])
      await expect(feedLine(app.page, line).first()).toBeVisible();
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
    await app.mockProvider?.close();
    await sshd.stop();
  }
});

test("a Mac added by its address that leaves for another Firstmate: this Mac stops trying and says so, and Remove takes it off the list now, without waiting for it", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  process.env.PI_OFFLINE = "1";
  // Removing it there is refused, as the work mode refuses another home's folder.
  const { sshd, work, env } = await otherMacOverSsh({ firstmate: "refused", reason: "other-home" });
  let app: LaunchedApp = await launchApp({ withMockProvider: true, env });
  const runs: HelperRun[] = [];
  const run = workRuns(runs, work);
  try {
    await openDevices(app.page);
    const device = await addByAddress(app.page, sshd.address);
    const label = deviceLabel(device);
    const runner = run();
    const ssh = async () =>
      (await app.page.evaluate(() => window.infinitary.devices.list()))[0]?.ssh;
    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "connected" });

    // While this Mac is quit, that Mac leaves it for another Firstmate: its
    // work for this one ends, and its grant names the other home.
    await runner.stop();
    const there = new JoinedHome(work, () => {});
    const joined = there.read();
    if (!joined) throw new Error("Nothing joined there.");
    there.join({ ...joined.grant, homeKey: "A".repeat(43) }, joined.joinedAt);
    app = await moveThisMac(app, env);
    await openDevices(app.page);

    // This Mac stops trying, and Devices and the feed say why and what to do.
    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "stopped", reason: "other-home" });
    const lines = sshConnectionWords.stopped("other-home", { address: sshd.address, device });
    const row = app.page.locator(`[data-device-row="${device.id}"]`);
    await expect(row.locator("[data-device-ssh-stopped]")).toHaveText(lines.join(" "));
    // It is not coming back, so Try again and Change address are not offered.
    await expect(row.getByRole("button", { name: `Try again to reach ${label}` })).toHaveCount(0);
    await expect(row.getByRole("button", { name: `Change the address of ${label}` })).toHaveCount(
      0,
    );

    // Remove, from the keyboard: it is not coming back, so nothing waits for it.
    await pressKey(row.getByRole("button", { name: `Remove ${label}`, exact: true }), "Enter");
    const question = app.page.locator(`[data-device-removing="${device.id}"]`);
    await expect(question.getByRole("button")).toHaveText(["Keep it", "Remove now"]);
    await pressKey(question.getByRole("button", { name: "Remove now", exact: true }), "Enter");
    await expect
      .poll(async () => (await app.page.evaluate(() => window.infinitary.devices.list())).length)
      .toBe(0);

    await app.page.keyboard.press("Escape");
    for (const line of lines) await expect(feedLine(app.page, line).first()).toBeVisible();
    // Its folder there is the other Firstmate's, so nothing there was removed.
    await expect(feedLine(app.page, remoteLoginWords.nothingThere(device)).first()).toBeVisible();
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
    await app.mockProvider?.close();
    await sshd.stop();
  }
});

test("a Mac a command added that macOS holds on the local network: Devices says why, and Add it by its address, from the keyboard, brings it back over this Mac's own SSH", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  process.env.PI_OFFLINE = "1";
  const { sshd, them, work, bundle, env } = await otherMacOverSsh();
  let app: LaunchedApp = await launchApp({ withMockProvider: true, env });
  const runs: HelperRun[] = [];
  try {
    // The command for another Mac, made here.
    await openDevices(app.page);
    await app.page.locator('[data-device-add="mac"]').click();
    await app.page.getByRole("button", { name: "Run a command there", exact: true }).click();
    const command = (await linkInTab(app.page).textContent()) ?? "";
    const link = command.slice(
      command.indexOf(PAIRING_LINK_PREFIX),
      command.indexOf("'", command.indexOf(PAIRING_LINK_PREFIX)),
    );
    expect(parsePairingLink(link)).toMatchObject({ kind: "mac" });
    expect(parsePairingLink(link)).not.toHaveProperty("via");
    // Its copy there joins with that link, dialing this Mac's address itself.
    const joined = execFileSync(standInProgram(bundle), ["work", "join", "--from-home"], {
      input: `${JSON.stringify({ link })}\n`,
      env: { ...process.env, HOME: them, INFINITARY_HELPER_DATA_DIR: work },
      encoding: "utf8",
    });
    expect(joined).toContain('"firstmate":"joined"');
    const [device] = await app.page.evaluate(() => window.infinitary.devices.list());
    if (!device) throw new Error("Nothing joined.");
    expect(device).not.toHaveProperty("remoteLogin");

    // This Mac quits. The hermetic launch listens on loopback alone, so what a
    // Mac elsewhere leaves on the list after joining at this Mac's address on
    // the local network is written as pairing keeps it: where it joined from,
    // and where it dialed this Mac. Its work there never reached this Mac.
    const { userDataDir, homeDir, mockProvider } = app;
    await app.close();
    const devicesDir = join(userDataDir, "devices");
    const saved = JSON.parse(readFileSync(join(devicesDir, "devices.json"), "utf8")) as {
      devices: { id: string; onThisMac?: boolean }[];
    };
    for (const entry of saved.devices) if (entry.id === device.id) entry.onThisMac = false;
    writeFileSync(join(devicesDir, "devices.json"), JSON.stringify(saved), { mode: 0o600 });
    writeFileSync(
      join(devicesDir, "reached.json"),
      JSON.stringify({ version: 1, reached: { [device.id]: "192.168.4.48:47623" } }),
      { mode: 0o600 },
    );
    expect(existsSync(join(devicesDir, "seen.json"))).toBe(false);
    app = await launchApp({
      userDataDir,
      homeDir,
      ...(mockProvider ? { reuseMockProvider: mockProvider } : {}),
      env,
    });
    const { page } = app;

    // Devices says why it never came into reach, and offers its way back.
    await openDevices(page);
    const listed = async () =>
      (await page.evaluate(() => window.infinitary.devices.list())).find(
        (entry) => entry.id === device.id,
      );
    expect(await listed()).toMatchObject({ inReach: false, heldOnLocalNetwork: true });
    const row = page.locator(`[data-device-row="${device.id}"]`);
    await expect(row.locator("[data-device-held]")).toBeVisible();
    const label = deviceLabel({ ...device, onThisMac: false });

    // Add it by its address, from the keyboard: asked in place, then found again.
    await pressKey(
      row.getByRole("button", { name: `Add ${label} by its address`, exact: true }),
      "Enter",
    );
    const field = page.getByLabel(
      sshConnectionWords.changeAddress({ ...device, onThisMac: false }),
    );
    await typeInto(field, sshd.address);
    await page.keyboard.press("Enter");
    const check = page.locator("[data-device-confirm-question]");
    await expect(check).toBeVisible();
    await pressKey(
      check.getByRole("button", { name: `This is the ${COMPUTER.one}`, exact: true }),
      "Enter",
    );
    await expect
      .poll(async () => (await listed())?.remoteLogin, { timeout: 30_000 })
      .toBe(sshd.address);
    expect(
      (await page.evaluate(() => window.infinitary.devices.list())).map(({ id }) => id),
    ).toEqual([device.id]);

    // Its run there reaches this Mac through this Mac's own SSH connection.
    const runner = workRuns(runs, work)();
    await expect.poll(() => runner.state().contact, { timeout: 30_000 }).toBe("in-reach");
    await expect
      .poll(async () => (await listed())?.ssh, { timeout: 30_000 })
      .toEqual({
        state: "connected",
      });
    expect(await listed()).not.toHaveProperty("heldOnLocalNetwork");
    await expect(row.locator("[data-device-held]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      feedLine(page, remoteLoginWords.finding({ ...device, onThisMac: false })).first(),
    ).toBeVisible();
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
    await app.mockProvider?.close();
    await sshd.stop();
  }
});

test("a computer on another version of Firstmate: Devices says so, Update brings it to this Mac's version, and one too old gets the command", async () => {
  process.env.PI_OFFLINE = "1";
  const app: LaunchedApp = await launchApp({ withMockProvider: true });
  const runs: HelperRun[] = [];
  try {
    const { page } = app;
    const thisVersion = await app.app.evaluate(({ app: electron }) => electron.getVersion());
    const dataDir = scratchDir("infinitary-e2e-older-");
    const run = (versions: { appVersion: string; protocolVersion?: string }) => {
      const started = startHelper({
        dataDir,
        say: () => {},
        retryMs: [50],
        log: () => {},
        ...versions,
      });
      if (!started.ok) throw new Error(started.reason);
      runs.push(started.run);
      return started.run;
    };

    // Another user on this Mac joins with the command made in Devices.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    await page.locator('[data-device-add="user"]').click();
    const command = (await linkInTab(page).textContent()) ?? "";
    const joined = await joinHome({
      text: command.slice(command.indexOf(PAIRING_LINK_PREFIX), command.lastIndexOf("'")),
      dataDir,
      io: { say: () => {}, ask: async () => "yes" },
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 5_000,
    });
    if (!joined.ok) throw new Error(joined.reason);
    const deviceId = joined.grant.deviceId;
    const builder = { name: "MacBook Pro", user: "builder", onThisMac: true };
    await page.getByRole("button", { name: "Done", exact: true }).click();
    // What its join set up: the background that starts its run, from this Mac's own app.
    writeInstalled(dataDir, {
      service: {
        label: "com.kunchenguid.firstmate3000.dev.work",
        file: join(dataDir, "agent.plist"),
      },
      app: null,
    });

    // Its run is on an older Firstmate: the row says so, and still takes work.
    const oldApp = "0.0.1";
    const older = run({ appVersion: oldApp });
    const other = { app: oldApp, than: "older", takesWork: true, updateBy: "connection" } as const;
    const row = page.locator(`[data-device-row="${deviceId}"]`);
    await expect(row).toHaveAttribute("data-other-version", "takes-work");
    await expect(row).toContainText(
      deviceWords.otherVersion({
        app: oldApp,
        than: "older",
        takesWork: true,
        updateBy: "connection",
      }),
    );
    await expect(row).toContainText(SEEN_WORDS.now);

    // The app raises one card for it, naming both versions.
    const nudgeId = deviceUpdateCardId(deviceId);
    const nudge = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).filter(
        (card) => card.id === nudgeId,
      );
    await expect.poll(async () => (await nudge()).length).toBe(1);
    const facts = { ...builder, deviceId, other, homeApp: thisVersion };
    expect((await nudge())[0]?.title).toBe(deviceUpdateTitle(facts));
    expect((await nudge())[0]?.body).toBe(deviceUpdateBody(facts));

    // Its Update it opens Devices and updates it there: it starts again on
    // this Mac's version, as its background does.
    await page.keyboard.press("Escape");
    // The join's setup card stands above it until it is turned down.
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await page.getByRole("button", { name: "Update it", exact: true }).click();
    await expect(row).toContainText(remoteLoginWords.updatingRow(builder));
    expect(await older.ended).toBe("updated");
    run({ appVersion: thisVersion });
    await expect(row).not.toHaveAttribute("data-other-version", /.+/);
    await expect(row).toContainText(SEEN_WORDS.now);
    await expect(row.getByRole("button", { name: "Update Running as Builder" })).toHaveCount(0);
    const devices = await page.evaluate(() => window.infinitary.devices.list());
    expect(devices.find((device) => device.id === deviceId)?.otherVersion).toBeUndefined();
    // The card is down, and it stays down.
    expect(await nudge()).toEqual([]);

    // Too old to take the update order: it takes no new work, and Update
    // makes the command that updates it there. Its contract is the minor
    // just before the update order's.
    await runs.at(-1)?.stop();
    const [updateMajor, updateMinor] = WORK_UPDATE_SINCE.split(".").map(Number);
    const tooOld = `${updateMajor}.${Number(updateMinor) - 1}.0`;
    run({ appVersion: oldApp, protocolVersion: tooOld });
    await expect(row).toHaveAttribute("data-other-version", "no-work");
    await expect(row).toContainText(
      deviceWords.otherVersion({
        app: oldApp,
        than: "older",
        takesWork: false,
        updateBy: "command",
      }),
    );
    await expect(row).toContainText(NO_NEW_WORK);
    await row.getByRole("button", { name: "Update Running as Builder", exact: true }).click();
    await expect(
      page.locator('[data-panel-state="open"][data-panel-holds="command"]'),
    ).toContainText(PANEL_WORDS["user-command"].say[0]);

    await page.keyboard.press("Escape");
    const said = (stage: "updating" | "done", text: string) =>
      feedLineOf(page, {
        type: "device_update",
        deviceId,
        name: deviceLabel(builder),
        stage,
        text,
        tone: "info",
      });
    await expect(said("updating", remoteLoginWords.updating(builder))).toBeVisible();
    await expect(said("done", remoteLoginWords.updated(builder, "running"))).toBeVisible();
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
  }
});
