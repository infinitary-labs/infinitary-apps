import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeInstalled } from "@core/helper/background";
import { joinHome } from "@core/helper/join";
import { catalogRefreshesSettled } from "@core/pi/modelRuntime";
import { expect, test } from "@playwright/test";
import { WORK_UPDATE_SINCE } from "@shared/contractFeatures";
import {
  type DeviceView,
  deviceJoinedLine,
  deviceLabel,
  deviceWords,
  PAIRING_LINK_PREFIX,
  parsePairingLink,
} from "@shared/devices";
import { deviceUpdateBody, deviceUpdateCardId, deviceUpdateTitle } from "@shared/deviceUpdateNudge";
import { remoteLoginWords } from "@shared/remoteLogin";
import {
  DEVICE_ROW_WORDS,
  deviceState,
  deviceSummary,
  PANEL_WORDS,
  removeLines,
  SEEN_WORDS,
} from "../../src/renderer/src/settings/devicesWords";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { ask, BUILDER, linkInTab, moveThisMac, openDevices, workRuns } from "./deviceFixtures";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { addedProjects } from "./projects";
import { feedLine, feedLineOf } from "./rails";
import { pressKey } from "./windowKeys";

/**
 * Computers a command adds (docs/devices.md, "Adding a computer by a command"):
 * another user on this Mac joins with a command made from the first mate's
 * card, one comes back after this Mac's address changes, and one on another
 * version updates or gets a new command.
 */

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
    await expect
      .poll(() => helper.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");

    // Devices lists it with what it runs, its sign-ins, its tasks and when it was seen.
    const row = page.locator(`[data-device-row="${deviceId}"]`);
    await expect(row).toContainText(deviceLabel(builder));
    await expect(row).toContainText(SEEN_WORDS.now);
    await expect(row).toContainText(DEVICE_ROW_WORDS.runsNoProject);
    await expect(row).toContainText(deviceState({ ...builder, inReach: true }).text);
    const { repo } = await page.evaluate(
      (path) => window.infinitary.repos.setup({ kind: "adopt", path }),
      projectWithOrigin(),
    );
    await page.evaluate(([id, device]) => window.infinitary.devices.runsOn(id, device), [
      repo.id,
      deviceId,
    ] as const);
    /** What the row says it runs once the project runs there, from the row's own words. */
    const runsWebsite = deviceSummary({ ...builder, runs: [repo.name] }, undefined);
    await expect(row).toContainText(runsWebsite);

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
    await expect(row).toContainText(runsWebsite);

    // Back in reach, Remove brings its work here, then takes it off the list.
    const again = run();
    await expect
      .poll(() => again.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");
    await expect(row).toContainText(SEEN_WORDS.now);
    await row.getByRole("button", { name: "Remove Running as Builder", exact: true }).click();
    await expect(question).toContainText(removeLines({ ...builder, inReach: true })[0]);
    await question.getByRole("button", { name: "Remove", exact: true }).click();
    expect(await again.ended).toBe("removed");
    await expect(row).toHaveCount(0);
    expect((await addedProjects(page))[0]?.runsOn).toBeNull();
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
    await expect
      .poll(() => first.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");
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
    await expect
      .poll(() => back.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
      .toBe("in-reach");
    await expect(row).toContainText(SEEN_WORDS.now);
    await expect(row.locator("[data-device-stranded]")).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.infinitary.devices.list())).map(({ id }) => id),
    ).toEqual([deviceId]);
    expect((await addedProjects(page))[0]?.runsOn).toBe(deviceId);
  } finally {
    await Promise.all(runs.map((each) => each.stop()));
    await catalogRefreshesSettled();
    await app.close();
    await app.mockProvider?.close();
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
    // It answered the update order: the row says it is starting again until it is back.
    await expect(row).toContainText(remoteLoginWords.startingRow(deviceLabel(builder)));
    expect(await older.ended).toBe("updated");
    run({ appVersion: thisVersion });
    await expect(row).not.toHaveAttribute("data-other-version", /.+/);
    await expect(row).toContainText(SEEN_WORDS.now);
    // Its Update button, named as the row names it (`Update ${deviceLabel}`),
    // is gone on the same version; it comes back below for one too old.
    const update = row.getByRole("button", { name: `Update ${deviceLabel(builder)}`, exact: true });
    await expect(update).toHaveCount(0);
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
    await expect(row).toContainText(DEVICE_ROW_WORDS.noNewWork);
    await update.click();
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
