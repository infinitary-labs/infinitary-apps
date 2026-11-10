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
import type { DeviceKind, ThisMac } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_MAJORS_BEHIND, PROTOCOL_VERSION } from "@shared/ipc";
import { DEFAULT_SAVED_KEYMAP, type SavedKeymap } from "@shared/keymap";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { claimedPort } from "../../tests/helpers/claimedPort";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { Shell, type ShellOptions } from "./shell";

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
  const stage = { cards: [] as Card[], notifications: true };
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
    if (channel === "inf:settings:notifications:get") return stage.notifications;
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
    const own = { version: 1 as const, keys: { "commands.search": [{ key: "p", meta: true }] } };
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
    expect(air.shell.framePanelDir("yours", "notes", "0".repeat(16))).toBeNull();
    await air.until(() => air.view().contact === "in-reach");
    expect(air.view()).toMatchObject({ role: "view", name: "MacBook Pro", address: "127.0.0.1" });
    expect(pro.pairing.list().map((device) => device.name)).toEqual(["MacBook Air"]);

    // What a view may ask goes to the other Mac.
    expect(await air.shell.dispatch("inf:app:healthcheck", [])).toMatchObject({
      platform: "other-os",
    });
    // What stays there is refused here, and never sent.
    await expect(air.shell.dispatch("inf:devices:list", [])).rejects.toThrow(
      "answered only on the computer where your first mate lives",
    );
    expect(pro.asked).not.toContain("inf:devices:list");
    // Its look starts from the other Mac's, then is its own.
    expect((await air.shell.dispatch("inf:shell:preferences", [])).appearance).toMatchObject({
      theme: "light",
      size: 125,
    });
    await air.shell.dispatch("inf:settings:appearance:set", [{ theme: "dark", size: 110 }]);
    expect(air.shell.preferences.get().appearance).toEqual({ theme: "dark", size: 110 });
    expect(pro.asked.filter((channel) => channel.startsWith("inf:settings:"))).toEqual([]);
    // Its keys are this Mac's own here too: the catalog's to start, kept in its own look.
    expect(air.shell.keymap.current().saved).toEqual(DEFAULT_SAVED_KEYMAP);
    const here = { version: 1 as const, keys: { "settings.open": [] } };
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
    expect(
      air.pushes.filter(
        (push) =>
          push.channel === "inf:shell:preferences" &&
          (push.payload as ShellPreferences).appearance.theme === "dark" &&
          (push.payload as ShellPreferences).panels.enabled === false,
      ),
    ).toHaveLength(1);

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
    // This Mac's own look stays here, and its devices stay there.
    await air.shell.dispatch("inf:settings:appearance:set", [{ theme: "dark", size: 110 }]);
    expect(air.shell.preferences.get().appearance).toEqual({ theme: "dark", size: 110 });
    await expect(
      air.shell.dispatch("inf:devices:invite", [{ kind: "view", at: "127.0.0.1:1" }]),
    ).rejects.toThrow("answered only on the computer where your first mate lives");
    expect(mini.asked.filter((channel) => /appearance|devices/.test(channel))).toEqual([]);

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

  // The captain's answer on the review of one rule for every view: a home too old to list the
  // change is told apart, so the window can say it needs an update instead of asking.
  it("knows when the first mate there is too old to answer what every view asks", async () => {
    const older = await otherMac({ changes: [] });
    const air = shell();
    await air.shell.start();
    await air.shell.join(await older.link());
    await air.until(() => air.view().contact === "in-reach");
    await air.until(() => air.shell.thisMac().role === "view");
    expect(air.shell.thisMac()).toMatchObject({ role: "view", needsUpdateThere: true });

    const current = await otherMac();
    const pro = shell();
    await pro.shell.start();
    await pro.shell.join(await current.link());
    await pro.until(() => pro.view().contact === "in-reach");
    expect(pro.shell.thisMac()).not.toHaveProperty("needsUpdateThere");
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
    pro.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.some((push) => push.channel === "inf:models:changed"));
    expect(air.pushes.map((push) => push.channel)).toContain("inf:auth:notice");
    expect(air.pushes.map((push) => push.channel)).not.toContain("inf:voice:progress");
    // A view's own look always has its panels off, so one with them on is the other Mac's.
    expect(
      air.pushes.filter(
        (push) =>
          push.channel === "inf:shell:preferences" &&
          (push.payload as ShellPreferences).panels.enabled,
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
