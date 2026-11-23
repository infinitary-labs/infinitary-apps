/**
 * The home and a computer joined to it for the update tests (`src/core/devices/computerUpdate.test.ts`):
 * the real pairing and connection, the home's list and Update over a real task
 * record, and the work mode's own run on the other side.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Spelling } from "@shared/codeNames";
import { PLACED_WORK_SINCE, WORK_UPDATE_SINCE } from "@shared/contractFeatures";
import type { DeviceView } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { UpdateDownload } from "@shared/work";
import { assert, expect } from "vitest";
import { startConnection } from "../../src/core/connection/connection";
import { Computers, type DeviceUpdateEvent } from "../../src/core/devices/computers";
import { DeviceUpdateNudge } from "../../src/core/devices/deviceUpdateNudge";
import { DevicePairing } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { type BackgroundContext, writeInstalled } from "../../src/core/helper/background";
import { joinHome, keepApp } from "../../src/core/helper/join";
import { type HelperRun, type StartHelperOptions, startHelper } from "../../src/core/helper/run";
import { WorkDevices } from "../../src/core/placed/workDevices";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { claimedPort } from "./claimedPort";
import { scratchDir } from "./scratchDirs";

/** This Mac's version of Firstmate in these tests. */
export const HOME_APP = "0.1.29";
export const BUILDER = { name: "builder", uid: 502 };

/**
 * A stand-in bundle whose marker says whose copy it is, named as the app it
 * stands in for, whose program exits at once, as a copy that does not start does.
 */
export function bundle(marker: string, name = "Firstmate 3000"): string {
  const app = join(scratchDir("infinitary-update-bundle-"), `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(app, "Contents", "Resources", "marker"), `${marker}\n`);
  return app;
}

/** A contract on the home's major, one minor before a computer took the update order. */
export function beforeUpdates(): string {
  const [major, minor] = WORK_UPDATE_SINCE.split(".").map(Number);
  return `${major}.${(minor ?? 1) - 1}.0`;
}

/** A contract one minor before a computer could hold a conversation: it takes no work. */
export function beforePlacedWork(): string {
  const [major, minor] = PLACED_WORK_SINCE.split(".").map(Number);
  return `${major}.${(minor ?? 1) - 1}.0`;
}

export const stops: (() => Promise<void> | void)[] = [];

/**
 * A home and a computer joined to it as another user on this Mac. `kept` is
 * the copy of Firstmate kept there, as a command keeps one, or none, as for
 * another user running this Mac's own app; `background` whether a background
 * is set up there to start its run again.
 */
export async function world(
  options: {
    app?: string | null;
    kept?: boolean;
    background?: boolean;
    waitMs?: number;
    updateByAddress?: NonNullable<
      ConstructorParameters<typeof Computers>[0]["updateOverRemoteLogin"]
    >;
    /** Added by its address over Remote Login, which `RemoteLogin` updates. */
    remoteLogin?: string;
    /** The spelling of channel names the home writes: Infinitary's, standing in a home that moved to it. */
    speaks?: Spelling;
    /** Its work folder is in Firstmate 3000's data folder, as an installed app keeps it, not one a test named. */
    inDataFolder?: boolean;
    /** It joined from another Mac, as a command run there joins, so this Mac does not run its app. */
    fromAnotherMac?: boolean;
    /** Where this Mac's version is published for a Mac to download itself; none for an unpublished one. */
    download?: UpdateDownload;
    /** Its update over Remote Login asks the password of the account there first, as an Ubuntu install does. */
    asksPassword?: boolean;
    /**
     * The home's update nudge, wired as the home wires it: it hears each
     * version and each update step, and updates the computer by itself or
     * raises its card (docs/devices.md, "Updating by itself").
     */
    nudge?: boolean;
    /** What getting this Mac's Firstmate for that computer's system answers before it is asked. */
    prepare?: NonNullable<ConstructorParameters<typeof Computers>[0]["prepare"]>;
    /** How the computer's crew's work is saved before its update, in place of a save done at once. */
    pauseTasks?: NonNullable<ConstructorParameters<typeof Computers>[0]["pauseTasks"]>;
  } = {},
) {
  const userData = scratchDir("infinitary-update-home-");
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ownUid: 501,
    ...(options.fromAnotherMac ? { joinsFromAnotherMac: true } : {}),
  });
  stops.push(() => pairing.dispose());
  const db = openDatabase(userData);
  stops.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, now: Date.now });
  const repos = new RepoRegistry(db, join(userData, "fleet"));
  const work = new WorkDevices();
  const port = await claimedPort();
  const homeApp = options.app === undefined ? bundle("the home's own copy") : options.app;
  const listen = () =>
    startConnection({
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
  let connection = listen();
  stops.push(() => connection.close());
  // Detached first, so nothing the closing connection says reaches the record.
  let detach = work.attach(connection);
  stops.push(() => detach());
  const said: DeviceUpdateEvent[] = [];
  const overRemoteLogin: string[] = [];
  const pushed: DeviceView[][] = [];
  /** The computer's crew, paused and carried on around its update, in order. */
  const crew: string[] = [];
  let nudge: DeviceUpdateNudge | undefined;
  const computers = new Computers({
    pairing,
    work,
    tasks,
    repos,
    stopTasks: async () => {},
    bringHome: async () => {},
    pauseTasks: async (deviceId, pause) => {
      crew.push(`paused ${deviceId}`);
      return options.pauseTasks ? options.pauseTasks(deviceId, pause) : "saved";
    },
    resumeTasks: (deviceId) => {
      crew.push(`resumed ${deviceId}`);
    },
    home: { app: HOME_APP, contract: PROTOCOL_VERSION },
    canSend: () => homeApp !== null,
    download: async () => options.download ?? null,
    ...(options.prepare ? { prepare: options.prepare } : {}),
    // Every count is said and asked for at once, so a short download shows some.
    countEveryMs: 50,
    emitUpdate: (event) => {
      said.push(event);
      nudge?.updateSaid(event);
    },
    updateWaitMs: options.waitMs ?? 5_000,
    // Remote Login's own update is RemoteLogin's (remoteLoginUpdate.test.ts); this
    // records that the list hands it a Mac added by its address, which goes
    // ahead there, pausing its crew, as RemoteLogin does once nothing refused.
    updateOverRemoteLogin:
      options.updateByAddress ??
      (async (deviceId, asked) => {
        overRemoteLogin.push(deviceId);
        if (options.asksPassword && !asked?.password)
          return { asks: "password", address: options.remoteLogin ?? "", for: "update", deviceId };
        await asked?.pause?.(() => assert.fail("That computer is out of reach."));
        return pairing.list().find((device) => device.id === deviceId) as DeviceView;
      }),
    emit: (list) => pushed.push(list),
    onProblem: () => {},
    now: Date.now,
    bootedAt: () => 0,
  });
  /** What the nudge did: each update it started, each card it raised, and what the captain chose. */
  const nudged = {
    updates: [] as string[],
    raised: [] as { id: string; body: string }[],
    standing: new Set<string>(),
    chosen: new Map<string, string>(),
  };
  if (options.nudge) {
    nudge = new DeviceUpdateNudge({
      devices: () => computers.list(),
      homeApp: () => HOME_APP,
      failedHere: (deviceId) => computers.failedHere(deviceId),
      update: (deviceId) => {
        nudged.updates.push(deviceId);
        return computers.update(deviceId);
      },
      cards: {
        raise: (card) => {
          nudged.standing.add(card.id);
          nudged.raised.push({ id: card.id, body: card.body });
        },
        withdraw: (id) => void nudged.standing.delete(id),
        has: (id) => nudged.standing.has(id),
        chosenAction: (id) => nudged.chosen.get(id),
      },
      broadcastEvent: () => undefined,
    });
    // After the list's own, as the home hears each version.
    work.onVersion((deviceId) => nudge?.refresh(deviceId));
  }

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
    versions: Pick<
      StartHelperOptions,
      | "protocolVersion"
      | "appVersion"
      | "verifier"
      | "downloadIdleSeconds"
      | "update"
      | "trialSeconds"
      | "sourceRun"
      | "build"
    >,
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
    crew,
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
    nudge,
    nudged,
    /** The home's own connection, which asks the computer its orders. */
    work,
    pairing,
    /** The connection drops under every computer and this Mac listens again at once, as on a flaky network. */
    drop: async () => {
      detach();
      await connection.close();
      connection = listen();
      detach = work.attach(connection);
      await connection.settled();
    },
  };
}
