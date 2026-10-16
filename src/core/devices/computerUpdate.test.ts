import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Spelling, workLabelOf } from "@shared/codeNames";
import type { DeviceView } from "@shared/devices";
import { PLACED_WORK_SINCE, PROTOCOL_VERSION, WORK_UPDATE_SINCE } from "@shared/ipc";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freePort } from "../../../tests/helpers/connectionClient";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { forwardSocket } from "../../../tests/helpers/socketForward";
import { startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import {
  type BackgroundContext,
  readInstalled,
  startInBackground,
  writeInstalled,
} from "../helper/background";
import { fetchedLauncher, joinHome, keepApp } from "../helper/join";
import { HomeRoute } from "../helper/route";
import { type HelperRun, startHelper } from "../helper/run";
import { updateHere } from "../helper/update";
import { helperWords } from "../helper/words";
import { WorkDevices } from "../placed/workDevices";
import { openDatabase } from "../storage/db";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { Computers, type DeviceUpdateEvent } from "./computers";
import { claimLink, HomeRouteMissingError } from "./dial";
import { JoinedHome } from "./joinedHome";
import { DevicePairing } from "./pairing";

/**
 * Updating Firstmate on a computer that runs work over the connection
 * (docs/devices.md, "Another version" and "Updating over the connection"),
 * end to end from the home's side: the real pairing and connection, the
 * home's list and Update (`Computers`) over a real task record, and on the
 * other side the work mode's own run (`startHelper`), which gets the home's
 * Firstmate at `/firstmate` with its own key, unpacks it with the Mac's own
 * tar and keeps it. The background that starts a run again is this test:
 * once a run ends updated, it starts the next one, as launchd would.
 */

// Integration budget (docs/test-cohorts.md): real TLS on loopback and the
// Mac's own tar, the slowest case 0.47 s at its fastest of three runs on an
// Apple silicon Mac. A poll waits for a computer that crosses the
// connection and starts again, so it waits up to 5 s.
vi.setConfig({ testTimeout: 10_000, expect: { poll: { timeout: 5_000 } } });

/** This Mac's version of Firstmate in these tests. */
const HOME_APP = "0.1.29";
const BUILDER = { name: "builder", uid: 502 };

/** A stand-in bundle whose marker says whose copy it is, named as the app it stands in for. */
function bundle(marker: string, name = "Firstmate 3000"): string {
  const app = join(scratchDir("infinitary-update-bundle-"), `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", name), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(app, "Contents", "Resources", "marker"), `${marker}\n`);
  return app;
}

/** A contract on the home's major, one minor before a computer took the update order. */
function beforeUpdates(): string {
  const [major, minor] = WORK_UPDATE_SINCE.split(".").map(Number);
  return `${major}.${(minor ?? 1) - 1}.0`;
}

/** A contract one minor before a computer could hold a conversation: it takes no work. */
function beforePlacedWork(): string {
  const [major, minor] = PLACED_WORK_SINCE.split(".").map(Number);
  return `${major}.${(minor ?? 1) - 1}.0`;
}

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/**
 * A home and a computer joined to it as another user on this Mac. `kept` is
 * the copy of Firstmate kept there, as a command keeps one, or none, as for
 * another user running this Mac's own app; `background` whether a background
 * is set up there to start its run again.
 */
async function world(
  options: {
    app?: string | null;
    kept?: boolean;
    background?: boolean;
    waitMs?: number;
    /** Added by its address over Remote Login, which `RemoteLogin` updates. */
    remoteLogin?: string;
    /** The spelling of channel names the home writes: Infinitary's, standing in a home that moved to it. */
    speaks?: Spelling;
    /** Its work folder is in Firstmate 3000's data folder, as an installed app keeps it, not one a test named. */
    inDataFolder?: boolean;
  } = {},
) {
  const userData = scratchDir("infinitary-update-home-");
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ownUid: 501,
  });
  stops.push(() => pairing.dispose());
  const db = openDatabase(userData);
  stops.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, now: Date.now });
  const repos = new RepoRegistry(db, join(userData, "fleet"));
  const work = new WorkDevices();
  const port = await freePort();
  const homeApp = options.app === undefined ? bundle("the home's own copy") : options.app;
  const connection = startConnection({
    dispatch: (async (channel: string) => {
      throw new Error(`Rejected ${channel}`);
    }) as CoreDispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    app: () => homeApp,
    ...(options.speaks ? { speaks: options.speaks } : {}),
  });
  stops.push(() => connection.close());
  // Detached first, so nothing the closing connection says reaches the record.
  stops.push(work.attach(connection));
  const said: DeviceUpdateEvent[] = [];
  const overRemoteLogin: string[] = [];
  const pushed: DeviceView[][] = [];
  const computers = new Computers({
    pairing,
    work,
    tasks,
    repos,
    stopTasks: async () => {},
    bringHome: async () => {},
    home: { app: HOME_APP, contract: PROTOCOL_VERSION },
    canSend: () => homeApp !== null,
    emitUpdate: (event) => said.push(event),
    updateWaitMs: options.waitMs ?? 5_000,
    // Remote Login's own update is RemoteLogin's (remoteLogin.test.ts); this
    // records that the list hands it a Mac added by its address.
    updateOverRemoteLogin: async (deviceId) => {
      overRemoteLogin.push(deviceId);
      return pairing.list().find((device) => device.id === deviceId) as DeviceView;
    },
    emit: (list) => pushed.push(list),
    onProblem: () => {},
    now: Date.now,
    bootedAt: () => 0,
  });

  const { link } = pairing.invite(
    { kind: "work", at: `127.0.0.1:${port}` },
    options.remoteLogin ? { remoteLogin: options.remoteLogin } : {},
  );
  await connection.settled();
  const appData = scratchDir("infinitary-update-computer-");
  const dataDir = options.inDataFolder ? join(appData, "firstmate-3000", "work") : appData;
  const joined = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 2_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const deviceId = joined.grant.deviceId;
  // The join dialed once to hear the home's name; that connection goes.
  await expect
    .poll(() => computers.list().find((device) => device.id === deviceId)?.inReach)
    .toBe(false);
  // What the join set up there: the copy it kept, and the background.
  const app = options.kept ? keepApp(bundle("the copy it kept"), dataDir) : null;
  writeInstalled(dataDir, {
    service:
      options.background === false
        ? null
        : { label: "com.kunchenguid.firstmate3000.dev.work", file: join(dataDir, "agent.plist") },
    app,
  });

  const lines: string[] = [];
  let run: HelperRun | undefined;
  /** The one-time move's own: a Mac's copier, and Claude's records in a folder of the test's. */
  const moveDeps = {
    platform: process.platform,
    claudeConfigDir: scratchDir("infinitary-update-claude-"),
    hostname: "builder-mac",
  };
  /**
   * The computer's run starts, speaking these versions, with its background
   * when one is given, from its work folder or the one named.
   */
  const start = (
    versions: { protocolVersion?: string; appVersion?: string },
    background?: BackgroundContext,
    from: string = dataDir,
  ) => {
    const started = startHelper({
      dataDir: from,
      say: (said) => lines.push(...said),
      retryMs: [20],
      log: () => {},
      moveDeps,
      ...versions,
      ...(background ? { background: { context: background, env: {} } } : {}),
    });
    if (!started.ok) throw new Error(started.reason);
    run = started.run;
    return started.run;
  };
  stops.push(() => run?.stop());
  const view = () => computers.list().find((device) => device.id === deviceId);
  return {
    computers,
    deviceId,
    appData,
    dataDir,
    overRemoteLogin,
    lines,
    said,
    pushed,
    start,
    view,
    /** What the copy kept there says it is, or null when none is kept. */
    kept: () =>
      app && existsSync(app)
        ? readFileSync(join(app, "Contents", "Resources", "marker"), "utf8").trim()
        : null,
    feed: () => said.map((event) => event.text),
  };
}

describe("a computer that runs work on another version of Firstmate", () => {
  it("says so on the list while it is connected, older or newer, and whether it still takes work", async () => {
    const at = await world();
    expect(at.view()?.otherVersion).toBeUndefined();

    const older = at.start({ appVersion: "0.1.20" });
    await expect
      .poll(() => at.view()?.otherVersion)
      .toEqual({
        app: "0.1.20",
        than: "older",
        takesWork: true,
        updateBy: "connection",
      });
    expect(at.view()).toMatchObject({ inReach: true });
    expect(at.pushed.at(-1)?.[0]?.otherVersion).toMatchObject({ app: "0.1.20" });
    await older.stop();
    // Out of reach, this Mac cannot tell its version.
    await expect.poll(() => at.view()?.otherVersion).toBeUndefined();
    expect(at.view()).toMatchObject({ inReach: false });

    // Too old to hold work or take the update order: in reach, and it says so.
    const tooOld = at.start({ protocolVersion: beforePlacedWork(), appVersion: "0.1.12" });
    await expect
      .poll(() => at.view()?.otherVersion)
      .toEqual({
        app: "0.1.12",
        than: "older",
        takesWork: false,
        updateBy: "command",
      });
    expect(at.view()).toMatchObject({ inReach: false });
    expect(at.view()?.seenAt).toBeGreaterThan(0);
    await tooOld.stop();

    // Newer than this Mac's; and on this Mac's own version it says nothing.
    await expect.poll(() => at.view()?.otherVersion).toBeUndefined();
    const newer = at.start({ appVersion: "0.1.31" });
    await expect.poll(() => at.view()?.otherVersion?.than).toBe("newer");
    await newer.stop();
    await expect.poll(() => at.view()?.inReach).toBe(false);
    at.start({ appVersion: HOME_APP });
    await expect.poll(() => at.view()?.inReach).toBe(true);
    expect(at.view()?.otherVersion).toBeUndefined();
  });

  it("is updated over the connection: it gets this Mac's Firstmate with its own key, keeps it, and starts again on this Mac's version", async () => {
    const at = await world({ kept: true });
    const before = at.start({ appVersion: "0.1.20" });
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("connection");

    const updating = at.computers.update(at.deviceId);
    // It kept this Mac's copy in place of its own, then its run ended.
    expect(await before.ended).toBe("updated");
    expect(at.kept()).toBe("the home's own copy");
    expect(at.lines).toEqual(
      expect.arrayContaining(helperWords.updated({ thisMac: true, host: "127.0.0.1" }, null, true)),
    );
    // Its background starts it again, on this Mac's version.
    at.start({ appVersion: HOME_APP });
    const updated = await updating;
    if ("asks" in updated) throw new Error("Update asked for a password.");
    expect(updated).toMatchObject({ id: at.deviceId, inReach: true });
    expect(updated.otherVersion).toBeUndefined();
    const builder = { name: "Mac mini", user: "builder", onThisMac: true };
    expect(at.feed()).toEqual([
      remoteLoginWords.updating(builder),
      remoteLoginWords.updated(builder, "running"),
    ]);
    // Nothing of the copy it got is left beside the one it kept.
    expect(readdirSync(at.dataDir).filter((entry) => entry.startsWith("update-"))).toEqual([]);
  });

  it("running this Mac's own app, gets nothing and starts again", async () => {
    const at = await world({ app: null });
    const before = at.start({ appVersion: "0.1.20" });
    await expect.poll(() => at.view()?.otherVersion).toBeDefined();
    const updating = at.computers.update(at.deviceId);
    expect(await before.ended).toBe("updated");
    expect(existsSync(join(at.dataDir, "app"))).toBe(false);
    at.start({ appVersion: HOME_APP });
    const updated = await updating;
    if ("asks" in updated) throw new Error("Update asked for a password.");
    expect(updated.otherVersion).toBeUndefined();
  });

  it("says when it has not started again, or will only once it is started by hand", async () => {
    const late = await world({ waitMs: 100 });
    late.start({ appVersion: "0.1.20" });
    await expect.poll(() => late.view()?.otherVersion).toBeDefined();
    await late.computers.update(late.deviceId);
    const builder = { name: "Mac mini", user: "builder", onThisMac: true };
    expect(late.said.map(({ text, tone }) => [text, tone])).toEqual([
      [remoteLoginWords.updating(builder), "info"],
      ...remoteLoginWords.notBack(builder).map((line) => [line, "warn"]),
    ]);

    const byHand = await world({ background: false });
    byHand.start({ appVersion: "0.1.20" });
    await expect.poll(() => byHand.view()?.otherVersion).toBeDefined();
    await byHand.computers.update(byHand.deviceId);
    expect(byHand.feed()).toEqual([
      remoteLoginWords.updating(builder),
      remoteLoginWords.updatedByHand(builder),
    ]);
  });

  it("added by its address, is updated over Remote Login, never the connection", async () => {
    const at = await world({ kept: true, remoteLogin: "sam@mini.local" });
    const running = at.start({ appVersion: "0.1.20" });
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("remote-login");
    // The home lists its version as it welcomes it, before the computer
    // hears the welcome: both sides are in reach before the update.
    await expect.poll(() => running.state().contact).toBe("in-reach");
    await at.computers.update(at.deviceId);
    expect(at.overRemoteLogin).toEqual([at.deviceId]);
    expect(at.said).toEqual([]);
    expect(at.kept()).toBe("the copy it kept");
    expect(running.state().contact).toBe("in-reach");
  });

  it("refuses what it cannot update, in two lines here and in the feed, and changes nothing there", async () => {
    const builder = { name: "Mac mini", user: "builder", onThisMac: true };
    const refused = (refusal: Parameters<typeof remoteLoginWords.refused>[0]) =>
      remoteLoginWords.refused(refusal, {
        address: "Running as Builder",
        name: "Running as Builder",
        doing: "update",
      });

    // Out of reach, and on this Mac's version already.
    const at = await world({ kept: true });
    await expect(at.computers.update(at.deviceId)).rejects.toThrow(
      refused("out-of-reach").join(" "),
    );
    const current = at.start({ appVersion: HOME_APP });
    await expect.poll(() => at.view()?.inReach).toBe(true);
    await expect(at.computers.update(at.deviceId)).rejects.toThrow(refused("current").join(" "));
    await current.stop();
    await expect.poll(() => at.view()?.inReach).toBe(false);

    // Too old to take the update order: a new command updates it instead.
    at.start({ protocolVersion: beforeUpdates(), appVersion: "0.1.25" });
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("command");
    await expect(at.computers.update(at.deviceId)).rejects.toThrow(
      refused("not-updatable").join(" "),
    );
    expect(at.feed()).toEqual([
      ...refused("out-of-reach"),
      ...refused("current"),
      ...refused("not-updatable"),
    ]);
    expect(at.said.every(({ stage, tone }) => stage === "refused" && tone === "warn")).toBe(true);
    expect(at.kept()).toBe("the copy it kept");

    // This Mac has no Firstmate to send: the computer could not get it, kept
    // its own, and runs on.
    const none = await world({ app: null, kept: true });
    const running = none.start({ appVersion: "0.1.20" });
    await expect.poll(() => none.view()?.otherVersion).toBeDefined();
    await expect(none.computers.update(none.deviceId)).rejects.toThrow(refused("failed").join(" "));
    expect(none.feed()).toEqual([remoteLoginWords.updating(builder), ...refused("failed")]);
    expect(none.kept()).toBe("the copy it kept");
    expect(running.state().contact).toBe("in-reach");
  });
});

/**
 * The Infinitary rename (FI3-1780 step 2): a home that moved to Infinitary
 * writes its channel names in Infinitary's spelling, keeps the update order's
 * one name, and sends its own app, `Infinitary.app`. This computer keeps that
 * app beside its own and moves its background to it in one step, under that
 * app's label. Its background answers through a stand-in launchctl, which
 * writes down what it was asked.
 */
describe("a computer whose home moved to Infinitary", () => {
  function inBackground(dataDir: string, refuses?: (args: readonly string[]) => boolean) {
    const asked: string[][] = [];
    const context: BackgroundContext = {
      flavor: "release",
      dataDir,
      homeDir: scratchDir("infinitary-update-agents-"),
      uid: 502,
      launchctl: async (args) => {
        asked.push([...args]);
        return refuses?.(args) ? { ok: false, output: "refused" } : { ok: true, output: "" };
      },
    };
    return { context, asked };
  }

  /**
   * The agent the join set up there, starting the copy it kept: Firstmate
   * 3000's, under its own label, as a computer that joined before the
   * rename has it.
   */
  async function joinedInBackground(context: BackgroundContext, kept: string) {
    const launcher = fetchedLauncher(kept);
    if (!launcher) throw new Error("no launcher");
    await startInBackground({ ...context, spelling: "fm" }, { launcher, env: {}, app: kept });
    const service = readInstalled(context.dataDir).service;
    if (!service) throw new Error("no agent");
    return service;
  }

  it("keeps Infinitary's app, starts its background from it first, and takes its own copy and agent away last", async () => {
    const at = await world({
      kept: true,
      speaks: "inf",
      app: bundle("Infinitary's own copy", "Infinitary"),
    });
    const kept = join(at.dataDir, "app", "Firstmate 3000.app");
    const { context, asked } = inBackground(at.dataDir);
    const before = await joinedInBackground(context, kept);
    expect(before.label).toBe(workLabelOf("fm", "release"));

    const running = at.start({ appVersion: "0.1.20" }, context);
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("connection");
    asked.length = 0;
    const updating = at.computers.update(at.deviceId);
    // The order kept its one name across the two spellings, so this run answered it.
    expect(await running.ended).toBe("updated");

    const moved = join(at.dataDir, "app", "Infinitary.app");
    const label = workLabelOf("inf", "release");
    const file = join(context.homeDir, "Library", "LaunchAgents", `${label}.plist`);
    expect(readInstalled(at.dataDir)).toEqual({ service: { label, file }, app: moved });
    expect(readFileSync(join(moved, "Contents", "Resources", "marker"), "utf8").trim()).toBe(
      "Infinitary's own copy",
    );
    expect(readFileSync(file, "utf8")).toContain(
      `<string>${join(moved, "Contents", "MacOS", "Infinitary")}</string>`,
    );
    // The new agent started before the old one went, which went last.
    expect(asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", file],
      ["bootout", `gui/502/${before.label}`],
    ]);
    expect(existsSync(before.file)).toBe(false);
    expect(existsSync(kept)).toBe(false);

    // Its background starts it again, on this Mac's version.
    at.start({ appVersion: HOME_APP }, context);
    const updated = await updating;
    if ("asks" in updated) throw new Error("Update asked for a password.");
    expect(updated.otherVersion).toBeUndefined();
  });

  it("changes nothing when its background will not move to the new app, and runs on", async () => {
    const at = await world({
      kept: true,
      speaks: "inf",
      app: bundle("Infinitary's own copy", "Infinitary"),
    });
    const kept = join(at.dataDir, "app", "Firstmate 3000.app");
    const label = workLabelOf("inf", "release");
    const { context } = inBackground(
      at.dataDir,
      (args) => args[0] === "bootstrap" && String(args[2]).includes(label),
    );
    const before = await joinedInBackground(context, kept);

    const running = at.start({ appVersion: "0.1.20" }, context);
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("connection");
    await expect(at.computers.update(at.deviceId)).rejects.toThrow();
    expect(running.state().contact).toBe("in-reach");
    expect(readInstalled(at.dataDir)).toEqual({ service: before, app: kept });
    expect(at.kept()).toBe("the copy it kept");
    expect(existsSync(before.file)).toBe(true);
    expect(existsSync(join(at.dataDir, "app", "Infinitary.app"))).toBe(false);
    expect(existsSync(join(context.homeDir, "Library", "LaunchAgents", `${label}.plist`))).toBe(
      false,
    );
  });

  it("keeping its work in Firstmate 3000's data folder, moves that folder into Infinitary's before its background moves to the copy there", async () => {
    const at = await world({
      kept: true,
      speaks: "inf",
      app: bundle("Infinitary's own copy", "Infinitary"),
      inDataFolder: true,
    });
    writeFileSync(join(at.dataDir, "work.log"), "a note\n");
    const kept = join(at.dataDir, "app", "Firstmate 3000.app");
    const { context, asked } = inBackground(at.dataDir);
    const before = await joinedInBackground(context, kept);

    const running = at.start({ appVersion: "0.1.20" }, context);
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("connection");
    asked.length = 0;
    const updating = at.computers.update(at.deviceId);
    expect(await running.ended).toBe("updated");

    // The whole folder is in Infinitary's now; Firstmate 3000's is its recovery copy.
    const older = join(at.appData, "firstmate-3000");
    const work = join(at.appData, "infinitary", "work");
    expect(existsSync(join(older, "retired-profile.json"))).toBe(true);
    expect(new JoinedHome(work).read()?.grant.deviceId).toBe(at.deviceId);
    expect(existsSync(join(work, "work.log"))).toBe(false);
    const moved = join(work, "app", "Infinitary.app");
    const label = workLabelOf("inf", "release");
    const file = join(context.homeDir, "Library", "LaunchAgents", `${label}.plist`);
    expect(readInstalled(work)).toEqual({ service: { label, file }, app: moved });
    expect(readFileSync(join(moved, "Contents", "Resources", "marker"), "utf8").trim()).toBe(
      "Infinitary's own copy",
    );
    const plist = readFileSync(file, "utf8");
    expect(plist).toContain(`<string>${join(moved, "Contents", "MacOS", "Infinitary")}</string>`);
    expect(plist).toContain(`<key>${join(work, "home.json")}</key>`);
    expect(plist).not.toContain(older);
    // The new agent started first, in the new folder; the old one went last.
    expect(asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", file],
      ["bootout", `gui/502/${before.label}`],
    ]);
    expect(existsSync(before.file)).toBe(false);
    expect(existsSync(join(work, "app", "Firstmate 3000.app"))).toBe(false);

    // Its background starts it again from the new folder, on this Mac's version.
    at.start({ appVersion: HOME_APP }, { ...context, dataDir: work, spelling: "inf" }, work);
    const updated = await updating;
    if ("asks" in updated) throw new Error("Update asked for a password.");
    expect(updated.otherVersion).toBeUndefined();
  });

  it("changes nothing when its folder cannot move, and its own run starts again as it was", async () => {
    const at = await world({
      kept: true,
      speaks: "inf",
      app: bundle("Infinitary's own copy", "Infinitary"),
      inDataFolder: true,
      waitMs: 300,
    });
    // Firstmate 3000's window has the folder open there.
    const older = join(at.appData, "firstmate-3000");
    symlinkSync(`builder-mac-${process.pid}`, join(older, "SingletonLock"));
    const kept = join(at.dataDir, "app", "Firstmate 3000.app");
    const { context, asked } = inBackground(at.dataDir);
    const before = await joinedInBackground(context, kept);

    const running = at.start({ appVersion: "0.1.20" }, context);
    await expect.poll(() => at.view()?.otherVersion?.updateBy).toBe("connection");
    asked.length = 0;
    await at.computers.update(at.deviceId);
    expect(await running.ended).toBe("updated");
    await expect.poll(() => existsSync(join(at.dataDir, "app", "Infinitary.app"))).toBe(false);
    expect(existsSync(join(at.appData, "infinitary"))).toBe(false);
    expect(existsSync(join(older, "retired-profile.json"))).toBe(false);
    expect(readInstalled(at.dataDir)).toEqual({ service: before, app: kept });
    expect(at.kept()).toBe("the copy it kept");
    expect(asked).toEqual([]);
  });
});

describe("a computer that reaches its home through the home's SSH connection", () => {
  it("gets this Mac's Firstmate through the route that connection keeps, never at an address", async () => {
    const pairing = new DevicePairing({
      dir: join(scratchDir("infinitary-update-home-"), "devices"),
      onProblem: () => {},
      interfaces: () => ({}),
      ownUid: 501,
      port: await freePort(),
    });
    stops.push(() => pairing.dispose());
    const connection = startConnection({
      dispatch: (async (channel: string) => {
        throw new Error(`Rejected ${channel}`);
      }) as CoreDispatch,
      events: new CoreEventBus(),
      devices: pairing,
      port: pairing.port,
      app: () => bundle("the home's own copy"),
    });
    stops.push(() => connection.close());
    const forward = await forwardSocket(pairing.port);
    stops.push(() => forward.close());
    const { link } = pairing.invite(
      { kind: "work" },
      { remoteLogin: "builder@mini.local", via: "ssh", locality: "elsewhere" },
    );
    await connection.settled();
    const grant = await claimLink(
      link,
      { kind: "work", name: "Mac mini", user: BUILDER },
      { target: { socket: forward.socket } },
    );
    const dataDir = scratchDir("infinitary-update-computer-");
    new JoinedHome(dataDir).join(grant, Date.now());
    const app = keepApp(bundle("the copy it kept"), dataDir);
    writeInstalled(dataDir, { service: null, app });
    const kept = () => readFileSync(join(app, "Contents", "Resources", "marker"), "utf8").trim();

    // With no route, nothing is got and nothing here changes.
    await expect(updateHere({ dataDir, grant })).rejects.toBeInstanceOf(HomeRouteMissingError);
    expect(kept()).toBe("the copy it kept");
    expect(forward.carried()).toBe(1);

    const route = new HomeRoute(dataDir);
    route.publish(route.begin(), {
      socket: forward.socket,
      homeKey: grant.homeKey,
      deviceId: grant.deviceId,
    });
    await expect(updateHere({ dataDir, grant })).resolves.toEqual({ restarts: false });
    expect(kept()).toBe("the home's own copy");
    expect(forward.carried()).toBe(2);
  });
});
