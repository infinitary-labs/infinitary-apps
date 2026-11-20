import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ANNOUNCE_SERVICE } from "@core/devices/announce";
import { claimLink } from "@core/devices/dial";
import { expect, type Page, test } from "@playwright/test";
import { CONNECTION_CLOSE } from "@shared/connection";
import { PAIRING_LINK_PREFIX, parsePairingLink, phoneRouteWords } from "@shared/devices";
import { PANEL_WORDS } from "../../src/renderer/src/settings/devicesWords";
import { aDevice, chipWords } from "../../src/shared/deviceNames";
import { connectClient } from "../helpers/connectionClient";
import { standInDnsSd } from "../helpers/dnsSdStandIn";
import { waitForFirstmateIdle } from "./crew";
import { ask, linkInTab, openDevices, selectDevice } from "./deviceFixtures";
import { launchApp } from "./launch";
import { feedLineOf } from "./rails";
import { savedText } from "./savedText";
import { pressKey } from "./windowKeys";

/**
 * Settings -> Devices and Firstmate's cards for it (docs/devices.md): the
 * captain asks Firstmate to connect a Mac, clicks the card's button, and the
 * link stands in the tab alone; a device that knows only the wire joins
 * with it, Stop it closes a link, and Remove - in place or from a card -
 * cuts a device off. No card, feed line, record or saved file holds a link.
 */

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
    const airRow = await selectDevice(page, air.deviceId);
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
    await expect(page.locator(`[data-device-select="${air.deviceId}"]`)).toHaveCount(0);

    // A second Mac from + A Mac, removed from Firstmate's card.
    await addMacByLink(page);
    const second = (await linkInTab(page).textContent()) ?? "";
    codes.push(parsePairingLink(second).code);
    const mini = await claimLink(second, { ...AT_FIRST_LAUNCH, name: "Mac mini" });
    const miniConnection = await connectClient(mini);
    await selectDevice(page, mini.deviceId);
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
    await expect(page.locator(`[data-device-select="${mini.deviceId}"]`)).toHaveCount(0);
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

/**
 * What a device is (docs/devices.md, "The shape"): each device says its
 * system and chip in its hello, the home keeps them beside its kind, and
 * Devices names it by them - a phone a phone, every computer a computer,
 * and one that never said a computer too.
 */
test("a device says what it is when it connects, and Devices names a phone a phone and a Linux computer a computer with its chip", async () => {
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
    const row = (deviceId: string) => selectDevice(page, deviceId);
    await expect(await row(pocket.deviceId)).toContainText(aDevice({ system: "ios" }));
    await expect(await row(studio.deviceId)).toContainText(aDevice({ system: "linux" }));
    await expect(await row(quiet.deviceId)).toContainText(aDevice({}));
    await expect(await row(studio.deviceId)).not.toContainText(aDevice({ system: "ios" }));
    // INF-1456: a computer's row names its chip, as it said it at pairing.
    await expect(await row(studio.deviceId)).toContainText(
      `${aDevice({ system: "linux" })} · ${chipWords("x64", "linux")} · `,
    );
    await expect(await row(quiet.deviceId)).toContainText(`${aDevice({})} · joined `);
  } finally {
    for (const connection of connections) await connection.close();
    await app.close();
  }
});

/**
 * INF-64 piece 1 (docs/devices.md, "Joining" and "Announcing to devices"):
 * a stand-in phone joins with a link for a Mac and is a view, not a
 * computer that runs work; this Mac announces itself over Bonjour while a phone
 * can join or is listed, and stops once neither holds. Never macOS's dns-sd.
 */
test("a phone joins as a view whichever link it used, and this Mac announces while it can join or is listed", async () => {
  const dnsSd = standInDnsSd([]);
  const app = await launchApp({ env: { INFINITARY_DNS_SD: dnsSd } });
  const asked = () =>
    existsSync(join(dirname(dnsSd), "args"))
      ? readFileSync(join(dirname(dnsSd), "args"), "utf8")
          .split("\n")
          .filter(Boolean)
      : [];
  try {
    const { page } = app;
    // Nothing is announced with no phone on the list.
    expect(asked().filter((line) => line.startsWith("-R"))).toEqual([]);
    const { link } = await page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    // INF-64 piece 2: the first phone can find the Mac before it is on the list.
    await expect.poll(() => asked().filter((line) => line.startsWith("-R"))).toHaveLength(1);
    // A phone says no macOS user and no window: only that it runs iOS.
    const phone = await claimLink(link, { kind: "mac", name: "Kun's iPhone", system: "ios" });
    expect(phone.kind).toBe("view");
    const listed = (await page.evaluate(() => window.infinitary.devices.list())).find(
      (device) => device.id === phone.deviceId,
    );
    expect(listed).toMatchObject({ kind: "view", system: "ios" });
    await expect.poll(() => asked().filter((line) => line.startsWith("-R"))).toHaveLength(1);
    expect(asked().find((line) => line.startsWith("-R"))).toMatch(
      new RegExp(` ${ANNOUNCE_SERVICE.replaceAll(".", "\\.")} local\\. \\d+$`),
    );

    await openDevices(page);
    const row = await selectDevice(page, phone.deviceId);
    await expect(row).toContainText(aDevice({ system: "ios" }));
    await page.getByRole("button", { name: "Remove Kun's iPhone", exact: true }).click();
    await page
      .locator(`[data-device-removing="${phone.deviceId}"]`)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    // The announcement ended with the last phone: the -R run is gone.
    const announcer = readFileSync(join(dirname(dnsSd), "pids"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number)[asked().findIndex((line) => line.startsWith("-R"))];
    await expect
      .poll(() => {
        try {
          process.kill(announcer ?? 0, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    await app.close();
  }
});

/** INF-64's accepted piece-2 scan-code choice: the phone panel works by keyboard and joins a view. */
test("A phone opens its code by keyboard, joins read-only and can stop an unused link", async () => {
  const app = await launchApp();
  try {
    const { page } = app;
    await openDevices(page);
    await pressKey(page.locator('[data-device-add="phone"]'), "Enter");
    const panel = page.locator('[data-panel-state="open"]');
    await expect(panel).toContainText(PANEL_WORDS.phone.say.join(" "));
    await expect(panel.locator("[data-phone-code]")).toBeVisible();
    const link = await panel.locator("[data-device-link]").innerText();
    const phone = await claimLink(link, { kind: "mac", name: "Test iPhone", system: "ios" });
    expect(phone.kind).toBe("view");
    await expect(page.locator('[data-panel-state="joined"]')).toContainText("Test iPhone");
    await pressKey(
      page
        .locator('[data-panel-state="joined"]')
        .getByRole("button", { name: "Done", exact: true }),
      "Enter",
    );
    await pressKey(page.locator('[data-device-add="phone"]'), "Enter");
    await expect(panel.locator("[data-phone-code]")).toBeVisible();
    await pressKey(panel.getByRole("button", { name: "Stop it", exact: true }), "Enter");
    await expect(page.locator("[data-phone-code]")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/** INF-1156 accepted option A: keyboard opening explains the detected route without promising reachability. */
test("phone links explain private preference and local-only fallback", async () => {
  for (const addresses of ["192.168.1.20,100.101.7.3", "192.168.1.20"]) {
    const app = await launchApp({ env: { INFINITARY_STAND_IN_ADDRESSES: addresses } });
    try {
      const { page } = app;
      await openDevices(page);
      await pressKey(page.locator('[data-device-add="phone"]'), "Enter");
      const panel = page.locator('[data-panel-state="open"]');
      const text = await panel.locator("[data-device-link]").innerText();
      await expect(panel).toContainText(phoneRouteWords(text));
      const link = parsePairingLink(text);
      if (addresses.includes("100.101.7.3")) {
        expect(link.at).toBe(`100.101.7.3:${app.connectionPort}`);
        expect(link.also).toContain(`192.168.1.20:${app.connectionPort}`);
      } else expect(link.at).not.toContain("100.101.7.3");
      await pressKey(panel.getByRole("button", { name: "Stop it", exact: true }), "Enter");
      await expect(page.locator("[data-phone-code]")).toHaveCount(0);
    } finally {
      await app.close();
    }
  }
});
