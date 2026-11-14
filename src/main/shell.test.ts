import { createServer } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { type BrowserViewer, BrowserViews } from "@core/browser/browserViews";
import type { BrowserFrameSink } from "@core/browser/taskBrowsers";
import { type HomeConnection, startConnection } from "@core/connection/connection";
import { claimLink, dialHome } from "@core/devices/dial";
import { HomeLink } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import { DevicePairing } from "@core/devices/pairing";
import type { CoreDispatch } from "@core/dispatcher";
import { CoreEventBus } from "@core/events";
import type { Core } from "@core/index";
import { CardNotifier } from "@core/notifications";
import { buildUpdateTarget, upgradeCommandFor } from "@core/update/updateChannels";
import { createUpdateChecker, type UpdateChecker } from "@core/update/updateChecker";
import type { Card } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import type { DeviceKind, ThisMac } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_MAJORS_BEHIND, PROTOCOL_VERSION } from "@shared/ipc";
import { DEFAULT_SAVED_KEYMAP, presetKeymap, type SavedKeymap } from "@shared/keymap";
import type { PersonalExtensionView } from "@shared/personal/manifest";
import type { PanelFiles } from "@shared/personal/panelFiles";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { claimedPort } from "../../tests/helpers/claimedPort";
import {
  answerInOwnWords,
  CAPTAIN,
  OWN_READS,
  ownCards,
  ownWords,
  SAID,
} from "../../tests/helpers/firstMatesOwnWords";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import type { StartEntry } from "./besideRun";
import type { RunStatus } from "./runStatus";
import { Shell, type ShellOptions } from "./shell";
import { namedHere } from "./view/namedHere";

/**
 * What this app is, and the switch between holding Firstmate and controlling
 * it on another Mac (docs/view.md): the shell against a real other Mac - the
 * real connection and pairing over a stand-in core - with a stand-in for
 * this Mac's own core.
 */

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** A card as the other Mac's stage shows it. */
function shown(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    author: "firstmate",
    priority: 15,
    title: id,
    meta: "firstmate",
    body: "<p>First line.</p><p>Second line.</p>",
    actions: [],
    status: "ready",
    createdAt: 1,
    ...overrides,
  };
}

/** The Mac where Firstmate lives: what it was asked, its pairing, and links to it. */
async function otherMac(
  options: { protocolVersion?: string; viewFloor?: number; changes?: readonly string[] } = {},
  pairingOptions: { joinsFromAnotherMac?: boolean } = {},
) {
  const asked: string[] = [];
  /** What its stage shows, and its own Notifications switch. */
  const stage = { cards: [] as Card[], notifications: true, panel: null as PanelFiles };
  /** Its task browsers: each page's watchers, and the room each asked for. */
  const pages = {
    sinks: new Map<string, Set<BrowserFrameSink>>(),
    /** Every watch and end in order, as "+t1" and "-t1". */
    log: [] as string[],
    rooms: [] as { taskId: string; size: unknown }[],
    watch(taskId: string, sink: BrowserFrameSink) {
      const sinks = pages.sinks.get(taskId) ?? new Set();
      sinks.add(sink);
      pages.sinks.set(taskId, sinks);
      pages.log.push(`+${taskId}`);
      return () => {
        sinks.delete(sink);
        pages.log.push(`-${taskId}`);
      };
    },
    sizeView(taskId: string, _sink: BrowserFrameSink, size: unknown) {
      pages.rooms.push({ taskId, size });
    },
    /** The page changed: one picture to each watcher. */
    paint(taskId: string, data: string) {
      for (const sink of pages.sinks.get(taskId) ?? [])
        sink({ data, width: 1280, height: 800 } as Parameters<BrowserFrameSink>[0]);
    },
    watchers: (taskId: string) => pages.sinks.get(taskId)?.size ?? 0,
  };
  const views = new BrowserViews(() => pages as never);
  /** What a sign-in's return from another computer brought here, as each was handed on. */
  const returns: unknown[] = [];
  const dispatch = (async (channel, args, _actor, viewer) => {
    asked.push(channel);
    if (viewer && channel === "inf:browser:watch")
      return views.watch(viewer, (args as string[])[0] as string);
    if (viewer && channel === "inf:browser:unwatch") {
      views.unwatch(viewer, (args as string[])[0] as string);
      return { ok: true };
    }
    if (viewer && channel === "inf:browser:size") {
      const [taskId, size] = args as [string, null];
      views.size(viewer, taskId, size);
      return { ok: true };
    }
    if (channel === "inf:cards:list") return stage.cards;
    if (channel === "inf:integrations:sign-in-return") {
      returns.push((args as unknown[])[0]);
      return { status: 200, page: "Signed in to Google." };
    }
    if (channel === "inf:settings:notifications:get") return stage.notifications;
    const said = answerInOwnWords(channel);
    if (said !== undefined) return said;
    if (channel === "inf:plugins:files") return stage.panel;
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "other-os",
        protocolVersion: "1.59.0",
        capabilities: [...HOME_CAPABILITIES],
      };
    if (channel === "inf:shell:preferences")
      return {
        ...DEFAULT_SHELL_PREFERENCES,
        appearance: { ...DEFAULT_SHELL_PREFERENCES.appearance, theme: "light", size: 125 },
      } satisfies ShellPreferences;
    throw new Error(`Rejected ${channel}: malformed request`);
  }) as CoreDispatch;
  const events = new CoreEventBus();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-shell-other-"), "devices"),
    onProblem: () => {},
    ...pairingOptions,
  });
  const port = await claimedPort();
  const at = `127.0.0.1:${port}`;
  let connection: HomeConnection | null = startConnection({
    dispatch,
    events,
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    ...options,
  });
  stops.push(async () => {
    await connection?.close();
    pairing.dispose();
  });
  return {
    asked,
    stage,
    pages,
    returns,
    events,
    pairing,
    at,
    /** Its stage changes, and it tells every window and device. */
    show: (cards: Card[]) => {
      stage.cards = cards;
      events.emit("inf:cards", cards);
    },
    link: async (kind: DeviceKind = "view") => {
      const { link } = pairing.invite({ kind, at });
      await connection?.settled();
      return link;
    },
    quit: async () => {
      await connection?.close();
      connection = null;
    },
    /** Firstmate starts there again: a new run, with nothing to replay. */
    restart: () => {
      connection = startConnection({
        dispatch,
        events,
        devices: pairing,
        port,
        name: () => "MacBook Pro",
      });
    },
  };
}

/** This Mac's own core, as far as the shell reads it. */
function ownCore() {
  const preferences = {
    value: DEFAULT_SHELL_PREFERENCES,
    get() {
      return this.value;
    },
    subscribe: () => () => {},
    keys: DEFAULT_SAVED_KEYMAP as SavedKeymap,
    keymap() {
      return { saved: this.keys, unreadable: false };
    },
    setKeymap(keymap: SavedKeymap) {
      this.keys = keymap;
    },
  };
  const dispose = vi.fn(async () => {});
  const unreach = vi.fn();
  const attach = vi.fn((_link: unknown) => unreach);
  // This Mac's own SSH connections to the computers it added by their address.
  const stopSsh = vi.fn(async () => {});
  const ssh = { start: vi.fn(() => stopSsh), suspend: vi.fn(), resume: vi.fn() };
  // Pairing following this Mac's network, so the connection moves with it.
  const unfollow = vi.fn();
  const follow = vi.fn(() => unfollow);
  const dispatch = vi.fn((async (channel) => ({ ownCore: channel })) as CoreDispatch);
  const core = {
    services: {
      preferences,
      workDevices: { attach },
      devices: { followNetwork: follow },
      sshConnections: ssh,
      settings: { getDictation: () => ({ enabled: true }) },
      quota: { onWindowFocus: vi.fn(), onResumed: vi.fn() },
      personal: { framePanelDir: () => "/own/panels" },
    },
    paths: { crewmatesDir: "/own/crewmates" },
    events: new CoreEventBus(),
    dispatch,
    dispose,
  } as unknown as Core;
  return { core, dispatch, dispose, attach, unreach, ssh, stopSsh, follow, unfollow };
}

/** The version the public tap offers this Mac's alpha installation. */
const OFFERED = buildUpdateTarget({
  version: "0.1.30-alpha.5",
  assetName: "Firstmate-3000-0.1.30-alpha.5-universal.zip",
  sha256: "5".repeat(64),
  sourceCommit: "7".repeat(40),
});

/** This Mac's own installed app, 0.1.28-alpha.3 on alpha, and the pages it opened. */
function ownUpdates() {
  const opened: string[] = [];
  const fetched: string[] = [];
  const updates: UpdateChecker = createUpdateChecker({
    currentVersion: "0.1.28-alpha.3",
    channel: () => "alpha",
    fetchImpl: (async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ schemaVersion: 1, targets: { alpha: OFFERED } }));
    }) as typeof fetch,
    openExternal: (url) => {
      opened.push(url);
    },
  });
  return { updates, opened, fetched };
}

function shell(
  joinedDir = join(scratchDir("infinitary-shell-"), "joined"),
  work?: ShellOptions["work"],
) {
  const own = ownCore();
  // This Mac's Notification Center, and whether its window is in front.
  const notified: { title: string; body: string }[] = [];
  const window = { focused: false };
  // The view's own sockets to the other Mac, so a test can drop one.
  const sockets: WebSocket[] = [];
  const ownApp = ownUpdates();
  const startCore = vi.fn(async () => own.core);
  const closeConnection = vi.fn(async () => {});
  const restartWindows = vi.fn();
  const relaunch = vi.fn();
  const pushes: { channel: string; payload: unknown }[] = [];
  // The pages this Mac opened in its browser for the other Mac.
  const opened: string[] = [];
  const joined = new JoinedHome(joinedDir, () => {});
  const startConnectionSpy = vi.fn(
    (): HomeConnection => ({
      close: closeConnection,
      runningVersions: () => [],
      listening: () => [],
      localDoor: () => null,
      settled: async () => {},
      ask: async () => {
        throw new Error("Nothing is connected.");
      },
      onWorkDevice: () => () => {},
      onViewDevice: () => () => {},
      onWorkVersion: () => () => {},
      onListening: () => () => {},
      onAppSent: () => () => {},
    }),
  );
  const made = new Shell({
    joined,
    ...(work ? { work } : {}),
    startCore,
    startConnection: startConnectionSpy,
    broadcast: (channel, payload) => pushes.push({ channel, payload }),
    notifications: {
      supported: () => true,
      focused: () => window.focused,
      show: (notification) => notified.push(notification),
    },
    deviceName: async () => "MacBook Air",
    openPage: async (url) => {
      opened.push(url);
    },
    restartWindows,
    relaunch,
    view: {
      link: (options) =>
        new HomeLink({
          ...options,
          dial: async (grant) => {
            const socket = await dialHome(grant);
            sockets.push(socket);
            return socket;
          },
          retryMs: [20],
        }),
    },
    updates: ownApp.updates,
  });
  stops.push(() => made.dispose());
  const until = async (check: () => boolean) => {
    await expect.poll(check, { timeout: 4_000, interval: 10 }).toBe(true);
  };
  const view = () => made.thisMac() as Extract<ThisMac, { role: "view" }>;
  return {
    shell: made,
    joined,
    own,
    startCore,
    closeConnection,
    startConnectionSpy,
    restartWindows,
    relaunch,
    pushes,
    opened,
    notified,
    window,
    sockets,
    until,
    view,
    ownApp,
  };
}

describe("the app as a view of another Mac", () => {
  it("joins with a pasted link: stops its own Firstmate and asks the other Mac instead", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    expect(air.shell.thisMac()).toEqual({ role: "home", left: null });
    expect(await air.shell.dispatch("inf:app:healthcheck", [])).toEqual({
      ownCore: "inf:app:healthcheck",
    });
    // The core reaches the computers that run work through the connection,
    // and keeps its own SSH connection to each it added by its address, paused in sleep.
    expect(air.own.attach).toHaveBeenCalledWith(air.startConnectionSpy.mock.results[0]?.value);
    expect(air.own.ssh.start).toHaveBeenCalledTimes(1);
    // Pairing follows this Mac's network, so the connection listens where this Mac is now.
    expect(air.own.follow).toHaveBeenCalledTimes(1);
    air.shell.suspended();
    air.shell.resumed();
    expect(air.own.ssh.suspend).toHaveBeenCalledTimes(1);
    expect(air.own.ssh.resume).toHaveBeenCalledTimes(1);

    // A size key asks its own core as the captain, as the Size picker does,
    // so the catalog leaves the step's trail.
    air.shell.size["size.larger"]();
    await air.until(() =>
      air.own.dispatch.mock.calls.some(([channel]) => channel === "inf:settings:appearance:set"),
    );
    expect(
      air.own.dispatch.mock.calls.find(([channel]) => channel === "inf:settings:appearance:set"),
    ).toEqual([
      "inf:settings:appearance:set",
      [{ ...DEFAULT_SHELL_PREFERENCES.appearance, size: 110 }],
      { kind: "captain" },
      undefined,
    ]);

    // This Mac's own keys, kept by its own core.
    const own = {
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "commands.search": [{ key: "p", meta: true }] },
    };
    air.shell.keymap.save(own);
    expect(air.shell.keymap.bindings()["commands.search"]).toEqual([{ key: "p", meta: true }]);

    await expect(air.shell.join(await pro.link())).resolves.toEqual({ ok: true });
    await air.until(() => air.restartWindows.mock.calls.length === 1);
    // Its own core and connection stopped, its SSH connections first, and nothing listens for devices here.
    expect(air.own.dispose).toHaveBeenCalledTimes(1);
    expect(air.own.stopSsh).toHaveBeenCalledTimes(1);
    expect(air.closeConnection).toHaveBeenCalledTimes(1);
    expect(air.own.unreach).toHaveBeenCalledTimes(1);
    expect(air.own.unfollow).toHaveBeenCalledTimes(1);
    expect(air.shell.core()).toBeNull();
    expect(air.shell.dictationEnabled()).toBe(false);
    await air.until(() => air.view().contact === "in-reach");
    expect(air.view()).toMatchObject({ role: "view", name: "MacBook Pro", address: "127.0.0.1" });
    expect(pro.pairing.list().map((device) => device.name)).toEqual(["MacBook Air"]);

    // What a view may ask goes to the other Mac.
    expect(await air.shell.dispatch("inf:app:healthcheck", [])).toMatchObject({
      platform: "other-os",
    });
    // What stays there is refused here, and never sent.
    await expect(air.shell.dispatch("inf:voice:status", [])).rejects.toThrow(
      "answered only on the computer where your first mate lives",
    );
    expect(pro.asked).not.toContain("inf:voice:status");
    // Its computers and phones are asked there (INF-1352's plan, piece 2).
    await expect(air.shell.dispatch("inf:devices:list", [])).rejects.toThrow("malformed request");
    expect(pro.asked).toContain("inf:devices:list");
    // Its look starts from the other Mac's, then is its own.
    expect((await air.shell.dispatch("inf:shell:preferences", [])).appearance).toMatchObject({
      theme: "light",
      size: 125,
    });
    await air.shell.dispatch("inf:settings:appearance:set", [{ theme: "dark", size: 110 }]);
    expect(air.shell.preferences.get().appearance).toEqual({ theme: "dark", size: 110 });
    expect(pro.asked.filter((channel) => channel.startsWith("inf:settings:"))).toEqual([]);
    // INF-3660's plan, "Your panels, in every window": "the first mate would
    // send each panel's built files over the window's connection, instead of
    // naming a folder", so this Mac asks there, and the panels switch it
    // shows is the first mate's.
    pro.stage.panel = { builtFor: "9.9.9", files: [{ path: "panel.mjs", data: "ZXhwb3J0IHt9" }] };
    const notes = { source: "yours" as const, id: "notes", version: "0".repeat(16) };
    expect(await air.shell.panelFiles(notes)).toEqual(pro.stage.panel);
    expect(pro.asked).toContain("inf:plugins:files");
    await air.until(() => air.shell.preferences.get().panels.enabled);
    // Its keys are this Mac's own here too: a new profile's preset to start, kept in its own look.
    expect(air.shell.keymap.current().saved).toEqual(presetKeymap("vim"));
    const here = { ...presetKeymap("vim"), keys: { "settings.open": [] } };
    air.shell.keymap.save(here);
    expect(air.joined.look()?.keyboard).toEqual(here);
    expect(air.own.core.services.preferences.keymap().saved).toEqual(own);
    expect(pro.asked.filter((channel) => channel.includes("keyboard"))).toEqual([]);

    // A push the stage shows reaches the window; the other Mac's look never does.
    pro.events.emit("inf:models:changed", { ok: true });
    pro.events.emit("inf:shell:preferences", DEFAULT_SHELL_PREFERENCES);
    pro.events.emit("inf:voice:progress", {
      file: "model.onnx",
      fileIndex: 0,
      fileCount: 1,
      fraction: 0.5,
    });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    // The look told here is this Mac's own; the one the other Mac just sent
    // (the catalog's size) never is, though its panels switch is followed.
    const looks = air.pushes
      .filter((push) => push.channel === "inf:shell:preferences")
      .map((push) => (push.payload as ShellPreferences).appearance);
    expect(looks.at(-1)).toEqual({ theme: "dark", size: 110 });
    expect(looks.filter((look) => look.size === DEFAULT_SHELL_PREFERENCES.appearance.size)).toEqual(
      [],
    );

    // INF-3660's plan: "Panels being built ... stay with a window on the first
    // mate's computer", so this Mac hears the captain's panels and none being built.
    const panel: PersonalExtensionView = {
      id: "notes",
      source: "yours",
      by: null,
      title: "Notes",
      placement: { x: "left", y: "top" },
      order: 100,
      size: "content",
      present: true,
      ownPresence: false,
      moves: false,
      running: false,
      reads: [],
      sql: [],
      panel: null,
      frame: { version: "0".repeat(16) },
      server: null,
      cardViews: [],
      cards: {},
      header: [],
      commands: [],
      error: null,
    };
    pro.events.emit("inf:plugins:personal", {
      extensions: [panel],
      drafts: [{ ...panel, id: "notes-being-built", running: true }],
    });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:plugins:personal"));
    expect(air.pushes.find((push) => push.channel === "inf:plugins:personal")?.payload).toEqual({
      extensions: [panel],
    });

    // Its size keys step this Mac's own look, through the same door, and never ask there.
    air.shell.size["size.larger"]();
    await air.until(() => air.shell.preferences.get().appearance.size === 125);
    expect(pro.asked.filter((channel) => channel.startsWith("inf:settings:"))).toEqual([]);
  });

  it("starts as a view after joining, with no core, and Leave brings its own Firstmate back in place", async () => {
    const pro = await otherMac();
    const dir = join(scratchDir("infinitary-shell-"), "joined");
    new JoinedHome(dir).join(
      await claimLink(await pro.link(), { kind: "view", name: "MacBook Air" }),
      Date.UTC(2026, 9, 3, 14, 6),
    );
    const air = shell(dir);
    await air.shell.start();
    expect(air.startCore).not.toHaveBeenCalled();
    await air.until(() => air.view().contact === "in-reach");

    await air.shell.leave();
    // The other Mac heard it, and lists it no more.
    expect(pro.pairing.list()).toEqual([]);
    // This Mac's own Firstmate starts here, the first time this process runs it.
    expect(air.startCore).toHaveBeenCalledTimes(1);
    expect(air.relaunch).not.toHaveBeenCalled();
    expect(air.restartWindows).toHaveBeenCalledTimes(1);
    expect(air.shell.thisMac()).toMatchObject({
      role: "home",
      left: { name: "MacBook Pro", reason: "left" },
    });
    // The grant and its key are gone.
    expect(air.joined.read()).toBeNull();
  });

  it("starts the app again to bring its own Firstmate back when this process already ran it", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.shell.leave();
    expect(air.startCore).toHaveBeenCalledTimes(1);
    expect(air.relaunch).toHaveBeenCalledTimes(1);
  });

  // INF-3307's audit, row 10: two joins answered together each switched the
  // window to a view, and the first view stayed open beside the second.
  it("joins once when two links are pasted together, and leaves no second view open", async () => {
    const pro = await otherMac();
    const studio = await otherMac();
    const air = shell();
    await air.shell.start();
    const [first, second] = await Promise.all([
      air.shell.join(await pro.link()),
      air.shell.join(await studio.link()),
    ]);
    expect([first, second]).toEqual([{ ok: true }, { ok: false, refused: "other" }]);
    // The second link is never used, so the other computer keeps no device for it.
    expect(studio.pairing.list()).toEqual([]);
    await air.until(() => air.restartWindows.mock.calls.length === 1);
    await air.until(() => air.view().contact === "in-reach");
    // One view, with its one connection open to the Mac it joined.
    expect(air.sockets.filter((socket) => socket.readyState === socket.OPEN)).toHaveLength(1);
    expect(pro.pairing.list().map((device) => device.name)).toEqual(["MacBook Air"]);
    expect(air.own.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns to its own first launch, saying so, when the other Mac removes it", async () => {
    const pro = await otherMac();
    const dir = join(scratchDir("infinitary-shell-"), "joined");
    const grant = await claimLink(await pro.link(), { kind: "view", name: "MacBook Air" });
    new JoinedHome(dir).join(grant, Date.now());
    const air = shell(dir);
    await air.shell.start();
    await air.until(() => air.view().contact === "in-reach");
    pro.pairing.remove(grant.deviceId);
    await air.until(() => air.shell.thisMac().role === "home");
    expect(air.shell.thisMac()).toMatchObject({
      left: { name: "MacBook Pro", reason: "removed" },
    });
    expect(air.joined.read()).toBeNull();
  });

  it("refuses a change at once while the other Mac is out of reach, and says as of when", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    await pro.quit();
    await air.until(() => air.view().contact === "closed");
    expect(air.view().heardAt).not.toBeNull();
    await expect(air.shell.dispatch("inf:cards:close", ["card-1"])).rejects.toThrow("out of reach");
    expect(pro.asked).not.toContain("inf:cards:close");
    // The window hears each change of what this app is.
    expect(
      air.pushes.some(
        (push) =>
          push.channel === "inf:devices:this-mac" &&
          (push.payload as ThisMac).role === "view" &&
          (push.payload as { contact: string }).contact === "closed",
      ),
    ).toBe(true);
  });

  // INF-1352's plan, the captain's answer one_rule=every-view: this Mac does what the first
  // mate's own window would, whatever started it.
  it("asks what the first mate's own window would and opens the pages it sends", async () => {
    const mini = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await mini.link());
    await air.until(() => air.view().contact === "in-reach");

    // Its Settings are asked there; the stand-in core's refusal is its answer.
    await expect(air.shell.dispatch("inf:settings:routing:get", [])).rejects.toThrow(
      "malformed request",
    );
    expect(mini.asked).toContain("inf:settings:routing:get");
    // This Mac's own look stays here, and its devices are asked there.
    await air.shell.dispatch("inf:settings:appearance:set", [{ theme: "dark", size: 110 }]);
    expect(air.shell.preferences.get().appearance).toEqual({ theme: "dark", size: 110 });
    await expect(
      air.shell.dispatch("inf:devices:invite", [{ kind: "view", at: "127.0.0.1:1" }]),
    ).rejects.toThrow("malformed request");
    expect(mini.asked.filter((channel) => /appearance/.test(channel))).toEqual([]);
    expect(mini.asked).toContain("inf:devices:invite");

    // A sign-in's steps reach the window, and its page opens in this Mac's browser.
    const page = "https://auth.openai.com/oauth/authorize?client_id=app";
    mini.events.emit("inf:auth:notice", {
      providerId: "openai-codex",
      kind: "auth_url",
      message: "Finish signing in with your browser.",
      url: page,
    });
    mini.events.emit("inf:app:open-page", { url: page });
    await air.until(() => air.opened.length === 1);
    expect(air.opened).toEqual([page]);
    expect(air.pushes.map((push) => push.channel)).toContain("inf:auth:notice");
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:app:open-page");

    // One sent while this Mac was away is old news when the welcome replays it.
    air.sockets.at(-1)?.terminate();
    mini.events.emit("inf:app:open-page", { url: `${page}&again` });
    mini.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    expect(air.opened).toEqual([page]);
  });

  // INF-3486: a sentence the first mate's computer writes of itself as this computer names
  // that computer on one that controls it, and the captain's own words stay as they are.
  it("names that Mac where its own refusals and feed lines say this computer", async () => {
    const mini = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await mini.link());
    await air.until(() => air.view().contact === "in-reach");
    const named = ownWords("MacBook Pro");

    expect(await air.shell.dispatch("inf:feed:recent", [])).toEqual([
      { kind: "info", text: named.note, at: 1, taskKey: "HAR-1", event: "note", saidHere: true },
      { ...CAPTAIN, at: 2 },
    ]);
    expect(await air.shell.dispatch("inf:cards:open-page", ["page-card"])).toEqual({
      refusal: named.openPage,
    });
    expect(await air.shell.dispatch("inf:browser:reopen", ["sign-up"])).toEqual({
      ok: false,
      text: named.reopen,
    });
    const refused = await air.shell.dispatch("inf:browser:stop", ["sign-up"]).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused.message).toContain(named.stop);
    expect(refused.message).not.toContain(HERE.This);

    // INF-3676: a task's record and the cards it wrote itself, read or pushed, are named too
    // (`namedHere.test.ts` owns what each names); a crewmate's card stays as it was.
    mini.show(ownCards());
    await air.until(() => air.pushes.some((push) => push.channel === "inf:cards"));
    for (const [channel, args] of OWN_READS) {
      const answer = await air.shell.dispatch(channel, [...args]);
      expect(answer).toEqual(namedHere(channel, answerInOwnWords(channel), () => "MacBook Pro"));
      expect(answer).not.toEqual(answerInOwnWords(channel));
    }
    expect(air.pushes.find((push) => push.channel === "inf:cards")?.payload).toEqual(
      namedHere("inf:cards:list", ownCards(), () => "MacBook Pro"),
    );
  });

  // The captain's answer on the review of one rule for every view: a home too old to list the
  // change is told apart, so the window can say it needs an update instead of asking.
  it("knows when the first mate there is too old to answer what every view asks", async () => {
    const older = await otherMac({ changes: [] });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await older.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => air.shell.thisMac().role === "view");
    expect(air.shell.thisMac()).toMatchObject({
      role: "view",
      needsUpdateThere: true,
      returnsNeedUpdateThere: true,
      devicesNeedUpdateThere: true,
    });

    // One that answers every view's settings but not yet its devices (INF-1352's plan, piece 2).
    const before = await otherMac({ changes: ["every-view-asks"] });
    const mini = shell();
    await mini.shell.start();
    await mini.shell.join(await before.link());
    await mini.until(() => mini.view().contact === "in-reach");
    await mini.until(() => mini.shell.thisMac().role === "view");
    expect(mini.shell.thisMac()).toMatchObject({ role: "view", devicesNeedUpdateThere: true });
    expect(mini.shell.thisMac()).not.toHaveProperty("needsUpdateThere");
    // A first mate that sends no panel's files yet leaves the captain's
    // panels off here, as before (INF-3660's plan, "Your panels, in every window").
    await mini.until(() => before.asked.includes("inf:cards:list"));
    expect(mini.shell.preferences.get().panels.enabled).toBe(false);

    const current = await otherMac();
    const pro = shell();
    await pro.shell.start();
    await pro.shell.join(await current.link());
    await pro.until(() => pro.view().contact === "in-reach");
    expect(pro.shell.thisMac()).not.toHaveProperty("needsUpdateThere");
    expect(pro.shell.thisMac()).not.toHaveProperty("devicesNeedUpdateThere");
    expect(pro.shell.thisMac()).not.toHaveProperty("returnsNeedUpdateThere");
  });

  // INF-3454's plan, the captain's answer direction=catch-here: a sign-in page whose browser
  // comes back to the other computer's loopback address is caught here at its port and
  // handed back; when the port is taken here, the window asks for the address instead.
  it("catches a sign-in's return at its port here and hands it to the other computer, once", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");

    const port = await claimedPort();
    const page = "https://accounts.google.com/o/oauth2/v2/auth?client_id=app";
    pro.events.emit("inf:app:sign-in-page", { url: page, id: "return-1", port });
    await air.until(() => air.opened.includes(page));
    expect(air.view().signInReturn).toEqual({ id: "return-1", caught: true });
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:app:sign-in-page");

    // The browser here comes back from Google's page.
    const back = await fetch(`http://127.0.0.1:${port}/?state=s1&code=4%2F0Aan&scope=gmail`);
    expect(back.status).toBe(200);
    expect(await back.text()).toBe("Signed in to Google.");
    expect(pro.returns).toEqual([
      { id: "return-1", address: "/?state=s1&code=4%2F0Aan&scope=gmail" },
    ]);
    // Taken once: nothing more reaches the other computer through here.
    await expect(fetch(`http://127.0.0.1:${port}/?state=s1&code=again`)).rejects.toThrow();
    expect(pro.returns).toHaveLength(1);

    pro.events.emit("inf:app:sign-in-ended", { id: "return-1" });
    await air.until(() => air.view().signInReturn === undefined);
  });

  it("asks for the address when something here already holds the sign-in's port", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");

    const holder = createServer((_request, response) => response.end("someone else"));
    const port = await claimedPort();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    stops.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const page = "https://accounts.google.com/o/oauth2/v2/auth?client_id=app&taken";
    pro.events.emit("inf:app:sign-in-page", { url: page, id: "return-2", port });
    await air.until(() => air.opened.includes(page));
    expect(air.view().signInReturn).toEqual({ id: "return-2", caught: false });
    // The program that holds it still answers its own, and nothing is handed on.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("someone else");
    expect(pro.returns).toEqual([]);

    // The sign-in's end there clears the ask here.
    pro.events.emit("inf:app:sign-in-ended", { id: "return-2" });
    await air.until(() => air.view().signInReturn === undefined);
  });

  // INF-1352's plan, piece 3: any view watches a task's browser as pictures over the
  // connection, and a view of an older first mate says to update it instead.
  it("shows a task's browser from the other Mac in each window that watches it, and watches again after a drop", async () => {
    const mini = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await mini.link());
    await air.until(() => air.view().contact === "in-reach");
    expect(air.shell.thisMac()).not.toHaveProperty("browserNeedsUpdateThere");

    // Two windows here watch the same task: the other Mac hears one watch.
    const window = (): BrowserViewer & { seen: string[]; close: () => void } => {
      const gone: (() => void)[] = [];
      const seen: string[] = [];
      return {
        seen,
        show: (frame) => seen.push(`${frame.taskId}:${frame.data}`),
        onGone: (listener) => gone.push(listener),
        close: () => {
          for (const listener of gone.splice(0)) listener();
        },
      };
    };
    const first = window();
    const second = window();
    expect(await air.shell.dispatch("inf:browser:watch", ["t1"], first)).toEqual({
      watching: true,
    });
    expect(await air.shell.dispatch("inf:browser:watch", ["t1"], second)).toEqual({
      watching: true,
    });
    expect(mini.asked.filter((channel) => channel === "inf:browser:watch")).toHaveLength(1);
    expect(mini.pages.watchers("t1")).toBe(1);
    mini.pages.paint("t1", "page-1");
    await air.until(() => first.seen.length === 1 && second.seen.length === 1);
    expect(first.seen).toEqual(["t1:page-1"]);

    // Only a window that watches gives the page its room.
    const room = { width: 1200, height: 760 };
    await air.shell.dispatch("inf:browser:size", ["t2", room], first);
    await air.shell.dispatch("inf:browser:size", ["t1", room], first);
    await air.until(() => mini.pages.rooms.length === 1);
    expect(mini.pages.rooms).toEqual([{ taskId: "t1", size: room }]);

    // The connection drops: the other Mac forgets the watch, and the welcome asks it again.
    air.sockets.at(-1)?.terminate();
    await air.until(() => mini.pages.log.length === 3);
    expect(mini.pages.log).toEqual(["+t1", "-t1", "+t1"]);
    await air.until(() => mini.pages.rooms.length === 2);
    expect(mini.pages.rooms[1]).toEqual({ taskId: "t1", size: room });
    mini.pages.paint("t1", "page-2");
    await air.until(() => second.seen.length === 2);

    // A window that closes stops watching; when the last one goes, the other Mac stops sending.
    first.close();
    mini.pages.paint("t1", "page-3");
    await air.until(() => second.seen.length === 3);
    expect(first.seen).toEqual(["t1:page-1", "t1:page-2"]);
    await air.shell.dispatch("inf:browser:unwatch", ["t1"], second);
    await air.until(() => mini.pages.watchers("t1") === 0);
  });

  it("says to update an older first mate before it shows its task's browser here", async () => {
    const older = await otherMac({ changes: [] });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await older.link());
    await air.until(() => air.view().contact === "in-reach");
    expect(air.shell.thisMac()).toMatchObject({ role: "view", browserNeedsUpdateThere: true });
    const viewer: BrowserViewer = { show: () => {}, onGone: () => {} };
    expect(await air.shell.dispatch("inf:browser:watch", ["t1"], viewer)).toEqual({
      watching: false,
    });
    expect(older.asked).not.toContain("inf:browser:watch");
  });

  // The other computer's look and voice are its own: they never reach this window.
  it("shows what its Settings follow and none of the other computer's own look", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    pro.events.emit("inf:auth:notice", {
      providerId: "openai-codex",
      kind: "info",
      message: "Signing in.",
    });
    pro.events.emit("inf:shell:preferences", DEFAULT_SHELL_PREFERENCES);
    pro.events.emit("inf:voice:progress", {
      file: "model.onnx",
      fileIndex: 0,
      fileCount: 1,
      fraction: 0.5,
    });
    // Its computers and phones, which its Devices follows (INF-1352's plan, piece 2).
    pro.events.emit("inf:devices", []);
    pro.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    expect(air.pushes.map((push) => push.channel)).toContain("inf:auth:notice");
    expect(air.pushes.map((push) => push.channel)).toContain("inf:devices");
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:voice:progress");
    // This view's look started from the other Mac's saved one (light), so a
    // push in the catalog's theme would be the look the other Mac just sent.
    expect(
      air.pushes.filter(
        (push) =>
          push.channel === "inf:shell:preferences" &&
          (push.payload as ShellPreferences).appearance.theme ===
            DEFAULT_SHELL_PREFERENCES.appearance.theme,
      ),
    ).toEqual([]);
  });

  it("answers this Mac's own update notice while the other Mac is newer, and never asks it", async () => {
    // Beyond the supported window there: this Mac only reads until it is updated.
    const newerMajor = Number(PROTOCOL_VERSION.split(".")[0]) + PROTOCOL_MAJORS_BEHIND + 1;
    const newerVersion = `${newerMajor}.0.0`;
    // A major that broke views moves the floor to itself (docs/contract.md).
    const pro = await otherMac({ protocolVersion: newerVersion, viewFloor: newerMajor });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach" && air.view().readOnly !== null);
    expect(air.view().readOnly).toBe("newer-there");
    // The notice is this Mac's own installed app's, as the Mac where Firstmate lives shows its own.
    expect(await air.shell.dispatch("inf:update:status", [])).toEqual({
      currentVersion: "0.1.28-alpha.3",
      channel: "alpha",
      latestVersion: "0.1.30-alpha.5",
      updateAvailable: true,
      releaseUrl: OFFERED.releaseUrl,
      upgradeCommand: upgradeCommandFor("alpha"),
      checkedAt: expect.any(Number),
    });
    // The offered version's link opens that version's page here, though changes there are refused.
    expect(await air.shell.dispatch("inf:update:open-release", [])).toEqual({ ok: true });
    expect(air.ownApp.opened).toEqual([OFFERED.releaseUrl]);
    await expect(air.shell.dispatch("inf:cards:close", ["card-1"])).rejects.toThrow(
      `only reads from a home on ${newerVersion}`,
    );
    expect(pro.asked.filter((channel) => channel.startsWith("inf:update:"))).toEqual([]);
  });

  it("says why a pasted link did not join, and stays as it was", async () => {
    const pro = await otherMac();
    const air = shell();
    await air.shell.start();
    expect(await air.shell.join("https://example.com/not-a-link")).toEqual({
      ok: false,
      refused: "not-a-link",
    });
    expect(await air.shell.join(await pro.link("work"))).toEqual({ ok: false, refused: "kind" });
    const used = await pro.link();
    await claimLink(used, { kind: "view", name: "Someone else" });
    expect(await air.shell.join(used)).toEqual({ ok: false, refused: "used" });
    const away = await pro.link();
    await pro.quit();
    expect(await air.shell.join(away)).toEqual({ ok: false, refused: "unreachable" });
    expect(air.shell.thisMac()).toEqual({ role: "home", left: null });
    expect(air.own.dispose).not.toHaveBeenCalled();
  });
});

/**
 * A Mac that both controls Firstmate on another and runs its work
 * (docs/view.md, "A Mac that runs work"): one device on that Mac's list,
 * whose window and work keep the same grant.
 */
describe("a Mac that controls another and runs its work", () => {
  const workDir = () => join(scratchDir("infinitary-shell-work-"), "work");
  const sam = { name: "sam", uid: 501 };

  it("joins with a link for a Mac: controls it, and its work keeps the same grant and starts in the background", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const background = vi.fn(async () => "running" as const);
    const air = shell(undefined, { dataDir, background });
    await air.shell.start();
    expect(await air.shell.join(await pro.link("mac"))).toEqual({ ok: true });
    await air.until(() => air.shell.thisMac().role === "view");
    await air.until(() => air.view().contact === "in-reach");
    expect(air.view().runsWork).toBe(true);
    expect(pro.pairing.list()).toEqual([
      expect.objectContaining({ kind: "mac", name: "MacBook Air", user: userInfo().username }),
    ]);
    await expect.poll(() => background.mock.calls.length).toBe(1);
    // The background starts this app itself: no copy to keep.
    expect(background).toHaveBeenCalledWith({ launcher: null, app: null });
    expect(new JoinedHome(dataDir).read()?.grant).toEqual(air.joined.read()?.grant);
  });

  it("opens as a view of the home its work runs for, with no new link, and never again as the device it left", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "Mac mini",
      user: sam,
    });
    new JoinedHome(dataDir).join(grant, Date.UTC(2026, 9, 3, 14, 6));
    const joinedDir = join(scratchDir("infinitary-shell-"), "joined");
    const mini = shell(joinedDir, { dataDir });
    await mini.shell.start();
    expect(mini.startCore).not.toHaveBeenCalled();
    await mini.until(() => mini.view().contact === "in-reach");
    expect(mini.view()).toMatchObject({ name: "MacBook Pro", runsWork: true });
    expect(mini.joined.read()?.grant).toEqual(grant);

    await mini.shell.leave();
    // Its work keeps the grant until it hears it was removed; Firstmate
    // opened here again is this Mac's own.
    expect(new JoinedHome(dataDir).read()?.grant.deviceId).toBe(grant.deviceId);
    const again = shell(joinedDir, { dataDir });
    await again.shell.start();
    expect(again.startCore).toHaveBeenCalledTimes(1);
    expect(again.shell.thisMac()).toMatchObject({ role: "home", left: { reason: "left" } });
  });

  it("stays its own Firstmate when the work here only runs work", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const dataDir = workDir();
    // Another user on that Mac, or a Mac added before a Mac could do both.
    const grant = await claimLink(await pro.link("work"), {
      kind: "work",
      name: "Mini",
      user: sam,
    });
    new JoinedHome(dataDir).join(grant, Date.now());
    const mini = shell(undefined, { dataDir });
    await mini.shell.start();
    expect(mini.startCore).toHaveBeenCalledTimes(1);
    expect(mini.shell.thisMac()).toEqual({ role: "home", left: null });
  });
});

/**
 * A view's notifications (docs/view.md, "Notifications"): the other Mac's
 * cards reach this Mac's Notification Center as they reach that Mac's, while
 * this Mac's window is in the background and that Mac's own switch is on.
 */
describe("notifications on a view of another Mac", () => {
  /** This Mac, joined to the other and in reach, having read what it shows. */
  async function joined(pro: Awaited<ReturnType<typeof otherMac>>) {
    const air = shell();
    await air.shell.start();
    await air.shell.join(await pro.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => pro.asked.includes("inf:cards:list"));
    // Asked after that read on the same connection, so answered after it too.
    await air.shell.dispatch("inf:app:healthcheck", []);
    return air;
  }
  /** Until a push of the other Mac's stage holding this card reached the window here. */
  const heard = (air: ReturnType<typeof shell>, id: string) =>
    air.until(() =>
      air.pushes.some(
        (push) =>
          push.channel === "inf:cards" && (push.payload as Card[]).some((card) => card.id === id),
      ),
    );

  it("posts the other Mac's new card as that Mac does, only while this window is in the background", async () => {
    const pro = await otherMac();
    const old = shown("old", { title: "Already there" });
    pro.show([old]);
    const air = await joined(pro);
    // What the other Mac's own notifier makes of the same pushes.
    const there: { title: string; body: string }[] = [];
    const home = new CardNotifier({
      enabled: () => true,
      focused: () => false,
      show: (notification) => there.push(notification),
    });
    home.observe(pro.stage.cards);

    const decision = shown("decision", {
      title: "Two ways to fix the flaky test",
      body: "<p>Mock the clock, or await the queue.</p><p>The second is smaller.</p>",
      actions: [{ id: "queue", label: "Await the queue", default: true }],
    });
    pro.show([old, decision]);
    home.observe(pro.stage.cards);
    await air.until(() => air.notified.length === 1);
    expect(air.notified).toEqual([
      {
        title: "Two ways to fix the flaky test",
        body: "Mock the clock, or await the queue. The second is smaller.",
      },
    ]);
    expect(air.notified).toEqual(there);

    // A new report arrives ready; later body updates are not new notifications.
    const report = shown("report", { title: "Tests fixed", body: "<p>All green.</p>" });
    pro.show([old, decision, report]);
    home.observe(pro.stage.cards);
    await air.until(() => air.notified.length === 2);
    expect(air.notified[1]).toEqual({ title: "Tests fixed", body: "All green." });
    expect(air.notified).toEqual(there);
    pro.show([old, decision, { ...report, body: "<p>All green, checked again.</p>" }]);
    home.observe(pro.stage.cards);
    await air.shell.dispatch("inf:app:healthcheck", []);
    expect(air.notified).toHaveLength(2);
    expect(air.notified).toEqual(there);

    // With this Mac's window in front, the person is looking at it already.
    air.window.focused = true;
    pro.show([...pro.stage.cards, shown("seen-here")]);
    await heard(air, "seen-here");
    expect(air.notified).toHaveLength(2);
    // The card that was there before this Mac joined never posts.
    expect(air.notified.map((notification) => notification.title)).not.toContain("Already there");
  });

  it("follows the other Mac's own Notifications switch", async () => {
    const pro = await otherMac();
    const air = await joined(pro);
    pro.stage.notifications = false;
    pro.show([shown("quiet", { title: "Turned off there" })]);
    await air.until(
      () =>
        pro.asked.filter((channel) => channel === "inf:settings:notifications:get").length === 1,
    );
    pro.stage.notifications = true;
    pro.show([...pro.stage.cards, shown("loud", { title: "Turned on there" })]);
    await air.until(() => air.notified.length === 1);
    // Asked in order on one connection: the first card's answer came first.
    expect(air.notified.map((notification) => notification.title)).toEqual(["Turned on there"]);
  });

  it("posts a card that became ready while the connection dropped, and treats a full read as old news", async () => {
    const pro = await otherMac();
    const air = await joined(pro);
    // This Mac's socket drops; the other Mac keeps numbering what it misses.
    air.sockets.at(-1)?.terminate();
    pro.show([shown("while-away", { title: "Born while away" })]);
    await air.until(() => air.notified.length === 1);
    expect(air.notified[0]?.title).toBe("Born while away");

    // Firstmate restarts there with a card this Mac never heard: it reads
    // everything again, and what it reads is old news, as at the other Mac.
    await pro.quit();
    await air.until(() => air.view().contact === "closed");
    pro.stage.cards = [...pro.stage.cards, shown("restored", { title: "Restored there" })];
    pro.restart();
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => pro.asked.filter((channel) => channel === "inf:cards:list").length === 2);
    await air.shell.dispatch("inf:app:healthcheck", []);
    pro.show([...pro.stage.cards, shown("after", { title: "After the restart" })]);
    await air.until(() => air.notified.length === 2);
    expect(air.notified.map((notification) => notification.title)).toEqual([
      "Born while away",
      "After the restart",
    ]);
  });
});

// INF-1352's plan, local_path=real-connection (docs/view.md, "The window on the first mate's own
// computer"): the window here asks its first mate over the local door and hears it there, and
// asks directly when the door cannot carry it, reading everything again after any gap.
describe("the window on the first mate's own computer", () => {
  type StandInLink = NonNullable<NonNullable<ShellOptions["localWindow"]>["link"]>;
  type LinkOptions = Parameters<StandInLink>[0];

  function homeShell(options: { link?: StandInLink; readyMs?: number; door?: boolean } = {}) {
    const own = ownCore();
    const pushes: { channel: string; payload: unknown }[] = [];
    const doorDir = join(scratchDir("infinitary-shell-door-"), "local-door");
    const pairing = new DevicePairing({
      dir: join(scratchDir("infinitary-shell-door-"), "devices"),
      onProblem: () => {},
    });
    let connection: HomeConnection | null = null;
    const made = new Shell({
      joined: new JoinedHome(join(scratchDir("infinitary-shell-door-"), "joined"), () => {}),
      startCore: async () => own.core,
      startConnection: (core) => {
        connection = startConnection({
          dispatch: core.dispatch,
          events: core.events,
          devices: pairing,
          localDoor: doorDir,
          port: 0,
          onProblem: () => {},
        });
        return connection;
      },
      localDoor: () => doorDir,
      ...(options.link || options.readyMs !== undefined
        ? {
            localWindow: {
              ...(options.link ? { link: options.link } : {}),
              ...(options.readyMs !== undefined ? { readyMs: options.readyMs } : {}),
            },
          }
        : {}),
      broadcast: (channel, payload) => pushes.push({ channel, payload }),
      notifications: { supported: () => false, focused: () => true, show: () => {} },
      deviceName: async () => "MacBook Pro",
      openPage: async () => {},
      restartWindows: vi.fn(),
      relaunch: vi.fn(),
      updates: ownUpdates().updates,
    });
    stops.push(async () => {
      await made.dispose();
      pairing.dispose();
    });
    return { shell: made, own, pushes, connection: () => connection };
  }

  /** A link that never reaches the door, and hands the test its options to play the first mate's part. */
  function standInLink() {
    const heard: { options: LinkOptions | null; closed: boolean; welcomed: boolean } = {
      options: null,
      closed: false,
      welcomed: false,
    };
    const link: StandInLink = (options) => {
      heard.options = options;
      return {
        start: () => {},
        invoke: async () => {
          throw new Error("Out of reach.");
        },
        state: () => ({ contact: heard.welcomed ? "in-reach" : "reaching" }) as never,
        close: () => {
          heard.closed = true;
        },
      };
    };
    return { link, heard };
  }

  const pushed = (pushes: { channel: string }[], channel: string) =>
    pushes.filter((push) => push.channel === channel).length;

  it("asks its first mate over the local door, and hears each push once, from there", async () => {
    const at = homeShell();
    await at.shell.start();
    const asked = await at.shell.dispatch("inf:app:healthcheck", []);
    expect(asked).toEqual({ ownCore: "inf:app:healthcheck" });
    // The connection asks as the captain, with that client as the viewer of a task's browser.
    expect(at.own.dispatch.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["inf:app:healthcheck", [], { kind: "captain" }],
    ]);
    at.own.core.events.emit("inf:models:changed", { ok: true });
    await expect.poll(() => pushed(at.pushes, "inf:models:changed")).toBe(1);
    // Quitting the first mate's connection leaves the window's request with no door to go through.
    await at.connection()?.close();
    await expect(at.shell.dispatch("inf:app:healthcheck", [])).rejects.toThrow();
  });

  // INF-3486: only a computer that controls the first mate names it; its own window shows
  // what its core wrote.
  it("shows its first mate's own refusals and feed lines as its core wrote them", async () => {
    const at = homeShell();
    at.own.dispatch.mockImplementation(
      async (channel) => answerInOwnWords(channel) ?? { ownCore: channel },
    );
    await at.shell.start();

    expect(await at.shell.dispatch("inf:feed:recent", [])).toEqual(
      answerInOwnWords("inf:feed:recent"),
    );
    expect(await at.shell.dispatch("inf:cards:open-page", ["page-card"])).toEqual({
      refusal: SAID.openPage,
    });
    expect(await at.shell.dispatch("inf:browser:reopen", ["sign-up"])).toEqual({
      ok: false,
      text: SAID.reopen,
    });
    await expect(at.shell.dispatch("inf:browser:stop", ["sign-up"])).rejects.toThrow(SAID.stop);
    // INF-3676: a task's record and the cards it wrote itself, as written too.
    for (const [channel, args] of OWN_READS)
      expect(await at.shell.dispatch(channel, [...args])).toEqual(answerInOwnWords(channel));
    at.own.core.events.emit("inf:cards", ownCards());
    await expect.poll(() => pushed(at.pushes, "inf:cards")).toBe(1);
    expect(at.pushes.find((push) => push.channel === "inf:cards")?.payload).toEqual(ownCards());
    // Every answer came over the local door from its own core.
    expect(at.own.dispatch.mock.calls.map((call) => call[0])).toEqual([
      "inf:feed:recent",
      "inf:cards:open-page",
      "inf:browser:reopen",
      "inf:browser:stop",
      ...OWN_READS.map(([channel]) => channel),
    ]);
  });

  it("asks directly when the door never welcomes the window", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 20 });
    await at.shell.start();
    expect(heard.closed).toBe(true);
    expect(await at.shell.dispatch("inf:app:healthcheck", [])).toEqual({
      ownCore: "inf:app:healthcheck",
    });
    at.own.core.events.emit("inf:models:changed", { ok: true });
    expect(pushed(at.pushes, "inf:models:changed")).toBe(1);
  });

  it("asks directly, and reads everything again, once the door refuses the window", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 1_000 });
    const starting = at.shell.start();
    await expect.poll(() => heard.options !== null).toBe(true);
    heard.welcomed = true;
    heard.options?.onCaughtUp?.("reload");
    await starting;
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null });
    heard.options?.onState?.({ removed: true } as never);
    expect(heard.closed).toBe(true);
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, caughtUp: 1 });
    expect(pushed(at.pushes, "inf:devices:this-mac")).toBe(1);
    expect(await at.shell.dispatch("inf:app:healthcheck", [])).toEqual({
      ownCore: "inf:app:healthcheck",
    });
    at.own.core.events.emit("inf:models:changed", { ok: true });
    expect(pushed(at.pushes, "inf:models:changed")).toBe(1);
  });

  it("reads everything again after a gap its first mate could not replay, but not at the first welcome", async () => {
    const { link, heard } = standInLink();
    const at = homeShell({ link, readyMs: 1_000 });
    const starting = at.shell.start();
    await expect.poll(() => heard.options !== null).toBe(true);
    heard.welcomed = true;
    heard.options?.onCaughtUp?.("reload");
    await starting;
    heard.options?.onCaughtUp?.("replay");
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null });
    heard.options?.onCaughtUp?.("reload");
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, caughtUp: 1 });
    expect(pushed(at.pushes, "inf:devices:this-mac")).toBe(1);
  });
});

// INF-1352's plan, piece 6, the captain's answer window_joins=join (docs/run.md, "The window
// opened beside it"): the window opened while a command runs the first mate joins it over its
// local door, with no core of its own. INF-3660's plan, the captain's answers, gives it one
// rule: the first mate keeps the settings, the records and the crew, and only this window
// touches the desktop.
describe("the window beside a command's first mate", () => {
  const JOINED = { pid: 41, startedAt: "2026-11-01T08:00:00.000Z" };
  /** The command's own records in its data folder, as the window reads them. */
  type Records = Pick<RunStatus, "running" | "run" | "lastStop">;
  const stopped = (
    reason: "quit" | "signal" | "updated" | "start-failed",
    exitCode: number,
    of = JOINED,
  ): Records => ({
    running: false,
    run: null,
    // Stopped just now: the wait for a start entry counts from the record's own time.
    lastStop: { ...of, stoppedAt: new Date().toISOString(), reason, exitCode, lines: [] },
  });

  /** The command's first mate in another program: a stand-in core served on its local door. */
  function commandRun() {
    const run = ownCore();
    /** What that first mate keeps, and what this computer's window told it. */
    const there = {
      look: {
        ...DEFAULT_SHELL_PREFERENCES,
        appearance: { ...DEFAULT_SHELL_PREFERENCES.appearance, theme: "light", size: 125 },
      } as ShellPreferences,
      keys: DEFAULT_SAVED_KEYMAP as SavedKeymap,
      showInDock: true,
      dictation: true,
      cards: [] as Card[],
      here: 0,
      focused: 0,
      answers: [] as unknown[][],
      holds: [] as unknown[],
    };
    run.dispatch.mockImplementation((async (channel: string, args: unknown[]) => {
      switch (channel) {
        case "inf:shell:preferences":
          return there.look;
        case "inf:settings:appearance:set":
          there.look = { ...there.look, appearance: args[0] as ShellPreferences["appearance"] };
          run.core.events.emit("inf:shell:preferences", there.look);
          return there.look.appearance;
        case "inf:settings:keys:get":
          return { saved: there.keys, unreadable: false };
        case "inf:settings:keys:set":
          there.keys = args[0] as SavedKeymap;
          return { ok: true };
        case "inf:presence:get":
          return { startAtLogin: false, showInDock: there.showInDock };
        case "inf:settings:dictation:get":
          return { enabled: there.dictation, key: "AltRight" };
        case "inf:settings:dictation:set":
          there.dictation = (args[0] as { enabled: boolean }).enabled;
          return { enabled: there.dictation, key: "AltRight" };
        case "inf:own-window:here":
          there.here += 1;
          return { ok: true };
        case "inf:own-window:focused":
          there.focused += 1;
          return { ok: true };
        case "inf:own-window:answer":
          there.answers.push(args);
          return { ok: true };
        case "inf:cards:list":
          return there.cards;
        case "inf:settings:notifications:get":
          return true;
        case "inf:update:hold":
          there.holds.push(args[0]);
          return { saved: true, work: { state: "resuming", tasks: ["Fix the flaky test"] } };
        default:
          return { run: channel };
      }
    }) as never);
    const doorDir = join(scratchDir("infinitary-shell-beside-"), "local-door");
    const pairing = new DevicePairing({
      dir: join(scratchDir("infinitary-shell-beside-"), "devices"),
      onProblem: () => {},
    });
    let connection: HomeConnection | null = null;
    const open = () => {
      connection = startConnection({
        dispatch: run.core.dispatch,
        events: run.core.events,
        devices: pairing,
        localDoor: doorDir,
        port: 0,
        onProblem: () => {},
      });
      return connection;
    };
    stops.push(async () => {
      await connection?.close();
      pairing.dispose();
    });
    return {
      run,
      there,
      doorDir,
      open,
      stop: () => connection?.close(),
      asked: (channel: string) =>
        run.dispatch.mock.calls.filter(([asked]) => asked === channel).map(([, args]) => args),
    };
  }

  function besideShell(
    doorDir: string,
    options: {
      records?: Records;
      entry?: StartEntry;
      readyMs?: number;
      installsUpdates?: boolean;
      programReplaced?: boolean;
      /** When this window started the command, and the starter it started it with. */
      startedAt?: number;
      starts?: boolean;
    } = {},
  ) {
    const startCore = vi.fn(async () => ownCore().core);
    const relaunch = vi.fn();
    const restartWindows = vi.fn();
    const openPage = vi.fn(async (_url: string) => {});
    const pushes: { channel: string; payload: unknown }[] = [];
    /** What the command's records say now, and which start entry is in place. */
    const command = {
      records: options.records ?? ({ running: true, run: JOINED, lastStop: null } as Records),
      entry: options.entry ?? (null as StartEntry),
      programReplaced: options.programReplaced ?? false,
    };
    /** This program's own Dock icon, login item, file picker and Notification Center. */
    const program = {
      dock: [] as boolean[],
      startAtLogin: false,
      picked: ["/home/kai/report.pdf"],
      notified: [] as { title: string; body: string }[],
    };
    /** The command's starter (docs/run.md, "The window starts it"), and Stop's signals. */
    const starter = {
      start: vi.fn(async () => true),
      atLogin: {
        get: () => starter.login,
        set: (on: boolean) => {
          starter.login = on;
        },
      },
      inPlace: () => true,
      stop: vi.fn(async (_how: { forget: boolean }) => {}),
      login: false,
      stops: 0,
    };
    const made = new Shell({
      joined: new JoinedHome(join(scratchDir("infinitary-shell-beside-"), "joined"), () => {}),
      openPage,
      beside: {
        door: doorDir,
        crewmatesDir: "/run/crewmates",
        look: new JoinedHome(join(scratchDir("infinitary-shell-beside-"), "look"), () => {}),
        status: () => command.records,
        startEntry: () => command.entry,
        // The entry's own wait is the rule's (besideRun.test.ts); here the window only waits to join.
        restartWaitMs: 0,
        presence: {
          getStartAtLogin: () => program.startAtLogin,
          setStartAtLogin: (enabled) => {
            program.startAtLogin = enabled;
          },
          setShowInDock: (visible) => program.dock.push(visible),
        },
        chooseFiles: async () => program.picked,
        installsUpdates: options.installsUpdates ?? false,
        programReplaced: () => command.programReplaced,
        ...(options.starts ? { starter } : {}),
        ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
        stopCommand: () => {
          starter.stops += 1;
          return command.records.running === true;
        },
      },
      startCore,
      startConnection: () => {
        throw new Error("A window beside a command serves no connection.");
      },
      ...(options.readyMs !== undefined ? { localWindow: { readyMs: options.readyMs } } : {}),
      broadcast: (channel, payload) => pushes.push({ channel, payload }),
      notifications: {
        supported: () => true,
        focused: () => false,
        show: (notification) => program.notified.push(notification),
      },
      deviceName: async () => "MacBook Pro",
      restartWindows,
      relaunch,
      updates: ownUpdates().updates,
    });
    stops.push(() => made.dispose());
    return {
      shell: made,
      startCore,
      relaunch,
      restartWindows,
      openPage,
      pushes,
      command,
      program,
      starter,
    };
  }

  it("asks the command's first mate over its door, with no core here", async () => {
    const command = commandRun();
    const opened = command.open();
    await opened.settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    expect(at.startCore).not.toHaveBeenCalled();
    expect(at.shell.core()).toBeNull();
    // This computer's own window: nothing to leave, no device of the first mate's.
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    expect(await at.shell.dispatch("inf:repos:list", [])).toEqual({ run: "inf:repos:list" });
    expect(command.run.dispatch.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "inf:repos:list",
      [],
      { kind: "captain" },
    ]);
    command.run.core.events.emit("inf:models:changed", { ok: true });
    await expect
      .poll(() => at.pushes.filter((push) => push.channel === "inf:models:changed").length)
      .toBe(1);
    // The captain's answer direction=a, the window joins the command's first mate: a reply
    // piece that first mate streams, sent outside the numbering, reaches this window too.
    const piece = {
      type: "assistant_delta",
      taskId: "t1",
      text: "The harbour opens at six.",
    } as const;
    command.run.core.events.emit("inf:event", piece);
    await expect
      .poll(() => at.pushes.filter((push) => push.channel === "inf:event").map((p) => p.payload))
      .toEqual([piece]);
    // Card pictures are read from the command's folder; dictation follows its switch.
    expect(at.shell.pictures()).toEqual({ root: "/run/crewmates" });
    expect(at.shell.dictationEnabled()).toBe(true);
    await at.shell.dispatch("inf:settings:dictation:set", [{ enabled: false, key: "AltRight" }]);
    expect(at.shell.dictationEnabled()).toBe(false);
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // The captain's answer look_here=follow: "Follow the first mate's look and keys, on this
  // computer only", with a copy kept so the window draws right before the first mate answers.
  it("follows the first mate's look and keys, and keeps a copy for the next start", async () => {
    const command = commandRun();
    command.there.keys = {
      ...presetKeymap("emacs"),
      keys: { "settings.open": [{ key: "KeyD", meta: true }] },
    };
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    expect(at.shell.preferences.get().appearance).toMatchObject({ theme: "light", size: 125 });
    expect(at.shell.preferences.keymap()).toEqual({ saved: command.there.keys, unreadable: false });
    // A change made in this window is the first mate's to keep; the window follows its answer.
    const dark = { ...command.there.look.appearance, theme: "dark" as const };
    expect(await at.shell.dispatch("inf:settings:appearance:set", [dark])).toEqual(dark);
    expect(command.there.look.appearance.theme).toBe("dark");
    expect(at.shell.preferences.get().appearance.theme).toBe("dark");
    // A change the first mate makes itself reaches the window, and its windows hear the look.
    command.there.look = {
      ...command.there.look,
      appearance: { ...command.there.look.appearance, size: 150 },
    };
    command.run.core.events.emit("inf:shell:preferences", command.there.look);
    await expect.poll(() => at.shell.preferences.get().appearance.size).toBe(150);
    expect(at.pushes.findLast((push) => push.channel === "inf:shell:preferences")?.payload).toEqual(
      at.shell.preferences.get(),
    );
    // Keys changed here are installed here and kept by the first mate.
    const keys: SavedKeymap = {
      ...presetKeymap("emacs"),
      keys: { "settings.open": [{ key: "KeyE", meta: true }] },
    };
    at.shell.preferences.setKeymap(keys);
    expect(at.shell.preferences.keymap().saved).toEqual(keys);
    await expect.poll(() => command.there.keys).toEqual(keys);
  });

  it("reads everything once the command's door opens after the window", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { readyMs: 20 });
    await at.shell.start();
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    await command.open().settled();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        caughtUp: 1,
      });
    expect(await at.shell.dispatch("inf:repos:list", [])).toEqual({ run: "inf:repos:list" });
    // The late welcome still gives it the first mate's look and its dictation switch.
    await expect.poll(() => at.shell.preferences.get().appearance.theme).toBe("light");
    await expect.poll(() => at.shell.dictationEnabled()).toBe(true);
  });

  // INF-3645's review: a command's first mate opens no page itself, so a sign-in started
  // from this window opened no browser page here.
  it("opens each page the command's first mate sends, a sign-in's too", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    const page = "https://example.com/sign-in?state=1";
    command.run.core.events.emit("inf:app:open-page", { url: page });
    const google = "https://accounts.google.com/o/oauth2/auth?state=2";
    command.run.core.events.emit("inf:app:sign-in-page", {
      url: google,
      id: "return-1",
      port: 4242,
    });
    await expect.poll(() => at.openPage.mock.calls.map(([url]) => url)).toEqual([page, google]);
  });

  // INF-3645's review: the window's dictation switch followed only its own reads and sets.
  it("follows the first mate's dictation switch, wherever it is turned", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    expect(at.shell.dictationEnabled()).toBe(true);
    command.run.core.events.emit("inf:settings:dictation", { enabled: false, key: "AltRight" });
    await expect.poll(() => at.shell.dictationEnabled()).toBe(false);
  });

  // The captain's answer dock=split: "The first mate keeps Show in Dock and this window
  // applies it; this window changes Start at login itself".
  it("applies the first mate's Dock choice to this program, and answers Start at login from it", async () => {
    const command = commandRun();
    command.there.showInDock = false;
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    // It says it is open, then applies what the first mate keeps.
    expect(command.there.here).toBe(1);
    expect(at.program.dock).toEqual([false]);
    command.run.core.events.emit("inf:presence:dock", { showInDock: true });
    await expect.poll(() => at.program.dock).toEqual([false, true]);
    // The first mate asks this window for what only its program can read or change.
    command.run.core.events.emit("inf:own-window:ask", {
      id: "ask-1",
      ask: { kind: "start-at-login", set: true },
    });
    await expect
      .poll(() => command.there.answers)
      .toEqual([["ask-1", { kind: "start-at-login", enabled: true }]]);
    expect(at.program.startAtLogin).toBe(true);
    // The extras: a task browser page's file dialog is this window's too.
    command.run.core.events.emit("inf:own-window:ask", {
      id: "ask-2",
      ask: { kind: "choose-files", multiple: true },
    });
    await expect
      .poll(() => command.there.answers.at(-1))
      .toEqual(["ask-2", { kind: "choose-files", paths: ["/home/kai/report.pdf"] }]);
    // None of it is the window's own pages' to hear.
    expect(
      at.pushes.filter(
        (push) => push.channel === "inf:own-window:ask" || push.channel === "inf:presence:dock",
      ),
    ).toEqual([]);
  });

  // The captain's answer notifications=window: "This computer's window, while Infinitary is
  // running; the run never posts".
  it("posts the first mate's new card on this computer", async () => {
    const command = commandRun();
    const old = shown("old", { title: "Already there" });
    command.there.cards = [old];
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    const report = shown("report", { title: "Tests fixed", body: "<p>All green.</p>" });
    command.run.core.events.emit("inf:cards", [old, report]);
    await expect
      .poll(() => at.program.notified)
      .toEqual([{ title: "Tests fixed", body: "All green." }]);
  });

  // The extras, same piece: coming back to the window refreshes the plan's allowance.
  it("tells the first mate when the window comes to the front", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    at.shell.windowFocused();
    await expect.poll(() => command.there.focused).toBe(1);
  });

  // The captain's answer restart=wait-for-entry: "offer it at once when none will restart the
  // run". A kill leaves the earlier command's stop record, which names another command.
  it("says the command stopped and offers Start it here at once when no entry restarts it", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    at.command.records = stopped("quit", 0, { pid: 7, startedAt: "2026-10-30T08:00:00.000Z" });
    await command.stop();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "stopped", ending: "crashed" },
      });
    expect(at.pushes.at(-1)).toEqual({
      channel: "inf:devices:this-mac",
      payload: at.shell.thisMac(),
    });
    // It never starts a first mate by itself: only the person's Start it here does.
    expect(at.relaunch).not.toHaveBeenCalled();
    expect(at.shell.startHere()).toBe(true);
    expect(at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
  });

  it("never offers Start it here while the command it joined is alive", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    // Out of reach, with the command still running: no notice, nothing to start.
    await command.stop();
    await expect
      .poll(() => at.shell.dispatch("inf:repos:list", []).catch(() => "lost"))
      .toBe("lost");
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    expect(at.shell.startHere()).toBe(false);
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // "Wait for the start entry when one is in place, then offer it": exit 75 under a
  // restarting entry waits, and an entry that never comes back ends in the offer.
  it("waits for the start entry after an update, then offers Start it here when it never comes back", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { entry: "linux-unit", readyMs: 400 });
    await at.shell.start();
    at.command.records = stopped("updated", 75);
    await command.stop();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "waiting", ending: "updated" },
      });
    expect(at.shell.startHere()).toBe(false);
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "stopped", ending: "updated" },
      });
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // The third launch state: the window opened while the command is between two stops.
  it("opened between two commands, waits under the notice and joins the one the entry starts", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, {
      records: stopped("updated", 75),
      entry: "linux-unit",
      readyMs: 60_000,
    });
    // It draws at once, under its notice, and starts no first mate.
    await at.shell.start();
    expect(at.startCore).not.toHaveBeenCalled();
    expect(at.shell.thisMac()).toEqual({
      role: "home",
      left: null,
      byCommand: true,
      command: { state: "waiting", ending: "updated" },
    });
    at.command.records = { running: true, run: JOINED, lastStop: at.command.records.lastStop };
    await command.open().settled();
    // The command the entry started welcomes it: the notice goes and the window reads everything.
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({ role: "home", left: null, byCommand: true, caughtUp: 1 });
    await expect.poll(() => at.shell.preferences.get().appearance.theme).toBe("light");
  });

  // The captain's answer update=window-installs. Where the first mate can replace the program
  // itself, its updater is the only one, and this window follows the new program.
  it("asks the first mate's own updater, and starts again on the program it replaced", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.shell.start();
    expect(await at.shell.dispatch("inf:update:status", [])).toEqual({ run: "inf:update:status" });
    expect(await at.shell.dispatch("inf:update:install", [])).toEqual({
      run: "inf:update:install",
    });
    // The command ended for its update and came back on the new program.
    at.command.programReplaced = true;
    await command.stop();
    await command.open().settled();
    await expect.poll(() => at.relaunch.mock.calls, { timeout: 5_000 }).toEqual([[undefined]]);
  });

  // "This window installs it for the run, while the run holds the crew's saved work."
  it("installs an update itself where only a window can, with the first mate ending first", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { installsUpdates: true, starts: true });
    await at.shell.start();
    // This program's own notice, with the work the first mate still resumes.
    const status = await at.shell.dispatch("inf:update:status", []);
    expect(status).toMatchObject({
      currentVersion: "0.1.28-alpha.3",
      work: { state: "resuming", tasks: ["Fix the flaky test"] },
    });
    expect(command.asked("inf:update:status")).toEqual([]);
    // Before this window's update replaces the copy, the first mate ends with its work saved.
    const heldAtStop: unknown[] = [];
    at.starter.stop.mockImplementation(
      async () => void heldAtStop.push(command.there.holds.at(-1)),
    );
    await at.shell.updateReplacing();
    expect(command.there.holds.at(-1)).toBe("replaced");
    // Then its starter lets it go, not forgotten: its agent would start the old copy again, and
    // macOS's installer refuses to replace a copy that runs (INF-4113). The new window starts it.
    expect(heldAtStop).toEqual(["replaced"]);
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: false }]]);
  });

  // INF-1352's plan, piece 7, starter=login-agent: an earlier command's stop is not this one's.
  it("waits with no notice for the command it started, then joins it", async () => {
    const command = commandRun();
    const records = stopped("quit", 0, { pid: 7, startedAt: "2026-10-30T08:00:00.000Z" });
    const at = besideShell(command.doorDir, {
      records,
      startedAt: Date.now() + 1,
      readyMs: 60_000,
    });
    const starting = at.shell.start();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    at.command.records = { running: true, run: JOINED, lastStop: records.lastStop };
    await command.open().settled();
    await starting;
    await expect
      .poll(() => at.shell.thisMac())
      .toEqual({ role: "home", left: null, byCommand: true });
    expect(await at.shell.dispatch("inf:repos:list", [])).toEqual({ run: "inf:repos:list" });
    expect(at.startCore).not.toHaveBeenCalled();
    // With no starter (a boot entry), joining would leave a command that entry starts again.
    expect(await at.shell.join("not a link")).toEqual({ ok: false, refused: "other" });
  });

  it("stops the command on Stop, and starts it again through its starter on Start it here", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 50 });
    await at.shell.start();
    expect(await at.shell.join("not a link")).toEqual({ ok: false, refused: "not-a-link" });
    expect(at.shell.stopCommand()).toBe(true);
    expect(at.starter.stops).toBe(1);
    at.command.records = stopped("quit", 0);
    await command.stop();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        // The captain's answer on the review: the notice speaks of the program this window started.
        command: { state: "stopped", ending: "quit", byWindow: true },
      });
    // Under the notice there is nothing to stop.
    expect(at.shell.stopCommand()).toBe(false);
    at.starter.start.mockResolvedValueOnce(false);
    expect(at.shell.startHere()).toBe(true);
    expect(at.starter.start).toHaveBeenCalledTimes(1);
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
  });

  it("keeps the notice down while the command Start it here started comes up, then starts the window over", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 5_000 });
    await at.shell.start();
    at.shell.stopCommand();
    const records = stopped("quit", 0);
    if (records.lastStop) records.lastStop.stoppedAt = new Date(Date.now() - 1_000).toISOString();
    at.command.records = records;
    await command.stop();
    await expect
      .poll(
        () => {
          const here = at.shell.thisMac();
          return here.role === "home" ? here.command?.state : null;
        },
        { timeout: 5_000 },
      )
      .toBe("stopped");
    expect(at.shell.startHere()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    at.command.records = {
      running: true,
      run: { pid: 43, startedAt: new Date().toISOString() },
      lastStop: null,
    };
    await command.open().settled();
    await expect.poll(() => at.restartWindows.mock.calls.length, { timeout: 5_000 }).toBe(1);
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  it("runs the first mate here on Start it here once the command could not start", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { starts: true, records: stopped("start-failed", 1) });
    await at.shell.start();
    expect(at.shell.startHere()).toBe(true);
    expect(at.starter.start).not.toHaveBeenCalled();
    expect(at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
  });

  // "Start at login starts the command, not the window."
  it("answers Start at login from the command's starter, never this program's login item", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true });
    await at.shell.start();
    command.run.core.events.emit("inf:own-window:ask", {
      id: "ask-1",
      ask: { kind: "start-at-login", set: true },
    });
    await expect
      .poll(() => command.there.answers)
      .toEqual([["ask-1", { kind: "start-at-login", enabled: true }]]);
    expect(at.starter.login).toBe(true);
    expect(at.program.startAtLogin).toBe(false);
  });

  // Joining another computer from beside a command: that command's first mate is this
  // computer's own, so it stops, and nothing set to start it again remains.
  it("joins another computer with a pasted link, stopping the command and letting its starter go", async () => {
    const pro = await otherMac();
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true });
    await at.shell.start();
    await expect(at.shell.join(await pro.link())).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true }]]);
    expect(at.starter.stops).toBe(1);
    expect(at.startCore).not.toHaveBeenCalled();
  });
});
