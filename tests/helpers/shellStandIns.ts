import { join } from "node:path";
import { BrowserViews } from "@core/browser/browserViews";
import type { BrowserFrameSink } from "@core/browser/taskBrowsers";
import { type HomeConnection, startConnection } from "@core/connection/connection";
import { DevicePairing } from "@core/devices/pairing";
import type { CoreDispatch } from "@core/dispatcher";
import { CoreEventBus } from "@core/events";
import type { Core } from "@core/index";
import { buildUpdateTarget } from "@core/update/updateChannels";
import { createUpdateChecker, type UpdateChecker } from "@core/update/updateChecker";
import type { Card } from "@shared/cards";
import type { DeviceKind } from "@shared/devices";
import { HOME_CAPABILITIES } from "@shared/ipc";
import { DEFAULT_SAVED_KEYMAP, type SavedKeymap } from "@shared/keymap";
import type { PanelFiles } from "@shared/personal/panelFiles";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { WORK_SETUP_LIVE } from "@shared/workSetup";
import { afterEach, type Mock, vi } from "vitest";
import { claimedPort } from "./claimedPort";
import { answerInOwnWords } from "./firstMatesOwnWords";
import { scratchDir } from "./scratchDirs";

/**
 * The stand-ins the shell's tests share (src/main/shell.test.ts and its
 * siblings, docs/view.md and docs/run.md): a real other Mac - the real
 * connection and pairing over a stand-in core - this Mac's own core as far as
 * the shell reads it, and this Mac's own installed app.
 */

/** What each test started, stopped newest first when it ends. */
export const stops: (() => Promise<void> | void)[] = [];

/** Runs every stop a test left once it ends; each test file that uses these stand-ins calls it once. */
export function stopEachTest(): void {
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
  });
}

/** A card as the other Mac's stage shows it. */
export function shown(id: string, overrides: Partial<Card> = {}): Card {
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
export async function otherMac(
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
    paint(taskId: string, data: string) {
      for (const sink of pages.sinks.get(taskId) ?? [])
        sink({ data, width: 1280, height: 800 } as Parameters<BrowserFrameSink>[0]);
    },
    watchers: (taskId: string) => pages.sinks.get(taskId)?.size ?? 0,
  };
  const views = new BrowserViews(() => pages as never);
  /** What a sign-in's return from another computer brought here, as each was handed on. */
  const returns: unknown[] = [];
  /** What each Mac's window said of its work half, by the Mac the connection named. */
  const workSetups: { view: string | undefined; report: unknown }[] = [];
  const dispatch = (async (channel, args, actor, viewer) => {
    asked.push(channel);
    if (channel === "inf:devices:work-setup") {
      workSetups.push({
        view: actor?.kind === "captain" ? actor.view : undefined,
        report: (args as unknown[])[0],
      });
      return { ok: true };
    }
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
  const port = await claimedPort();
  const at = `127.0.0.1:${port}`;
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-shell-other-"), "devices"),
    onProblem: () => {},
    // It offers only its own loopback port, never this computer's network:
    // its welcome's addresses are what a view dials again once it quits, and a
    // network address that never answers held `closed` past a test's wait.
    interfaces: () => ({}),
    port,
    ...pairingOptions,
  });
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
    workSetups,
    events,
    pairing,
    at,
    /** Fix it on a Mac's row: that Mac's window, connected now, checks its work again. */
    fixWork: (deviceId: string) =>
      connection?.liveToView(deviceId, WORK_SETUP_LIVE, { deviceId }) ?? false,
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

export type OwnCore = {
  core: Core;
  dispatch: Mock<CoreDispatch>;
  dispose: Mock<() => Promise<void>>;
  attach: Mock<(_link: unknown) => Mock>;
  unreach: Mock;
  ssh: { start: Mock<() => Mock<() => Promise<void>>>; suspend: Mock; resume: Mock };
  stopSsh: Mock<() => Promise<void>>;
  follow: Mock<() => Mock>;
  unfollow: Mock;
  /** The goodbye each device hears before this Mac sleeps. */
  goodbye: Mock<() => Promise<void>>;
};

/** This Mac's own core, as far as the shell reads it. */
export function ownCore(): OwnCore {
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
  const goodbye = vi.fn(async () => {});
  const dispatch = vi.fn((async (channel) => ({ ownCore: channel })) as CoreDispatch);
  const core = {
    services: {
      preferences,
      workDevices: { attach, tellGoodbye: goodbye },
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
  return { core, dispatch, dispose, attach, unreach, ssh, stopSsh, follow, unfollow, goodbye };
}

/** The version the public tap offers this Mac's alpha installation. */
export const OFFERED = buildUpdateTarget({
  version: "0.1.30-alpha.5",
  assetName: "Firstmate-3000-0.1.30-alpha.5-universal.zip",
  sha256: "5".repeat(64),
  sourceCommit: "7".repeat(40),
});

export function ownUpdates() {
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
