import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JoinedHome } from "@core/devices/joinedHome";
import { catalogRefreshesSettled } from "@core/pi/modelRuntime";
import { expect, test } from "@playwright/test";
import { deviceLabel, PAIRING_LINK_PREFIX, parsePairingLink } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { remoteLoginWords } from "@shared/remoteLogin";
import { sshConnectionWords } from "@shared/sshConnection";
import { COMPUTER } from "../../src/shared/deviceNames";
import { SSH_SERVER_AVAILABLE } from "../helpers/sshServer";
import { STAND_IN_JOINED, standInProgram } from "../helpers/standInFirstmate";
import {
  addByAddress,
  linkInTab,
  moveThisMac,
  openDevices,
  otherMacOverSsh,
  reachDot,
  rowAction,
  seedRemotePairing,
  selectDevice,
  workRuns,
} from "./deviceFixtures";
import { handoverCard, leaveSettings, offeredCard } from "./handoverCards";
import type { HelperRun } from "./helperRun";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import { feedLine } from "./rails";
import { pressKey, runFromSearch, typeInto } from "./windowKeys";

/**
 * A computer reached over this Mac's own SSH (docs/devices.md, "Reached over
 * your SSH"): it comes back by itself, says why SSH stopped, leaves for
 * another first mate, and one macOS holds on the local network comes back
 * by its address.
 */

test("a Mac added by its address is reached over this Mac's own SSH: it comes back by itself when this Mac moves, says why when SSH stops it, and Try again and Change address work from the keyboard", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  process.env.PI_OFFLINE = "1";
  const { sshd, work, env } = await otherMacOverSsh();
  // The stand-in outlives each restart below, so the first mate still answers the card's ask
  // after this Mac moves; a launch that started its own closes it with that app.
  const provider = await startMockProvider();
  let app: LaunchedApp = await launchApp({ reuseMockProvider: provider, env });
  const runs: HelperRun[] = [];
  // Its run there dials this Mac through the route its controller keeps.
  const run = workRuns(runs, work);
  try {
    await openDevices(app.page);
    const device = await addByAddress(app.page, sshd.address);
    const label = deviceLabel(device);
    const runner = run();
    await expect.poll(() => runner.state().contact, { timeout: 30_000 }).toBe("in-reach");
    await selectDevice(app.page, device.id);
    const row = () => app.page.locator(`[data-device-row="${device.id}"]`);
    const ssh = async () =>
      (await app.page.evaluate(() => window.infinitary.devices.list()))[0]?.ssh;
    await expect.poll(ssh).toEqual({ state: "connected" });
    await expect(reachDot(row())).toHaveAttribute("data-tone", "ok");
    await expect(row().locator("[data-device-identity]")).toContainText(sshd.address);

    const trustPath = join(app.userDataDir, "devices", "host-trust.json");
    const remembered = readFileSync(trustPath, "utf8");
    const unlike = JSON.parse(remembered) as {
      hosts: Record<string, { publicKey: string; line: string }>;
    };
    const host = unlike.hosts[sshd.address];
    if (!host) throw new Error("Nothing was remembered for that address.");
    host.publicKey = "AQID";
    host.line = "ED25519 SHA256:not-this-mac";
    // e2e-fixture: mutation -- prove a remembered host key mismatch stops the connection
    writeFileSync(trustPath, JSON.stringify(unlike), { mode: 0o600 });
    app = await moveThisMac(app, env);
    await openDevices(app.page);
    await selectDevice(app.page, device.id);
    const [why] = sshConnectionWords.stopped("host-changed", { address: sshd.address, device });
    await expect.poll(ssh).toEqual({ state: "stopped", reason: "host-changed" });
    await expect(row().locator("[data-device-ssh-stopped]")).toContainText(why);
    await expect(
      row().getByRole("button", { name: `Try again to reach ${label}`, exact: true }),
    ).toBeVisible();

    // The remembered key matches again: this Mac starts again and reaches it.
    // e2e-fixture: mutation -- restore the matching remembered key and prove the connection resumes
    writeFileSync(trustPath, remembered, { mode: 0o600 });
    app = await moveThisMac(app, env);
    await openDevices(app.page);
    await selectDevice(app.page, device.id);
    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "connected" });
    await expect(row().locator("[data-device-ssh-stopped]")).toHaveCount(0);
    expect(runner.state().contact).toBe("in-reach");

    // INF-5355: the first mate's card for a new address chooses this Mac's row in Devices, where
    // Change address is the captain's own button; nothing changes from the card.
    await leaveSettings(app.page);
    const devices = await app.page.evaluate(() => window.infinitary.devices.list());
    const offer = offeredCard("device-change-address", { deviceId: device.id }, devices);
    await askFirstmate(
      app.page,
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "device-change-address", value: { deviceId: device.id } }),
    );
    const card = await handoverCard(app.page, offer);
    await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
    await expect(row()).toHaveAttribute("data-device-acts", /\baddress\b/);
    expect((await app.page.evaluate(() => window.infinitary.devices.list()))[0]?.remoteLogin).toBe(
      sshd.address,
    );

    const change = await rowAction(app.page, device.id, "address");
    await expect(change).toHaveText(m.settingsDevicesChangeAddress());
    await app.page.keyboard.press("Enter");
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
    await expect(row().locator("[data-device-identity]")).toContainText(sshd.alias);
    await expect(reachDot(row())).toHaveAttribute("data-tone", "ok");

    sshd.knownHosts("changed");
    app = await moveThisMac(app, env);
    await openDevices(app.page);
    await selectDevice(app.page, device.id);
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
    await provider.close();
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

    await expect.poll(ssh, { timeout: 30_000 }).toEqual({ state: "stopped", reason: "other-home" });
    const lines = sshConnectionWords.stopped("other-home", { address: sshd.address, device });
    const row = await selectDevice(app.page, device.id);
    await expect(row.locator("[data-device-ssh-stopped]")).toHaveText(lines.join(" "));
    // It is not coming back, so Try again and Change address are not offered.
    await expect(row.getByRole("button", { name: `Try again to reach ${label}` })).toHaveCount(0);
    await expect(row).not.toHaveAttribute("data-device-acts", /\baddress\b/);

    // Remove, from the keyboard: it is not coming back, so nothing waits for it.
    await pressKey(await rowAction(app.page, device.id, "remove"), "Enter");
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
    // Its copy there, which the command got once the person there agreed
    // (`--fetched`), joins with that link, dialing this Mac's address itself.
    const joined = execFileSync(
      standInProgram(bundle),
      ["work", "join", "--fetched", bundle, "--from-home"],
      {
        input: `${JSON.stringify({ link })}\n`,
        env: { ...process.env, HOME: them, INFINITARY_HELPER_DATA_DIR: work },
        encoding: "utf8",
      },
    );
    expect(joined).toContain(STAND_IN_JOINED);
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
    seedRemotePairing(userDataDir, device.id, "192.168.4.48:47623");
    expect(existsSync(join(devicesDir, "seen.json"))).toBe(false);
    app = await launchApp({
      userDataDir,
      homeDir,
      ...(mockProvider ? { reuseMockProvider: mockProvider } : {}),
      env,
    });
    const { page } = app;

    await openDevices(page);
    const listed = async () =>
      (await page.evaluate(() => window.infinitary.devices.list())).find(
        (entry) => entry.id === device.id,
      );
    expect(await listed()).toMatchObject({ inReach: false, heldOnLocalNetwork: true });
    const row = await selectDevice(page, device.id);
    await expect(row.locator("[data-device-held]")).toBeVisible();
    const label = deviceLabel({ ...device, onThisMac: false });

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
