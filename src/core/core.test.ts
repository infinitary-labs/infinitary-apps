import { X509Certificate } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import { basename, join } from "node:path";
import { ACTION_NAMES, ACTIONS, type HandoverOffer } from "@shared/actions";
import type { Card } from "@shared/cards";
import { CONNECTION_CLOSE, CONNECTION_PORT } from "@shared/connection";
import { deviceJoinedLine, parsePairingLink } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { type FeedLine, feedLineFrom } from "@shared/feed";
import {
  HOME_CAPABILITIES,
  invokeContract,
  PROTOCOL_VERSION,
  VIEW_INVOKE_CHANNELS,
  WORK_INVOKE_CHANNELS,
} from "@shared/ipc";
import { SETUP_CARD_WORDS } from "@shared/projectSetup";
import type { QuotaSnapshotView } from "@shared/quota";
import { remoteLoginWords } from "@shared/remoteLogin";
import type { TaskBoard } from "@shared/tasks";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ANSWER_PROMPT_MARKER,
  APP_CATALOG_PROMPT_MARKER,
  FINISH_PROMPT_MARKER,
  MOCK_ANSWER_TEXT,
  MOCK_ANSWER_TITLE,
  MOCK_FM_CHAT_TEXT,
  type MockProviderServer,
  mockModelsJson,
  SPAWN_PROMPT_MARKER,
  STEER_PROMPT_MARKER,
  startMockProvider,
} from "../../tests/e2e/mockProvider";
import { captainCardChoice, holdsSegment, latestServedTurn } from "../../tests/e2e/providerRequest";
import { ADOPT_REPO_PROMPT_MARKER, projectSetup } from "../../tests/e2e/scenarios/projectSetup";
import {
  AMBIGUOUS_PROMPT_MARKER,
  workspaceInference,
} from "../../tests/e2e/scenarios/workspaceInference";
import { claimedPort } from "../../tests/helpers/claimedPort";
import { connectClient, type ReceivedPush } from "../../tests/helpers/connectionClient";
import { recordNewerMigration } from "../../tests/helpers/database";
import { projectFontBytes } from "../../tests/helpers/fontFixture";
import { SAMPLE_NOTES } from "../../tests/helpers/mcpStandIn";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { type ScriptedClient, startScriptedClient } from "../../tests/helpers/scriptedClient";
import { startConnection } from "./connection/connection";
import { claimLink } from "./devices/dial";
import { createKeyIdentity } from "./devices/identity";
import { SETTLE_MS } from "./dispatcher";
import { ForgeSignInStore } from "./forge/signIns";
import { absentKeychain, type HostCapabilities, type HostTaskBrowser } from "./host";
import { type Core, startCore } from "./index";
import { automationWords } from "./orchestrator/scheduler";
import { renderWake } from "./orchestrator/wakes";
import { appPathsFor, PERSONAL_WORKSPACE_NAME } from "./paths";
import { actionValue, createAppTools } from "./pi/appTools";
import { EMIT_CARD_TOOL } from "./pi/cardTool";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import type { PlacedSessions } from "./placed/placedSessions";
import { NO_PLACED_TASK } from "./placed/placedWork";
import { PluginRecords } from "./plugins/pluginRecords";
import { bindTool } from "./session/tools";
import type { AskRecord } from "./storage/askStore";
import { openDatabase } from "./storage/db";
import { SettingsStore } from "./storage/settingsStore";
import { seedTask } from "./tasks/seedTask";
import { TaskService } from "./tasks/taskService";
import { git } from "./workspace/git";
import { WorkspaceService } from "./workspace/workspaceService";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The payoff of the core extraction (daemon study D1): the whole application
 * core boots and answers its protocol in a plain Node process, with no
 * Electron anywhere - vitest is not an Electron runtime, so this test could
 * not exist before the split. What it drives is the real thing: real SQLite
 * under a throwaway userData root, the real stores, the real dispatcher, the
 * real event bus. Only the desktop shell is a stand-in, because that is
 * exactly the seam the split introduced.
 */

type OpenedUrl = string;

/** Waits for a core push; its window holds only on a graded run (`tests/helpers/waitWindow.ts`). */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error("timed out waiting for a core push");
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

function fakeHost(
  userDataDir: string,
  packaged = false,
): {
  host: HostCapabilities;
  opened: OpenedUrl[];
  notified: { title: string; body: string }[];
  loginItem: () => boolean;
} {
  cpSync(
    join(process.cwd(), "resources/runbooks"),
    join(userDataDir, "resources/self-source/resources/runbooks"),
    { recursive: true },
  );
  const opened: OpenedUrl[] = [];
  const notified: { title: string; body: string }[] = [];
  let startAtLogin = false;
  let voiceReady = false;
  return {
    opened,
    notified,
    loginItem: () => startAtLogin,
    host: {
      app: {
        version: "9.9.9",
        platform: "test-os",
        packaged,
        userDataDir,
        appDir: process.cwd(),
        resourcesDir: join(userDataDir, "resources"),
      },
      openExternal: async (url) => {
        opened.push(url);
      },
      notifications: {
        supported: () => true,
        focused: () => false,
        show: (notification) => notified.push(notification),
      },
      presence: {
        getStartAtLogin: () => startAtLogin,
        setStartAtLogin: (enabled) => {
          startAtLogin = enabled;
        },
        setShowInDock: () => {},
      },
      voice: {
        modelReady: async () => voiceReady,
        ensureModel: async (progress) => {
          progress({ file: "disposable-model", fileIndex: 0, fileCount: 1, fraction: 1 });
          voiceReady = true;
        },
      },
      keychain: absentKeychain,
    },
  };
}

/** Whether anything accepts a connection on a loopback port now. */
/**
 * Firstmate opened at its first launch on another app here: a link for a
 * Mac, used from this Mac itself, joins as a second app that only controls.
 */
const AT_FIRST_LAUNCH = {
  kind: "mac",
  window: true,
  user: { name: "captain", uid: process.getuid?.() ?? 0 },
} as const;

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("the core, driven with no Electron in the process", () => {
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-");
    // The same isolation e2e uses: no pi.dev catalog fetch, quota off files.
    process.env.PI_OFFLINE = "1";
    const quotaDir = scratchDir("infinitary-core-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({
        generatedAt: "2026-09-01T00:00:00.000Z",
        providers: [
          {
            provider: "codex",
            label: "Codex",
            status: "ok",
            stale: false,
            windows: [{ id: "weekly", label: "weekly", percentRemaining: 62 }],
          },
        ],
      }),
    );
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host);
  }, 60_000);

  afterAll(async () => {
    // Keep userData until the core has shut down and its background writes
    // have landed: removing it under a late write fails with ENOTEMPTY.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("answers the handshake from the host's own build identity", async () => {
    const health = await core.dispatch("inf:app:healthcheck", []);
    expect(health.ok).toBe(true);
    expect(health.version).toBe("9.9.9");
    expect(health.platform).toBe("test-os");
    expect(health.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("answers a work request only for a computer that runs work, and refuses it while no task runs on one", async () => {
    const report = [{ task: "t1", callId: "call-1", text: "Done." }];
    const device = { kind: "device" as const, deviceId: "mini" };
    // The window, Firstmate's own tools and a paired view ask as the captain or Firstmate.
    await expect(core.dispatch("inf:work:report", report)).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    await expect(core.dispatch("inf:work:report", report, device)).rejects.toThrow(NO_PLACED_TASK);
    await expect(core.dispatch("inf:work:report", [{ task: "t1" }], device)).rejects.toThrow(
      "Rejected inf:work:report: malformed request",
    );
    // A computer that runs work is answered nothing else.
    await expect(core.dispatch("inf:app:healthcheck", [], device)).rejects.toThrow(
      "not a request a computer that runs work asks",
    );
  });

  it("persists dictation through validated dispatch and publishes the saved choice", async () => {
    const pushes: unknown[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:settings:dictation") pushes.push(payload);
    });
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual({
      enabled: true,
      key: "AltRight",
    });
    const off = { enabled: false, key: "MetaRight" };
    await expect(
      core.dispatch("inf:settings:dictation:set", [off], {
        kind: "firstmate",
        wake: "captain",
        evidence: "not catalogued yet",
      }),
    ).rejects.toThrow("outside its action catalog");
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual({
      enabled: true,
      key: "AltRight",
    });
    expect(await core.dispatch("inf:settings:dictation:set", [off])).toEqual(off);
    expect(await core.dispatch("inf:settings:dictation:get", [])).toEqual(off);
    expect(pushes).toEqual([off]);
    await expect(
      core.dispatch("inf:settings:dictation:set", [{ enabled: true, key: "KeyA" }]),
    ).rejects.toThrow("malformed request");
    await core.dispatch("inf:settings:dictation:set", [{ enabled: true, key: "AltRight" }]);
    detach();
  });

  it("tells Firstmate every own-words action from the catalog", () => {
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((tool) => tool.name === "app_change");
    const ownWords = change?.description
      .match(/; ([^;]+) need their typed words/)?.[1]
      ?.split(", ");
    expect(ownWords).toEqual([
      "project-remove",
      "panel-remove",
      "integration-remove",
      "delete-outside",
      "forge-sign-out",
      "account-disconnect",
      "projects-folder",
    ]);
  });

  it("records overlapping Settings writes once per actual change, as one settled run", async () => {
    const initial = await core.dispatch("inf:settings:notifications:get", []);
    const operations = () => core.services.tasks.list().filter((task) => task.kind === "operation");
    const before = operations().length;
    await Promise.all([
      core.dispatch("inf:settings:notifications:set", [!initial]),
      core.dispatch("inf:settings:notifications:set", [!initial]),
    ]);
    expect(await core.dispatch("inf:settings:notifications:get", [])).toBe(!initial);
    expect(operations()).toHaveLength(before + 1);
    // Back where the run started: its line and its change are withdrawn.
    await core.dispatch("inf:settings:notifications:set", [initial]);
    expect(operations()).toHaveLength(before);
    const appearance = await core.dispatch("inf:settings:appearance:get", []);
    const changes: string[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event" && (payload as FmEvent).type === "personalized")
        changes.push((payload as { text: string }).text);
    });
    await Promise.all([
      core.dispatch("inf:settings:appearance:set", [{ ...appearance, washStrength: 25 }]),
      core.dispatch("inf:settings:appearance:set", [{ ...appearance, washStrength: 35 }]),
    ]);
    detach();
    // One run: its line is rewritten in place, from where it started to where it settled.
    const wash = ACTIONS["window-wash"];
    const start = actionValue("window-wash", appearance);
    const settledAt = (strength: number) =>
      wash.settled?.(start, { strength }) ?? wash.done({ strength });
    expect(changes).toEqual([settledAt(25), settledAt(35)]);
    expect((await core.dispatch("inf:settings:appearance:get", [])).washStrength).toBe(35);
    const line = (strength: number) =>
      feedLineFrom({ type: "personalized", actor: "captain", text: settledAt(strength) })?.text;
    const feed = (await core.dispatch("inf:feed:recent", [])).map((entry) => entry.text);
    expect(feed.at(-1)).toBe(line(35));
    expect(feed).not.toContain(line(25));
    expect(operations().map((task) => task.title)).toEqual([
      ...operations()
        .slice(0, before)
        .map((task) => task.title),
      settledAt(35),
    ]);
    await core.dispatch("inf:settings:appearance:set", [appearance]);
    expect(operations()).toHaveLength(before);
    expect((await core.dispatch("inf:feed:recent", [])).map((entry) => entry.text)).not.toContain(
      line(35),
    );
  });

  it("trails each whole-window size change once, whether the captain or Firstmate makes it", async () => {
    const appearance = await core.dispatch("inf:settings:appearance:get", []);
    const changes: string[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      const event = payload as FmEvent;
      if (channel === "inf:event" && event.type === "personalized")
        changes.push(`${event.actor} · ${event.text}`);
    });
    const operations = () =>
      core.services.tasks.list().filter((task) => task.kind === "operation").length;
    const before = operations();
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((tool) => tool.name === "app_change");
    const state = tools.find((tool) => tool.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");
    const other = appearance.theme === "dark" ? "light" : "dark";
    try {
      // The picker, the size keys and the View menu all write the whole look as the captain.
      await core.dispatch("inf:settings:appearance:set", [{ ...appearance, size: 110 }]);
      // A theme change keeps the size, and is no size change.
      await core.dispatch("inf:settings:appearance:set", [
        { ...appearance, size: 110, theme: other },
      ]);
      const asked = await change.run({
        action: "window-size",
        value: { size: 150 },
        evidence: "make everything bigger",
      });
      expect(JSON.parse(asked.text).current).toEqual({ size: 150 });
      expect(await core.dispatch("inf:settings:appearance:get", [])).toEqual({
        ...appearance,
        theme: other,
        size: 150,
      });
      // The same size again changes nothing; a size that is not a choice is refused in words.
      await change.run({ action: "window-size", value: { size: 150 }, evidence: "same again" });
      expect(
        (await change.run({ action: "window-size", value: { size: 120 }, evidence: "120" })).text,
      ).toMatch(/size/);
      // Named window-size, Firstmate changes nothing else.
      await expect(
        core.dispatch("inf:settings:appearance:set", [{ ...appearance, size: 125 }], {
          kind: "firstmate",
          wake: "captain",
          action: "window-size",
          evidence: "bigger",
        }),
      ).rejects.toThrow("named appearance");
      // The captain's step names where the size started; Firstmate's names where it went.
      expect(changes).toEqual([
        `captain · ${ACTIONS["window-size"].settled?.(actionValue("window-size", appearance), { size: 110 })}`,
        `captain · switched to the ${other} theme`,
        "firstmate · window size 150%",
      ]);
      expect(operations()).toBe(before + 3);
      const lines = JSON.parse((await state.run({ area: "appearance" })).text);
      expect(lines.find((line: { action: string }) => line.action === "window-size")).toMatchObject(
        {
          tier: "asked",
          captainAllowed: true,
          firstmateAllowed: true,
          allowedNow: true,
          current: { size: 150 },
        },
      );
    } finally {
      detach();
      await core.dispatch("inf:settings:appearance:set", [appearance]);
    }
  });

  it("settles a run of the captain's steps on one setting into one line and one operation", async () => {
    const appearance = await core.dispatch("inf:settings:appearance:get", []);
    const wash = ACTIONS["window-wash"];
    const words = (from: number, to: number) =>
      wash.settled?.({ strength: from }, { strength: to }) ?? "";
    const captain = (text: string) =>
      feedLineFrom({ type: "personalized", actor: "captain", text })?.text;
    const operations = () =>
      core.services.tasks
        .list()
        .filter((task) => task.kind === "operation")
        .map((task) => task.title);
    const feed = async () => (await core.dispatch("inf:feed:recent", [])).map((line) => line.text);
    const setWash = (washStrength: number, actor?: Parameters<typeof core.dispatch>[2]) =>
      core.dispatch("inf:settings:appearance:set", [{ ...appearance, washStrength }], actor);
    const layout = await core.dispatch("inf:settings:layout:get", []);
    // Any other line ends an open run, so this test's first step starts its own.
    core.services.broadcastEvent({ type: "firstmate_note", text: "Firstmate · a fresh start" });
    const start = (actionValue("window-wash", appearance) as { strength: number }).strength;
    const before = operations();
    try {
      await setWash(10);
      await setWash(20);
      await setWash(30);
      expect((await feed()).slice(-1)).toEqual([captain(words(start, 30))]);
      expect(operations()).toEqual([...before, words(start, 30)]);
      // Any other line in Activity ends the run: the next step writes a new line.
      core.services.broadcastEvent({ type: "firstmate_note", text: "Firstmate · a line between" });
      await setWash(40);
      expect((await feed()).slice(-3)).toEqual([
        captain(words(start, 30)),
        "Firstmate · a line between",
        captain(words(30, 40)),
      ]);
      // Firstmate's change is its own line and change, and ends the captain's run.
      await setWash(45, {
        kind: "firstmate",
        wake: "captain",
        action: "window-wash",
        evidence: "a little more",
      });
      await setWash(50);
      expect((await feed()).slice(-3)).toEqual([
        captain(words(30, 40)),
        feedLineFrom({
          type: "personalized",
          actor: "firstmate",
          text: wash.done({ strength: 45 }),
        })?.text,
        captain(words(45, 50)),
      ]);
      expect(operations()).toEqual([
        ...before,
        words(start, 30),
        words(30, 40),
        wash.done({ strength: 45 }),
        words(45, 50),
      ]);
      // A panel folded and opened again leaves no line and no change.
      const fold = (collapsed: boolean) =>
        core.dispatch("inf:settings:layout:set", [
          { ...layout, collapsedPanels: { ...layout.collapsedPanels, activity: collapsed } },
        ]);
      const lines = (await feed()).length;
      await fold(!layout.collapsedPanels.activity);
      expect(await feed()).toHaveLength(lines + 1);
      await fold(!!layout.collapsedPanels.activity);
      expect(await feed()).toHaveLength(lines);
      expect(operations()).toHaveLength(before.length + 4);
    } finally {
      await setWash(appearance.washStrength ?? 0);
    }
  });

  it("keeps a copy's count of what it sent as one line, rewritten in place while it is Activity's newest", async () => {
    const feed = async () => (await core.dispatch("inf:feed:recent", [])).map((line) => line.text);
    const count = (sent: number): FmEvent => ({
      type: "device_setup",
      address: "sam@mini.local",
      doing: "add",
      stage: "setting-up",
      name: "Mac mini",
      text: remoteLoginWords.sending("Mac mini", sent),
      tone: "info",
      copy: { state: "sending", sent },
      run: { id: "copy-to-the-mini" },
    });
    core.services.broadcastEvent({ type: "firstmate_note", text: "Firstmate · a fresh start" });
    core.services.broadcastEvent(count(65_536));
    core.services.broadcastEvent(count(4_000_000));
    expect((await feed()).slice(-2)).toEqual([
      "Firstmate · a fresh start",
      remoteLoginWords.sending("Mac mini", 4_000_000),
    ]);
    // Any other line ends the run: the next count writes a line of its own.
    core.services.broadcastEvent({ type: "firstmate_note", text: "Firstmate · a line between" });
    core.services.broadcastEvent(count(8_000_000));
    expect((await feed()).slice(-3)).toEqual([
      remoteLoginWords.sending("Mac mini", 4_000_000),
      "Firstmate · a line between",
      remoteLoginWords.sending("Mac mini", 8_000_000),
    ]);
  });

  it("starts a new run once the captain's setting has rested for the wait", async () => {
    const appearance = await core.dispatch("inf:settings:appearance:get", []);
    const size = ACTIONS["window-size"];
    const setSize = (to: number) =>
      core.dispatch("inf:settings:appearance:set", [
        { ...appearance, size: to as (typeof appearance)["size"] },
      ]);
    const operations = () => core.services.tasks.list().filter((task) => task.kind === "operation");
    const known = new Set(operations().map((task) => task.id));
    const added = () =>
      operations()
        .filter((task) => !known.has(task.id))
        .sort((x, y) => x.createdAt - y.createdAt)
        .map((task) => task.title);
    const start = actionValue("window-size", appearance) as { size: number };
    const first = start.size === 125 ? 150 : 125;
    // Any other line ends an open run, so this test's first step starts its own.
    core.services.broadcastEvent({ type: "firstmate_note", text: "Firstmate · a fresh start" });
    try {
      // The first step lands a moment longer ago than the wait.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - SETTLE_MS - 1_000);
      await setSize(first);
      vi.useRealTimers();
      await setSize(110);
      expect(added()).toEqual([
        size.settled?.(start, { size: first }),
        size.settled?.({ size: first }, { size: 110 }),
      ]);
    } finally {
      vi.useRealTimers();
      await setSize(start.size);
    }
  });

  // INF-1110: adding a server names that server in its operation and Activity,
  // through Settings or app_change; additions are separate acts, not a slider run.
  // It starts three servers as programs, so its budget is five times its fastest
  // run on the Linux checks, 3.567 s (docs/test-cohorts.md, "Budgets"; INF-1465).
  it("names each added MCP server in its own attributed operation and Activity line", async () => {
    const notes = join(scratchDir("catalog-mcp-notes-"), "notes.json");
    writeFileSync(notes, JSON.stringify({ notes: SAMPLE_NOTES }));
    const runs = `'${process.execPath}' '${join(process.cwd(), "tests/helpers/mcpStandIn.ts")}' stdio modern '${notes}'`;
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    // Hold the settle clock: even back-to-back additions must keep separate records.
    const clock = vi.spyOn(core.services.ticker, "now").mockReturnValue(Date.now());
    const before = new Set(core.services.tasks.list().map((task) => task.id));
    const operations = () =>
      core.services.tasks
        .list()
        .filter((task) => task.kind === "operation" && !before.has(task.id));
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((tool) => tool.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const names = ["Notes", "Recipes", "Reading list"];
    // A limit that ends this test leaves its additions running, so the next
    // test starts only once they and this cleanup have ended (INF-1465).
    const adding = (async () => {
      try {
        // The same channel Settings calls, including its schema's name trimming.
        for (const name of names.slice(0, 2))
          await core.dispatch("inf:integrations:add", [{ name: `  ${name}  `, runs }]);
        const answer = await change.run({
          action: "integration-add-mcp",
          value: { name: names[2], runs },
          evidence: "Add my Reading list server.",
        });
        expect(JSON.parse(answer.text).action).toBe("integration-add-mcp");
        const titles = names.map((name) => ACTIONS["integration-add-mcp"].done({ name }));
        expect(
          operations()
            .map((task) => task.title)
            .sort(),
        ).toEqual([...titles].sort());
        for (const task of operations()) {
          expect(task.status).toBe("done");
          expect(task.outcome).toBe(task.title);
        }
        const added = events.filter((event) => event.type === "personalized");
        expect(added).toEqual(
          titles.map((text, index) => ({
            type: "personalized",
            actor: index === 2 ? "firstmate" : "captain",
            text,
          })),
        );
        const lines = await core.dispatch("inf:feed:recent", []);
        for (const event of added)
          expect(lines.filter((line) => line.text === feedLineFrom(event)?.text)).toHaveLength(1);

        // A refused duplicate and a program that cannot start write no success.
        const kept = operations().map((task) => task.id);
        await expect(
          core.dispatch("inf:integrations:add", [{ name: names[0], runs }]),
        ).rejects.toThrow();
        await expect(
          core.dispatch("inf:integrations:add", [
            { name: "Unavailable notes", runs: `'${join(scratchDir("missing-mcp-"), "missing")}'` },
          ]),
        ).rejects.toThrow();
        expect(operations().map((task) => task.id)).toEqual(kept);
        expect(events.filter((event) => event.type === "personalized")).toEqual(added);
      } finally {
        off();
        clock.mockRestore();
        for (const row of core.services.integrations.view().integrations)
          if (names.includes(row.name)) await core.services.integrations.remove(row.id);
      }
    })();
    onTestFinished(() => adding.catch(() => undefined));
    await adding;
  }, 20_000);

  // SCR-523 (INF-1137 friction 10): the captain connected Google and the
  // operation read "undefined sign-in started"; a click names what it signed in to.
  it("names the integration a captain's sign-in click started", async () => {
    const before = new Set(core.services.tasks.list().map((task) => task.id));
    const titles = () =>
      core.services.tasks
        .list()
        .filter((task) => task.kind === "operation" && !before.has(task.id))
        .map((task) => task.title)
        .sort();
    const google = vi
      .spyOn(core.services.integrations, "signIn")
      .mockResolvedValue({ id: "google-1", view: core.services.integrations.view() });
    const server = vi
      .spyOn(core.services.forges, "signInWithKey")
      .mockResolvedValue({ ok: false, problem: "address", host: null });
    try {
      await core.dispatch("inf:integrations:sign-in", ["google", { noticeAccepted: true }]);
      await core.dispatch("inf:forges:sign-in-key", [
        { kind: "github", address: "https://code.example.com/team/app", key: "disposable-key" },
      ]);
      expect(titles()).toEqual(
        ["Google sign-in started", "GitHub Enterprise sign-in started for code.example.com"].sort(),
      );
    } finally {
      google.mockRestore();
      server.mockRestore();
    }
  });

  it("shares catalog changes, refusals and one trail per actor through the real core", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    let wake: "captain" | "scheduled" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((tool) => tool.name === "app_change");
    const state = tools.find((tool) => tool.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");
    const initial = await core.dispatch("inf:settings:notifications:get", []);
    const count = () =>
      core.services.tasks.list().filter((task) => task.kind === "operation").length;
    const before = count();
    await core.dispatch("inf:settings:notifications:set", [!initial]);
    expect(count()).toBe(before + 1);
    expect(events.filter((e) => e.type === "personalized")).toHaveLength(1);
    const result = await change.run({
      action: "notifications",
      value: { enabled: initial },
      evidence: "turn notifications back",
    });
    expect(JSON.parse(result.text).current.enabled).toBe(initial);
    expect(count()).toBe(before + 2);
    expect(events.filter((e) => e.type === "personalized").map((e) => e.actor)).toEqual([
      "captain",
      "firstmate",
    ]);
    const recent = await core.dispatch("inf:feed:recent", []);
    expect(
      recent.some((line) => line.text === `Captain · notifications ${initial ? "off" : "on"}`),
    ).toBe(true);
    expect(
      recent.some((line) => line.text === `First mate · notifications ${initial ? "on" : "off"}`),
    ).toBe(true);
    await change.run({
      action: "notifications",
      value: { enabled: initial },
      evidence: "same value",
    });
    expect(count()).toBe(before + 2);
    // INF-751: his choice, relayed in a crewmate's report, applies on that
    // report's wake and leaves the same trail.
    wake = "other";
    const relayed = await change.run({
      action: "notifications",
      value: { enabled: !initial },
      evidence: 'The captain chose "Turn notifications off" on SCR-1\'s card.',
    });
    expect(JSON.parse(relayed.text).current.enabled).toBe(!initial);
    expect(await core.dispatch("inf:settings:notifications:get", [])).toBe(!initial);
    expect(count()).toBe(before + 3);
    await core.dispatch("inf:settings:notifications:set", [initial]);
    // His typed words in a schedule he set apply an own-words line.
    wake = "scheduled";
    const scheduledFolder = scratchDir("catalog-scheduled-");
    await change.run({
      action: "projects-folder",
      value: { path: scheduledFolder },
      evidence: "Each Monday, keep new projects in the scratch folder.",
    });
    expect((await core.dispatch("inf:repos:folder", [])).path).toBe(scheduledFolder);
    wake = "captain";
    const missing = join(scratchDir("catalog-folder-"), "missing");
    await expect(core.dispatch("inf:repos:folder:set", [missing])).rejects.toThrow(
      `No folder exists at ${missing}.`,
    );
    expect(
      (
        await change.run({
          action: "projects-folder",
          value: { path: missing },
          evidence: "use this folder",
        })
      ).text,
    ).toBe(`No folder exists at ${missing}.`);
    const folder = scratchDir("catalog-projects-");
    await change.run({
      action: "projects-folder",
      value: { path: folder },
      evidence: "keep new projects here",
    });
    expect((await core.dispatch("inf:repos:folder", [])).path).toBe(folder);
    await change.run({
      action: "projects-folder",
      value: { path: null },
      evidence: "restore default",
    });
    const appearance = await core.dispatch("inf:settings:appearance:get", []);
    await change.run({ action: "window-wash", value: { strength: 42 }, evidence: "wash 42" });
    expect(await core.dispatch("inf:settings:appearance:get", [])).toEqual({
      ...appearance,
      washStrength: 42,
    });
    await change.run({
      action: "crew-model-names",
      value: { visible: false },
      evidence: "hide names",
    });
    expect((await core.dispatch("inf:settings:appearance:get", [])).showCrewModelNames).toBe(false);
    await change.run({
      action: "panel-collapse",
      value: { surface: "activity", collapsed: true },
      evidence: "collapse activity",
    });
    expect((await core.dispatch("inf:settings:layout:get", [])).collapsedPanels.activity).toBe(
      true,
    );
    await expect(
      core.dispatch("inf:settings:sharing:set", ["diagnostics", false], {
        kind: "firstmate",
        wake: "captain",
        evidence: "asked",
      }),
    ).rejects.toThrow(/outside/);
    await expect(
      core.dispatch(
        "inf:settings:appearance:set",
        [{ ...appearance, theme: appearance.theme === "dark" ? "light" : "dark" }],
        { kind: "firstmate", wake: "captain", action: "window-wash", evidence: "wash" },
      ),
    ).rejects.toThrow(/named appearance/);
    expect(
      (
        await change.run({
          action: "notifications",
          value: { enabled: false, extra: true },
          evidence: "asked",
        })
      ).text,
    ).toMatch(/extra/);
    const lines = JSON.parse((await state.run({})).text);
    expect(lines.map((line: { action: string }) => line.action)).toEqual(ACTION_NAMES);
    expect(
      lines.every(
        (line: {
          action: keyof typeof ACTIONS;
          captainAllowed: boolean;
          firstmateAllowed: boolean;
        }) =>
          line.captainAllowed &&
          line.firstmateAllowed ===
            (["asked", "own-words", "judgment"].includes(ACTIONS[line.action].tier) ||
              ACTIONS[line.action].proposes === true),
      ),
    ).toBe(true);
    // INF-638, the captain: "why not just give first mate a tool to freely
    // read and write standing directions, and then rely on the agent's
    // judgment". A direction is a catalog line like any setting, so a turn a
    // crewmate's report began keeps one, with one trail and its reason kept.
    wake = "other";
    const rule = "A fix for a broken main merges on its own once all of its checks pass.";
    const kept = await change.run({
      action: "direction",
      value: { op: "add", id: "fix-merge", text: rule },
      evidence: "The captain chose Save the direction on the crewmate's card.",
    });
    expect(JSON.parse(kept.text).current.directions).toContainEqual(
      expect.objectContaining({ id: "d:fix-merge", text: rule, revision: 1 }),
    );
    expect(
      (await core.dispatch("inf:feed:recent", [])).filter(
        (line) => line.text === `First mate · saved the standing direction "${rule}"`,
      ),
    ).toHaveLength(1);
    expect(await core.dispatch("inf:knowledge:direction", [{ id: "fix-merge" }])).toMatchObject({
      direction: {
        origin: "captain-turn",
        history: [{ evidence: "The captain chose Save the direction on the crewmate's card." }],
      },
    });
    const listed = JSON.parse((await state.run({ area: "general" })).text).find(
      (line: { action: string }) => line.action === "direction",
    );
    expect(listed).toMatchObject({ tier: "judgment", firstmateAllowed: true, allowedNow: true });
    expect(listed.current.directions).toContainEqual(
      expect.objectContaining({ id: "d:fix-merge" }),
    );
    await change.run({
      action: "direction",
      value: { op: "retire", id: "d:fix-merge", expectedRevision: 1 },
      evidence: "The captain retired it.",
    });
    const after = JSON.parse((await state.run({ area: "general" })).text).find(
      (line: { action: string }) => line.action === "direction",
    );
    expect(after.current.directions).not.toContainEqual(
      expect.objectContaining({ id: "d:fix-merge" }),
    );
    wake = "captain";
    const personalBefore = await core.dispatch("inf:settings:personal-resources:get", []);
    const personal = await change.run({
      action: "personal-resources",
      value: { enabled: !personalBefore },
      evidence: "use my instructions and skills",
    });
    expect(JSON.parse(personal.text).current.enabled).toBe(!personalBefore);
    expect(await core.dispatch("inf:settings:personal-resources:get", [])).toBe(!personalBefore);
    // INF-751: on a report's wake, the choice it relays applies.
    wake = "other";
    const relayedPersonal = await change.run({
      action: "personal-resources",
      value: { enabled: personalBefore },
      evidence: "The captain chose to stop using his instructions and skills on SCR-1's card.",
    });
    expect(JSON.parse(relayedPersonal.text).current.enabled).toBe(personalBefore);
    expect(await core.dispatch("inf:settings:personal-resources:get", [])).toBe(personalBefore);
    await core.dispatch("inf:settings:personal-resources:set", [personalBefore]);
    await core.dispatch("inf:settings:appearance:set", [appearance]);
    await core.dispatch("inf:settings:layout:set", [
      { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
    ]);
    detach();
  });

  // INF-752: everything Settings → Automation does to a schedule, the first
  // mate does through the same catalog path, and each change leaves one
  // trail - an operation and one feed line naming who changed it - in place
  // of the Scheduler's own unattributed line.
  it("runs Automation's changes and the first mate's through one path, with one trail each", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "other" }),
    });
    const change = tools.find((tool) => tool.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const scheduler = core.services.scheduler;
    const audit = scheduler.create(
      { kind: "daily", hour: 9, minute: 0, timeZone: "America/Los_Angeles" },
      "Audit the dependencies and report anything out of date.",
      true,
      "Weekly dependency audit",
    );
    const digest = scheduler.create(
      { kind: "daily", hour: 8, minute: 0, timeZone: "America/Los_Angeles" },
      "Summarize what the crew finished overnight.",
      false,
      "Morning digest",
    );
    expect(digest.state).toBe("draft");
    const operations = () => core.services.tasks.list().filter((task) => task.kind === "operation");
    const trailOf = async (actor: "captain" | "firstmate", text: string) => {
      const line = feedLineFrom({ type: "personalized", text, actor });
      return (await core.dispatch("inf:feed:recent", [])).filter(
        (entry) => entry.text === line?.text,
      );
    };
    const notes = () => events.filter((event) => event.type === "firstmate_note");
    const notesBefore = notes().length;

    // The captain's Pause in Settings: one operation and one line, the captain's.
    const before = operations().length;
    await core.dispatch("inf:automation:state", [audit.id, "pause"]);
    expect(operations()).toHaveLength(before + 1);
    expect(operations().at(-1)).toMatchObject({ title: automationWords.paused(audit) });
    expect(await trailOf("captain", automationWords.paused(audit))).toHaveLength(1);

    // A turn a report began: pausing and resuming are the first mate's judgment.
    const resumed = JSON.parse(
      (
        await change.run({
          action: "automation-state",
          value: { id: audit.id, change: "resume" },
          evidence: "The crewmate's report says the audit is needed again.",
        })
      ).text,
    );
    expect(resumed.current.rules).toContainEqual({
      id: audit.id,
      label: "Weekly dependency audit",
      state: "enabled",
    });
    expect(await trailOf("firstmate", automationWords.resumed(audit))).toHaveLength(1);
    expect(operations()).toHaveLength(before + 2);

    // Turning a draft on stays the captain's to direct: it takes his words,
    // whatever began the turn, and a draft never resumes.
    expect(
      (await change.run({ action: "automation-edit", value: { id: digest.id, enable: true } }))
        .text,
    ).toMatch(/captain's words/);
    expect(
      (
        await change.run({
          action: "automation-state",
          value: { id: digest.id, change: "resume" },
          evidence: "resume it",
        })
      ).text,
    ).toMatch(/automation-edit/);
    expect(scheduler.rules().find((rule) => rule.id === digest.id)?.state).toBe("draft");
    const asked = (value: Record<string, unknown>) =>
      change.run({ action: "automation-edit", value, evidence: "Turn the morning digest on." });
    const edited = JSON.parse((await asked({ id: digest.id, enable: true })).text);
    expect(
      edited.current.rules.find((rule: { id: string }) => rule.id === digest.id),
    ).toMatchObject({
      state: "enabled",
      prompt: digest.prompt,
      name: "Morning digest",
      captainRequested: true,
    });
    expect(
      await trailOf("firstmate", automationWords.saved(true, digest.spec, digest.prompt)),
    ).toHaveLength(1);
    await asked({ id: digest.id, name: "Overnight digest" });
    expect(scheduler.rules().find((rule) => rule.id === digest.id)).toMatchObject({
      name: "Overnight digest",
      prompt: digest.prompt,
      state: "enabled",
    });
    expect((await asked({ id: "missing" })).text).toMatch(/No automation missing/);

    // Pause all, and a pause that changes nothing leaves no trail.
    const running = scheduler.rules().filter((rule) => rule.state === "enabled").length;
    await change.run({ action: "automation-pause-all", value: {}, evidence: "Quiet week." });
    expect(scheduler.rules().every((rule) => rule.state !== "enabled")).toBe(true);
    expect(await trailOf("firstmate", automationWords.pausedAll(running))).toHaveLength(1);
    const quiet = operations().length;
    await change.run({
      action: "automation-state",
      value: { id: audit.id, change: "pause" },
      evidence: "Already paused.",
    });
    expect(operations()).toHaveLength(quiet);

    // Delete: the first mate's and the captain's.
    await change.run({
      action: "automation-delete",
      value: { id: audit.id },
      evidence: "The audit moved to CI.",
    });
    expect(await trailOf("firstmate", automationWords.cancelled(audit.prompt))).toHaveLength(1);
    await core.dispatch("inf:automation:delete", [digest.id]);
    expect(await trailOf("captain", automationWords.cancelled(digest.prompt))).toHaveLength(1);
    expect(scheduler.rules().filter((rule) => [audit.id, digest.id].includes(rule.id))).toEqual([]);
    // Every change above said its words once, as its trail; the Scheduler
    // added no line of its own beside them.
    expect(notes()).toHaveLength(notesBefore);
    detach();
  });

  it("runs presence through the core and refuses captain-owned actions without side effects", async () => {
    const before = await core.dispatch("inf:presence:get", []);
    let wake: "captain" | "scheduled" | "other" = "captain";
    const handed: string[] = [];
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
      handover: (target, offer) => {
        handed.push(`${offer.cardId}:${target}`);
        return "button offered";
      },
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing app tools");
    const ask = (action: string, value: unknown) =>
      change.run({ action, value, evidence: "captain asked" });
    const operationCount = () =>
      core.services.tasks.list().filter((t) => t.kind === "operation").length;
    const count = operationCount();
    expect(
      JSON.parse((await ask("start-at-login", { enabled: !before.startAtLogin })).text).current
        .enabled,
    ).toBe(!before.startAtLogin);
    expect(shell.loginItem()).toBe(!before.startAtLogin);
    expect((await core.dispatch("inf:presence:get", [])).showInDock).toBe(before.showInDock);
    expect(operationCount()).toBe(count + 1);
    wake = "scheduled";
    await ask("show-in-dock", { enabled: !before.showInDock });
    expect(await core.dispatch("inf:presence:get", [])).toEqual({
      startAtLogin: !before.startAtLogin,
      showInDock: !before.showInDock,
    });
    expect(operationCount()).toBe(count + 2);
    await expect(
      core.dispatch("inf:presence:set", [before], {
        kind: "firstmate",
        wake: "captain",
        action: "start-at-login",
        evidence: "asked",
      }),
    ).rejects.toThrow("Only the named presence");
    // INF-751: on a report's wake, the choice it relays applies.
    wake = "other";
    expect(
      JSON.parse((await ask("start-at-login", { enabled: before.startAtLogin })).text).current
        .enabled,
    ).toBe(before.startAtLogin);
    expect(shell.loginItem()).toBe(before.startAtLogin);
    expect(operationCount()).toBe(count + 3);
    wake = "captain";
    const sharing = await core.dispatch("inf:settings:sharing:get", []);
    for (const action of [
      "diagnostics",
      "contribution",
      "sharing-ask",
      "purge",
      "panels-switch",
      "recovery",
      "plugin-consent",
      "card-close",
      "ask-first-merge",
    ])
      expect((await ask(action, {})).text).toContain("stays with the captain");
    expect(await core.dispatch("inf:settings:sharing:get", [])).toEqual(sharing);
    expect(operationCount()).toBe(count + 3);
    for (const action of ["account-sign-in", "custom-connection", "decision-key", "device-address"])
      expect((await ask(action, {})).text).toBe("button offered");
    expect((await ask("integration-add", { kind: "gitlab" })).text).toBe("button offered");
    expect(handed).toHaveLength(5);
    expect(JSON.parse((await ask("voice-model", {})).text).current.ready).toBe(true);
    const forgeStore = new ForgeSignInStore(core.paths.forgesDir);
    const signIn = () =>
      forgeStore.write("github.com", {
        token: "disposable-forge-sign-in",
        scopes: [],
        login: "fixture",
        createdAt: 1,
      });
    signIn();
    // INF-751: his typed words in a schedule he set sign out on its wake.
    wake = "scheduled";
    await ask("forge-sign-out", { host: "github.com" });
    expect(forgeStore.read("github.com")).toBeUndefined();
    signIn();
    wake = "captain";
    await ask("forge-sign-out", { host: "github.com" });
    expect(forgeStore.read("github.com")).toBeUndefined();
    // Settings signs out of any host the app is signed in to, and so may the
    // first mate on the captain's typed words (INF-638's audit).
    forgeStore.write("gitlab.example.com", {
      token: "disposable-forge-sign-in",
      scopes: [],
      login: "fixture",
      createdAt: 1,
    });
    expect((await ask("forge-sign-out", { host: "git.example.org" })).text).toContain(
      "No sign-in to git.example.org",
    );
    await ask("forge-sign-out", { host: "gitlab.example.com" });
    expect(forgeStore.read("gitlab.example.com")).toBeUndefined();
    expect(
      (await core.dispatch("inf:feed:recent", [])).some(
        (line) => line.text === "First mate · gitlab.example.com signed out",
      ),
    ).toBe(true);
    const lines = JSON.parse((await state.run({ area: "general" })).text);
    expect(lines.find((l: { action: string }) => l.action === "purge")).toMatchObject({
      captainAllowed: true,
      firstmateAllowed: false,
      allowedNow: false,
    });
    expect((await ask("release-page", {})).text).toContain("release-page");
    expect(shell.opened.at(-1)).toMatch(/^https:/);
    const records = core.services.tasks
      .list()
      .filter((t) => t.kind === "operation")
      .filter((r) =>
        [
          "start at login on",
          "show in dock off",
          "release page opened",
          "GitHub signed out",
          "voice model ready",
        ].includes(r.title),
      );
    console.log(
      "Piece 3 API evidence",
      JSON.stringify({
        presence: await core.dispatch("inf:presence:get", []),
        sharingUnchanged: true,
        handed,
        records: records.map((r) => ({ title: r.title, id: r.id })),
      }),
    );
    await core.dispatch("inf:presence:set", [before]);
  });

  it("brings a closed card forward through the one show-card door for the captain and Firstmate alike", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    let wake: "captain" | "scheduled" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing app tools");
    const ask = (value: unknown) =>
      change.run({ action: "show-card", value, evidence: "captain asked for the earlier plan" });
    const shown = () => events.filter((e) => e.type === "past_card_shown");
    const operations = () => core.services.tasks.list().filter((t) => t.kind === "operation");
    const supervisor = core.services.supervisor;
    try {
      supervisor.addSystemNoteCard("card-show-open", "Still open", "On the stage.");
      supervisor.addSystemNoteCard("card-show-past", "An earlier plan", "What it said.");
      supervisor.close("card-show-past");
      const stack = async () => (await core.dispatch("inf:cards:list", [])).map((c) => c.id);
      const stackBefore = await stack();
      const pastBefore = await core.dispatch("inf:cards:past", ["card-show-past"]);
      const operationsBefore = operations().length;
      // Firstmate discovers the door and how to find the id from the catalog.
      const line = JSON.parse((await state.run({ area: "general" })).text).find(
        (l: { action: string }) => l.action === "show-card",
      );
      expect(line).toMatchObject({
        captainAllowed: true,
        firstmateAllowed: true,
        allowedNow: true,
      });
      expect(line.line).toContain("resolution.card.id");
      // Firstmate's pointing: the stage is told, one line is written, no card is made.
      expect(JSON.parse((await ask({ cardId: "card-show-past" })).text).action).toBe("show-card");
      expect(shown()).toEqual([{ type: "past_card_shown", cardId: "card-show-past" }]);
      expect(operations()).toHaveLength(operationsBefore + 1);
      expect(events.filter((e) => e.type === "personalized").map((e) => [e.text, e.actor])).toEqual(
        [['showed the earlier card "An earlier plan"', "firstmate"]],
      );
      expect(await stack()).toEqual(stackBefore);
      // The captain's own gesture takes the same door and writes no line.
      const past = await core.dispatch("inf:cards:show-past", ["card-show-past"]);
      expect(past.id).toBe("card-show-past");
      expect(shown()).toHaveLength(2);
      expect(operations()).toHaveLength(operationsBefore + 1);
      // Nothing about the card changed.
      expect(await core.dispatch("inf:cards:past", ["card-show-past"])).toEqual(pastBefore);
      // INF-476: the asked door now restores an open minimized card, without resolving it.
      await core.dispatch("inf:cards:minimize", ["card-show-open", true]);
      expect(
        (await core.dispatch("inf:cards:list", [])).find((card) => card.id === "card-show-open")
          ?.minimized,
      ).toBe(true);
      expect(JSON.parse((await ask({ cardId: "card-show-open" })).text).action).toBe("show-card");
      expect(
        (await core.dispatch("inf:cards:list", [])).find((card) => card.id === "card-show-open"),
      ).toMatchObject({ status: "ready" });
      expect(events).toContainEqual({ type: "open_card_shown", cardId: "card-show-open" });
      // Unknown cards still refuse; the compatible old door still refuses an open card.
      expect((await ask({ cardId: "no-such-card" })).text).toContain("No card");
      await expect(core.dispatch("inf:cards:show-past", ["card-show-open"])).rejects.toThrow(
        /No closed card/,
      );
      expect(shown()).toHaveLength(2);
      // INF-751: his request, relayed in a crewmate's report, takes the same door.
      wake = "other";
      expect(JSON.parse((await ask({ cardId: "card-show-past" })).text).action).toBe("show-card");
      expect(shown()).toHaveLength(3);
      await expect(
        core.dispatch("inf:cards:show-past", ["card-show-past"], {
          kind: "firstmate",
          wake: "captain",
          action: "theme",
          evidence: "asked",
        }),
      ).rejects.toThrow(/outside its action catalog|named/);
    } finally {
      detach();
      supervisor.close("card-show-open");
    }
  });

  it("brings a release note forward through the one What's new door for the captain and Firstmate alike", async () => {
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push(payload as FmEvent);
    });
    let wake: "captain" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing app tools");
    const ask = (value: unknown) =>
      change.run({ action: "show-whats-new", value, evidence: "captain asked what is new" });
    const shown = () =>
      events.filter((e) => e.type === "past_card_shown" || e.type === "open_card_shown");
    const operations = () => core.services.tasks.list().filter((t) => t.kind === "operation");
    const { settings, supervisor } = core.services;
    const saved = settings.getReleaseTracking();
    const delivery = (cardId: string, entryIds: string[], deliveredAt: number) => ({
      boundary: { version: null, source: null },
      entryIds,
      coverage: "complete" as const,
      cardId,
      deliveredAt,
    });
    try {
      // Before any note was shown: refused in words, nothing shown.
      settings.setReleaseTracking({ ...saved, deliveries: {} });
      expect((await core.dispatch("inf:release-notes:list", [])).notes).toEqual([]);
      await expect(core.dispatch("inf:release-notes:show", [null])).rejects.toThrow(
        "No release notes yet.",
      );
      expect((await ask({})).text).toContain("No release notes yet.");
      expect(shown()).toEqual([]);

      // An earlier note that listed changes, closed; a newer one that said
      // nothing was new, still open.
      supervisor.addSystemNoteCard("card-note-listed", "What’s new in stable 0.0.2", "Changes.");
      supervisor.close("card-note-listed");
      supervisor.addSystemNoteCard("card-note-quiet", "Your alpha is now stable", "Nothing new.");
      settings.setReleaseTracking({
        ...saved,
        deliveries: {
          "0.0.2": delivery("card-note-listed", ["a"], 1),
          "0.0.3": delivery("card-note-quiet", [], 2),
        },
      });
      const stack = async () => (await core.dispatch("inf:cards:list", [])).map((c) => c.id);
      const stackBefore = await stack();
      const operationsBefore = operations().length;

      // The captain's door: the newest note that listed changes comes back
      // read-only, past the newer one that said nothing was new; no line.
      expect(await core.dispatch("inf:release-notes:show", [null])).toMatchObject({
        version: "0.0.2",
        cardId: "card-note-listed",
        open: false,
      });
      expect(shown()).toEqual([{ type: "past_card_shown", cardId: "card-note-listed" }]);
      // A note still open comes to the front instead.
      expect(await core.dispatch("inf:release-notes:show", ["0.0.3"])).toMatchObject({
        open: true,
      });
      expect(shown().at(-1)).toEqual({ type: "open_card_shown", cardId: "card-note-quiet" });
      expect(operations()).toHaveLength(operationsBefore);

      // Firstmate finds the versions in the catalog and takes the same door,
      // with one line and no card.
      const line = JSON.parse((await state.run({ area: "general" })).text).find(
        (l: { action: string }) => l.action === "show-whats-new",
      );
      expect(line).toMatchObject({
        firstmateAllowed: true,
        allowedNow: true,
        current: {
          notes: [
            { version: "0.0.3", listed: false },
            { version: "0.0.2", listed: true },
          ],
        },
      });
      expect(JSON.parse((await ask({})).text).action).toBe("show-whats-new");
      expect(shown().at(-1)).toEqual({ type: "past_card_shown", cardId: "card-note-listed" });
      expect(operations()).toHaveLength(operationsBefore + 1);
      expect(events.filter((e) => e.type === "personalized").map((e) => [e.text, e.actor])).toEqual(
        [["showed the release note for 0.0.2", "firstmate"]],
      );
      expect(await stack()).toEqual(stackBefore);
      // A version never shown is refused.
      expect((await ask({ version: "0.0.9" })).text).toContain("No release note for 0.0.9");
      expect(shown()).toHaveLength(3);
      // INF-751: his request, relayed in a crewmate's report, takes the same door.
      wake = "other";
      expect(JSON.parse((await ask({})).text).action).toBe("show-whats-new");
      expect(shown()).toHaveLength(4);
    } finally {
      detach();
      settings.setReleaseTracking(saved);
      supervisor.close("card-note-quiet");
    }
  });

  it("keeps Settings responsive while the voice model downloads", async () => {
    if (!shell.host.voice) throw new Error("Missing boxed voice host");
    let finish: () => void = () => {};
    const downloading = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const mock = vi.spyOn(shell.host.voice, "ensureModel").mockImplementation(async () => {
      signalStarted();
      await downloading;
    });
    const download = core.dispatch("inf:voice:ensure-model", []);
    await started;
    const previous = await core.dispatch("inf:settings:notifications:get", []);
    try {
      await expect(core.dispatch("inf:settings:notifications:set", [!previous])).resolves.toBe(
        !previous,
      );
    } finally {
      finish();
      await download;
      mock.mockRestore();
      await core.dispatch("inf:settings:notifications:set", [previous]);
    }
  });

  it("runs Intelligence catalog actions through real settings and disposable accounts", async () => {
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((t) => t.name === "app_change");
    const state = tools.find((t) => t.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");
    const run = async (action: string, value: unknown) => {
      const before = core.services.tasks.list().filter((t) => t.kind === "operation").length;
      const result = await change.run({ action, value, evidence: "captain asked" });
      const after = core.services.tasks.list().filter((t) => t.kind === "operation").length;
      expect(after - before).toBeLessThanOrEqual(1);
      return JSON.parse(result.text).current;
    };
    const account = await core.services.vault.add("xai", "api_key", {
      prompt: async () => "disposable-test-key",
      notify: () => {},
      openExternal: async () => {},
    });
    const before = core.services.tasks.list().filter((t) => t.kind === "operation").length;
    expect(
      (await run("account-rename", { accountId: account.id, label: "Work" })).accounts,
    ).toContainEqual({ id: account.id, label: "Work" });
    expect(
      (await run("account-pause", { accountId: account.id, paused: true })).accounts,
    ).toContainEqual({ id: account.id, paused: true });
    await run("account-pause", { accountId: account.id, paused: false });
    expect(
      (await run("account-prefer", { provider: "xai", accountId: account.id })).accounts,
    ).toContainEqual({ id: account.id, provider: "xai", preferred: true });
    await run("account-prefer", { provider: "xai", accountId: null });
    // Firstmate's own account is its own action, apart from crew work's
    // preference, and its line names the account by label, never by id.
    const seatBefore = core.services.settings.getFirstmateAccount();
    const modelBefore = core.services.settings.getFirstmateModel();
    // An account of another provider than Firstmate's model is refused in
    // words that point at the model, and nothing is saved or written.
    core.services.settings.setFirstmateModel({ provider: "openai-codex", id: "gpt-5.5" });
    const linesBefore = core.services.tasks.list().filter((t) => t.kind === "operation").length;
    expect(
      (
        await change.run({
          action: "firstmate-account",
          value: { accountId: account.id },
          evidence: "captain asked",
        })
      ).text,
    ).toBe(
      "Work is a Grok account, and your first mate answers with Codex. Choose a Grok model for your first mate first.",
    );
    expect(core.services.settings.getFirstmateAccount()).toBe(seatBefore);
    expect(core.services.tasks.list().filter((t) => t.kind === "operation")).toHaveLength(
      linesBefore,
    );
    // The seat starts on Auto: on a fresh profile the welcome's readiness
    // check has already saved the only account as Auto's pick, and a pick
    // that changes nothing files no line.
    core.services.settings.setFirstmateBinding({ provider: "xai", id: "grok-4" }, null);
    expect(await run("firstmate-account", { accountId: account.id })).toEqual({
      accountId: account.id,
    });
    expect(core.services.settings.getFirstmateAccount()).toBe(account.id);
    expect(
      (await core.dispatch("inf:accounts:list", [])).find((entry) => entry.id === account.id)
        ?.pinned,
    ).toBe(false);
    const seatLines = core.services.tasks
      .list()
      .filter((t) => t.kind === "operation" && t.title.startsWith("First mate account"));
    expect(seatLines.map((t) => t.title)).toEqual(["First mate account Work"]);
    core.services.settings.setFirstmateBinding(modelBefore, seatBefore);
    const routing = await core.dispatch("inf:settings:routing:get", []);
    await run("model-pins", { pins: [{ provider: "xai", id: "grok-4" }] });
    await run("routing", { enabled: !routing.dynamicRouting });
    expect(await core.dispatch("inf:settings:routing:get", [])).toEqual({
      dynamicRouting: !routing.dynamicRouting,
      pins: [{ provider: "xai", id: "grok-4" }],
    });
    await expect(
      core.dispatch(
        "inf:settings:routing:set",
        [{ dynamicRouting: routing.dynamicRouting, pins: [] }],
        { kind: "firstmate", wake: "captain", action: "routing", evidence: "asked" },
      ),
    ).rejects.toThrow("named routing");
    await run("crew-slots", { key: "xai/grok-4", slot: "high", on: true });
    await run("crew-slots", { key: "xai/grok-4", slot: "high", on: false });
    await run("crew-slots-reset", { provider: "xai" });
    const decisions = await core.dispatch("inf:settings:decisions", []);
    const answerer = { kind: "adapted", offering: "xai/grok-4" };
    expect(await run("decision-model", { answerer })).toEqual({ answerer });
    expect((await core.dispatch("inf:settings:decisions", [])).settings.egress).toEqual(
      decisions.settings.egress,
    );
    await expect(
      core.dispatch(
        "inf:settings:decisions:set",
        [{ ...decisions.settings, egress: { jev: { enabled: true } } }],
        { kind: "firstmate", wake: "captain", action: "decision-model", evidence: "asked" },
      ),
    ).rejects.toThrow("outbound consent");
    const refusal = await change.run({
      action: "firstmate-model",
      value: { model: { provider: "cursor", id: "missing" } },
      evidence: "asked",
    });
    expect(refusal.text).toMatch(/cannot run|not connected/);
    // Before attachment, the saved seat is protected too.
    core.services.settings.setFirstmateAccount(account.id);
    expect(
      (
        await change.run({
          action: "account-disconnect",
          value: { accountId: account.id },
          evidence: "asked",
        })
      ).text,
    ).toContain("account it is running on");
    core.services.settings.setFirstmateAccount(null);
    const attachment = vi
      .spyOn(core.services.firstmate, "boundAccount")
      .mockReturnValue(account.id);
    try {
      expect(
        (
          await change.run({
            action: "account-disconnect",
            value: { accountId: account.id },
            evidence: "asked",
          })
        ).text,
      ).toContain("account it is running on");
    } finally {
      attachment.mockRestore();
    }
    await run("firstmate-model", { model: null });
    const priorRefresh = core.services.tasks.list().filter((t) => t.kind === "operation").length;
    await run("refresh-usage", {});
    await run("refresh-usage", {});
    expect(core.services.tasks.list().filter((t) => t.kind === "operation")).toHaveLength(
      priorRefresh + 2,
    );
    // INF-751: his typed words in a schedule he set disconnect on its wake.
    const scheduled = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "scheduled" }),
    }).find((t) => t.name === "app_change");
    if (!scheduled) throw new Error("Missing change tool");
    expect(
      JSON.parse(
        (
          await scheduled.run({
            action: "account-disconnect",
            value: { accountId: account.id },
            evidence: "Disconnect the Work account on Friday evening.",
          })
        ).text,
      ).action,
    ).toBe("account-disconnect");
    expect(await core.dispatch("inf:accounts:list", [])).not.toContainEqual(
      expect.objectContaining({ id: account.id }),
    );
    const lines = JSON.parse((await state.run({ area: "intelligence" })).text);
    expect(lines.map((l: { action: string }) => l.action)).toEqual(
      ACTION_NAMES.filter((name) => ACTIONS[name].area === "intelligence"),
    );
    expect(
      lines.every(
        (l: { action: keyof typeof ACTIONS; captainAllowed: boolean; firstmateAllowed: boolean }) =>
          l.captainAllowed &&
          l.firstmateAllowed === ["asked", "own-words"].includes(ACTIONS[l.action].tier),
      ),
    ).toBe(true);
    expect(core.services.tasks.list().filter((t) => t.kind === "operation").length).toBeGreaterThan(
      before,
    );
    await core.dispatch("inf:settings:routing:set", [routing]);
    await core.dispatch("inf:settings:decisions:set", [decisions.settings]);
  });

  it("adds projects through one catalog path with one actor trail and no duplicate or refused entries", async () => {
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const folder = scratchDir("catalog-adopt-");
    const setups = () =>
      core.services.tasks
        .list()
        .filter((t) => t.kind === "operation" && t.title.startsWith("Set up project ")).length;
    const before = setups();
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    try {
      const added = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
      expect(added).toMatchObject({
        created: true,
        initializedGit: true,
        createdInitialCommit: true,
        repo: { kind: "project", delivery: "local-only", autonomy: false },
      });
      expect(setups()).toBe(before + 1);
      expect(events.filter((e) => e.type === "repo_setup")).toMatchObject([
        { actor: "captain", repoId: added.repo.id },
      ]);
      expect(
        core.services.tasks.list().find((t) => t.kind === "operation" && t.repoId === added.repo.id)
          ?.title,
      ).toBe(`Set up project ${added.repo.name}`);
      // A project already on the list is named, never carded or added twice.
      const cardsBefore = core.services.supervisor.cardsSnapshot().length;
      expect(
        (
          await change.run({
            action: "project-setup",
            value: { kind: "adopt", path: folder },
            evidence: "add this folder",
          })
        ).text,
      ).toContain(`repo_id ${added.repo.id}`);
      expect(core.services.supervisor.cardsSnapshot()).toHaveLength(cardsBefore);
      expect(setups()).toBe(before + 1);
      expect(events.filter((e) => e.type === "repo_setup")).toHaveLength(1);
      // Firstmate's ask puts up the setup card and adds nothing; the
      // captain's click on it adds the project, as his.
      const proposed = await change.run({
        action: "project-setup",
        value: { kind: "init", name: "catalog-setup", rigor: "quick" },
        evidence: "start catalog-setup",
      });
      const card = core.services.supervisor
        .cardsSnapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.title("catalog-setup"));
      expect(card?.author).toBe("host");
      expect(proposed.text).toContain(card?.id);
      expect(core.services.repos.list().some((r) => r.name === "catalog-setup")).toBe(false);
      expect(setups()).toBe(before + 1);
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > 0, 10_000);
      expect(core.services.repos.list()).toContainEqual(
        expect.objectContaining({ name: "catalog-setup", delivery: "local-only", rigor: "quick" }),
      );
      expect(setups()).toBe(before + 2);
      expect(events.filter((e) => e.type === "repo_setup")).toMatchObject([
        { actor: "captain" },
        { actor: "captain" },
      ]);
      expect(told.mock.calls[0]?.[0].facts).toMatchObject({
        kind: "project-setup",
        outcome: "added",
        name: "catalog-setup",
      });
      await expect(
        core.dispatch("inf:repos:setup", [{ kind: "init", name: "../outside" }]),
      ).rejects.toThrow();
      const refused = vi
        .spyOn(core.services.repos, "setup")
        .mockRejectedValueOnce(new Error("host refused clone"));
      await expect(
        core.dispatch("inf:repos:setup", [
          { kind: "clone", origin: "https://github.com/octo/private.git" },
        ]),
      ).rejects.toThrow(
        "GitHub did not let this app add private. Sign in to GitHub at the top of this tab, then try again.",
      );
      refused.mockRestore();
      expect(setups()).toBe(before + 2);
      // A report's proposal still only asks; Firstmate itself can never set up.
      const autonomous = createAppTools({
        dispatch: core.dispatch,
        propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
        actor: () => ({ kind: "firstmate", wake: "other" }),
      }).find((t) => t.name === "app_change");
      expect(
        (
          await autonomous?.run({
            action: "project-setup",
            value: { kind: "init", name: "not-requested" },
            evidence: "my idea",
          })
        )?.text,
      ).toContain("setup card");
      await expect(
        core.dispatch("inf:repos:setup", [{ kind: "init", name: "not-requested" }], {
          kind: "firstmate",
          wake: "captain",
          action: "project-setup",
          evidence: "start not-requested",
        }),
      ).rejects.toThrow("This action stays with the captain in Settings.");
      expect(core.services.repos.list().some((r) => r.name === "not-requested")).toBe(false);
      expect(setups()).toBe(before + 2);
    } finally {
      told.mockRestore();
      off();
      for (const card of core.services.supervisor.cardsSnapshot())
        if (card.id.startsWith("card-project-setup-"))
          core.services.supervisor.withdrawHostCard(card.id, "test over");
      for (const repo of core.services.repos.list()) {
        if (repo.path === folder || repo.name === "catalog-setup")
          core.services.repos.unregister(repo.id);
      }
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("carries a clone sign-in way to Firstmate while Settings keeps its own sentence", async () => {
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const before = core.services.tasks
      .list()
      .filter((t) => t.kind === "operation" && t.title.startsWith("Set up project ")).length;
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const setup = vi
      .spyOn(core.services.repos, "setup")
      .mockRejectedValue(new Error("clone failed"));
    const signedIn = vi.spyOn(core.services.forges, "isSignedIn").mockReturnValue(false);
    /** Proposes, clicks Add project on the setup card, and reads what Firstmate hears. */
    const addFromCard = async (value: { kind: "clone"; origin: string }) => {
      const calls = told.mock.calls.length;
      await change.run({ action: "project-setup", value, evidence: "clone private" });
      const card = core.services.supervisor
        .cardsSnapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.title("private"));
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > calls, 10_000);
      const wake = told.mock.calls.at(-1)?.[0];
      if (!wake) throw new Error("Firstmate was not told");
      return renderWake(wake);
    };
    try {
      const value = { kind: "clone" as const, origin: "https://github.com/octo/private.git" };
      await expect(core.dispatch("inf:repos:setup", [value])).rejects.toThrow(
        "GitHub did not let this app add private. Sign in to GitHub at the top of this tab, then try again.",
      );
      const text = await addFromCard(value);
      expect(text).toContain("Not signed in to GitHub (github.com)");
      expect(text).not.toContain("this tab");
      const json = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
      if (!json) throw new Error("Missing typed clone refusal");
      const refusal = JSON.parse(json);
      expect(refusal).toEqual({
        refused: "not-signed-in",
        host: "github.com",
        ways: [
          {
            label: "Sign in to GitHub",
            effect: { kind: "open", target: "projects", signIn: "github.com" },
          },
        ],
      });
      signedIn.mockReturnValue(true);
      expect(await addFromCard(value)).toContain(": clone failed. Nothing was added.");
      signedIn.mockReturnValue(false);
      expect(
        await addFromCard({ kind: "clone", origin: "https://git.example.com/octo/private.git" }),
      ).toContain(": clone failed. Nothing was added.");
      expect(
        core.services.tasks
          .list()
          .filter((t) => t.kind === "operation" && t.title.startsWith("Set up project ")),
      ).toHaveLength(before);
      expect(events.filter((e) => e.type === "repo_setup")).toHaveLength(0);
    } finally {
      setup.mockRestore();
      signedIn.mockRestore();
      told.mockRestore();
      off();
    }
  });

  it("adds a project with the task key Firstmate asked for, shown on its card, and refuses a key in use", async () => {
    const told = vi.spyOn(core.services.firstmate, "notifyOp").mockImplementation(() => null);
    const signedIn = vi.spyOn(core.services.forges, "isSignedIn").mockReturnValue(false);
    const change = createAppTools({
      dispatch: core.dispatch,
      propose: async (_action, value) => (await core.services.projectSetups.propose(value)).text,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const keyOf = async (name: string) =>
      (await core.dispatch("inf:projects:list", [])).find((project) => project.name === name)?.key;
    try {
      await change.run({
        action: "project-setup",
        value: { kind: "init", name: "keyed-setup", key: "kys" },
        evidence: "start keyed-setup, its tasks as KYS",
      });
      const card = core.services.supervisor
        .cardsSnapshot()
        .find((c) => c.title === SETUP_CARD_WORDS.title("keyed-setup"));
      expect(card?.body).toContain(`>${SETUP_CARD_WORDS.key}</span>`);
      expect(card?.body).toContain(">KYS</span>");
      await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
      await waitFor(() => told.mock.calls.length > 0, 10_000);
      expect(told.mock.calls[0]?.[0].facts).toMatchObject({
        outcome: "added",
        name: "keyed-setup",
      });
      expect(await keyOf("keyed-setup")).toBe("KYS");

      // A key another project has is refused at the ask, in words, with no card.
      const cards = core.services.supervisor.cardsSnapshot().length;
      const inUse = "KYS is already the task key of keyed-setup. Choose another.";
      expect(
        (
          await change.run({
            action: "project-setup",
            value: { kind: "init", name: "keyed-other", key: "KYS" },
            evidence: "start keyed-other as KYS",
          })
        ).text,
      ).toBe(inUse);
      expect(core.services.supervisor.cardsSnapshot()).toHaveLength(cards);
      // Settings' clone hears the same refusal, never a sign-in it does not need.
      await expect(
        core.dispatch("inf:repos:setup", [
          { kind: "clone", origin: "https://github.com/octo/keyed-other.git", key: "kys" },
        ]),
      ).rejects.toThrow(inUse);
      expect(await keyOf("keyed-other")).toBeUndefined();
    } finally {
      signedIn.mockRestore();
      told.mockRestore();
      for (const card of core.services.supervisor.cardsSnapshot())
        if (card.id.startsWith("card-project-setup-"))
          core.services.supervisor.withdrawHostCard(card.id, "test over");
      for (const repo of core.services.repos.list())
        if (repo.name === "keyed-setup") core.services.repos.unregister(repo.id);
    }
  });

  it("removes a project through one catalog path: names busy tasks, leaves the folder, on the captain's own words wherever they reach the first mate", async () => {
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const folder = scratchDir("catalog-remove-");
    writeFileSync(join(folder, "keep.txt"), "mine\n");
    const { repo } = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
    try {
      const own = createAppTools({
        dispatch: core.dispatch,
        actor: () => ({ kind: "firstmate", wake: "captain" }),
      }).find((t) => t.name === "app_change");
      const reported = createAppTools({
        dispatch: core.dispatch,
        actor: () => ({ kind: "firstmate", wake: "other" }),
      }).find((t) => t.name === "app_change");
      if (!own || !reported) throw new Error("Missing app_change");

      const busy = seedTask(core.services.tasks, {
        id: "remove-busy",
        title: "Fix the sign-up form",
        repoId: repo.id,
        status: "running",
      });
      expect(await core.dispatch("inf:repos:removal", [repo.id])).toEqual({
        tasks: [{ key: busy.key, title: "Fix the sign-up form", status: "working" }],
      });
      const refusal = `${repo.name} still has 1 task: ${busy.key} "Fix the sign-up form" (working). Finish or drop it, then remove it.`;
      await expect(core.dispatch("inf:repos:remove", [repo.id])).rejects.toThrow(refusal);
      // His typed words in his own turn, and the same words a crewmate relays
      // in its report (INF-751), meet the same check.
      for (const [tool, evidence] of [
        [own, "remove it"],
        [reported, 'The captain replied under SCR-1\'s card: "remove it from the app".'],
      ] as const)
        expect(
          (await tool.run({ action: "project-remove", value: { repoId: repo.id }, evidence })).text,
        ).toContain(refusal);
      expect(core.services.repos.get(repo.id)).toBeDefined();
      expect(events.filter((e) => e.type === "repo_unregistered")).toHaveLength(0);

      core.services.tasks.close(busy.id, {
        status: "dropped",
        reason: "cancelled",
        actor: "captain",
      });
      expect(await core.dispatch("inf:repos:removal", [repo.id])).toEqual({ tasks: [] });
      const operations = () =>
        core.services.tasks.list().filter((t) => t.kind === "operation" && t.repoId === repo.id);
      await core.dispatch("inf:repos:remove", [repo.id]);
      expect(core.services.repos.get(repo.id)).toBeUndefined();
      expect(existsSync(join(folder, "keep.txt"))).toBe(true);
      expect(events.filter((e) => e.type === "repo_unregistered")).toMatchObject([
        { actor: "captain", repoId: repo.id, name: repo.name },
      ]);
      expect(operations().map((t) => t.title)).toContain(`Removed project ${repo.name}`);
      await expect(core.dispatch("inf:repos:remove", [repo.id])).rejects.toThrow("not here");
    } finally {
      off();
      if (core.services.repos.get(repo.id)) core.services.repos.unregister(repo.id);
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps project downloads off the Settings queue", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = core.services.repos.setup.bind(core.services.repos);
    const setup = vi.spyOn(core.services.repos, "setup").mockImplementation(async (spec) => {
      await held;
      return original(spec);
    });
    const pending = core.dispatch("inf:repos:setup", [{ kind: "init", name: "catalog-queue" }]);
    try {
      await core.dispatch("inf:settings:appearance:set", [
        { theme: "dark", size: 100, washStrength: 0, showCrewModelNames: true },
      ]);
      expect(setup).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      const result = await pending;
      setup.mockRestore();
      core.services.repos.unregister(result.repo.id);
    }
  });

  it("folds project, theme and panel actions into one attributed trail and preserves other values", async () => {
    const created = await core.services.repos.setup({ kind: "init", name: "catalog-policy" });
    const events: FmEvent[] = [];
    const detach = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    let wake: "captain" | "scheduled" | "other" = "captain";
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
    });
    const change = tools.find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const apply = (action: string, value: unknown) =>
      change.run({ action, value, evidence: "captain asks", on_words: true });
    const count = () => core.services.tasks.list().filter((t) => t.kind === "operation").length;
    const initial = count();
    try {
      const changed = await apply("project-settings", {
        repoId: created.repo.id,
        changes: { autonomy: true, rigor: "reviewed" },
      });
      expect(
        JSON.parse(changed.text).current.projects.find(
          (r: { id: string }) => r.id === created.repo.id,
        ),
      ).toMatchObject({ delivery: "local-only", autonomy: true, rigor: "reviewed" });
      expect(count()).toBe(initial + 1);
      expect(events.filter((e) => e.type === "repo_configured")).toMatchObject([
        { actor: "firstmate" },
      ]);
      expect(events.filter((e) => e.type === "personalized")).toHaveLength(0);
      const operation = core.services.tasks
        .list()
        .find((t) => t.kind === "operation" && t.repoId === created.repo.id);
      expect(
        core.services.tasks.timeline(operation?.id ?? "").find((e) => e.kind === "status")?.actor,
      ).toBe("firstmate");
      await apply("project-settings", { repoId: created.repo.id, changes: { autonomy: true } });
      expect(count()).toBe(initial + 1);
      expect(
        (await apply("project-settings", { repoId: "missing", changes: { autonomy: true } })).text,
      ).toContain("Unknown repo_id");
      expect(
        (await apply("project-settings", { repoId: created.repo.id, changes: {} })).text,
      ).toContain("pass delivery");
      expect(count()).toBe(initial + 1);
      // INF-751: the captain's choices, relayed in a crewmate's report, apply
      // on its wake, each with its trail.
      wake = "other";
      const beforeRelayed = count();
      await apply("theme", { theme: "light" });
      expect((await core.dispatch("inf:settings:appearance:get", [])).theme).toBe("light");
      await apply("panel", { surface: "now", visible: false });
      expect((await core.dispatch("inf:settings:layout:get", [])).hiddenPanels.now).toBe(true);
      await apply("project-settings", { repoId: created.repo.id, changes: { autonomy: false } });
      expect(core.services.repos.get(created.repo.id)?.autonomy).toBe(false);
      expect(count()).toBe(beforeRelayed + 3);
      wake = "scheduled";
      const appearance = {
        theme: "dark" as const,
        size: 125 as const,
        washStrength: 37,
        showCrewModelNames: false,
      };
      await core.dispatch("inf:settings:appearance:set", [appearance]);
      await apply("theme", { theme: "light" });
      expect(await core.dispatch("inf:settings:appearance:get", [])).toEqual({
        ...appearance,
        theme: "light",
      });
      const afterTheme = count();
      await apply("theme", { theme: "light" });
      expect(count()).toBe(afterTheme);
      const layout = { collapsedPanels: { activity: true }, hiddenPanels: {}, placements: {} };
      await core.dispatch("inf:settings:layout:set", [layout]);
      await apply("panel", { surface: "now", rail: "left", position: "top", visible: false });
      expect(await core.dispatch("inf:settings:layout:get", [])).toEqual({
        ...layout,
        hiddenPanels: { now: true },
        placements: { now: { x: "left", y: "top" } },
      });
      const arranged = count();
      await apply("panel", { surface: "Tasks", rail: "left", position: "top", visible: false });
      expect(count()).toBe(arranged);
      await apply("panel", { surface: "now", rail: "right", position: "bottom", visible: true });
      expect(await core.dispatch("inf:settings:layout:get", [])).toEqual(layout);
      expect((await apply("panel", { surface: "missing", visible: false })).text).toContain(
        "Your surfaces:",
      );
      expect((await apply("panel", { surface: "now" })).text).toContain("panel needs");
      await expect(
        core.dispatch("inf:settings:appearance:set", [{ ...appearance, theme: "dark" }], {
          kind: "firstmate",
          wake: "captain",
          action: "window-wash",
          evidence: "asked",
        }),
      ).rejects.toThrow("named appearance");
      await expect(
        core.dispatch("inf:settings:layout:set", [{ ...layout, hiddenPanels: { now: true } }], {
          kind: "firstmate",
          wake: "captain",
          action: "panel-collapse",
          evidence: "asked",
        }),
      ).rejects.toThrow("named panel");
      await expect(
        core.dispatch(
          "inf:settings:layout:set",
          [{ ...layout, collapsedPanels: {}, hiddenPanels: { now: true } }],
          { kind: "firstmate", wake: "captain", action: "panel", evidence: "asked" },
        ),
      ).rejects.toThrow("named panel");
      const beforeCaptain = count();
      await core.dispatch("inf:repos:configure", [created.repo.id, { autonomy: true }]);
      expect(count()).toBe(beforeCaptain + 1);
      expect(events.filter((e) => e.type === "repo_configured")).toMatchObject([
        { actor: "firstmate" },
        { actor: "firstmate" },
        { actor: "captain" },
      ]);
    } finally {
      detach();
      core.services.repos.unregister(created.repo.id);
    }
  });

  it("keeps panel defaults on the shared write path and docks a fourth panel on a rail", async () => {
    const old = await core.dispatch("inf:settings:layout:get", []);
    const snapshot = vi.spyOn(core.services.personal, "snapshot").mockReturnValue({
      extensions: ["clock", "quota"].map((id) => ({
        id,
        source: "yours" as const,
        by: null,
        frame: null,
        title: id,
        placement: { x: "right" as const, y: "top" as const },
        order: 100,
        size: "content" as const,
        present: true,
        ownPresence: false,
        moves: false,
        running: false,
        reads: [],
        sql: [],
        panel: null,
        server: null,
        cardViews: [],
        cards: {},
        header: [],
        commands: [],
        error: null,
      })),
    });
    const tools = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    });
    const change = tools.find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    try {
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      ]);
      // INF-609, the captain: "allow more panels ... not refusing it." Tasks,
      // clock and quota hold the right rail; Activity joins them as a fourth.
      await change.run({
        action: "panel",
        value: { surface: "activity", rail: "right" },
        evidence: "move activity right",
      });
      expect((await core.dispatch("inf:settings:layout:get", [])).placements).toEqual({
        activity: { x: "right", y: "bottom" },
      });
      await change.run({
        action: "panel",
        value: { surface: "activity", rail: "left" },
        evidence: "put activity back",
      });
      expect((await core.dispatch("inf:settings:layout:get", [])).placements).toEqual({});
      await change.run({
        action: "panel",
        value: { surface: "clock", rail: "left", position: "bottom" },
        evidence: "move clock left",
      });
      expect((await core.dispatch("inf:settings:layout:get", [])).placements.clock).toEqual({
        x: "left",
        y: "bottom",
      });
      await change.run({
        action: "panel",
        value: { surface: "clock", rail: "right", position: "top" },
        evidence: "put clock back",
      });
      expect((await core.dispatch("inf:settings:layout:get", [])).placements).toEqual({});
    } finally {
      // Restore the layout while the roster that owns any deviations is still present.
      await core.dispatch("inf:settings:layout:set", [old]);
      snapshot.mockRestore();
    }
  });

  it("hides and shows the create-your-own-panel slot by its id and never moves it", async () => {
    const old = await core.dispatch("inf:settings:layout:get", []);
    const snapshot = vi.spyOn(core.services.personal, "snapshot").mockReturnValue({
      extensions: ["clock", "quota"].map((id) => ({
        id,
        source: "yours" as const,
        by: null,
        frame: null,
        title: id,
        placement: { x: "right" as const, y: "top" as const },
        order: 100,
        size: "content" as const,
        present: true,
        ownPresence: false,
        moves: false,
        running: false,
        reads: [],
        sql: [],
        panel: null,
        server: null,
        cardViews: [],
        cards: {},
        header: [],
        commands: [],
        error: null,
      })),
    });
    const feed: string[] = [];
    let detach = () => {};
    const change = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake: "captain" }),
    }).find((t) => t.name === "app_change");
    if (!change) throw new Error("Missing app_change");
    const layout = () => core.dispatch("inf:settings:layout:get", []);
    try {
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      ]);
      detach = core.events.subscribe((channel, payload) => {
        const event = payload as { type: string; text?: string };
        if (channel === "inf:event" && event.type === "personalized") feed.push(event.text ?? "");
      });
      // "Hide it" to the Firstmate: one feed line, and the record the rails read.
      await change.run({
        action: "panel",
        value: { surface: "create-panel", visible: false },
        evidence: "hide the create your own panel slot",
      });
      expect((await layout()).hiddenPanels).toEqual({ "create-panel": true });
      expect(feed).toEqual(["Create your own panel hidden"]);
      const moved = await change.run({
        action: "panel",
        value: { surface: "create-panel", rail: "right" },
        evidence: "put it on the right",
      });
      expect(moved.text).toContain("can only be hidden or shown");
      expect((await layout()).placements).toEqual({});
      await change.run({
        action: "panel",
        value: { surface: "create-panel", visible: true },
        evidence: "show it again",
      });
      expect((await layout()).hiddenPanels).toEqual({});
      // The slot's own Hide is the captain's write on the same path.
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: { "create-panel": true }, placements: {} },
      ]);
      expect(feed).toEqual([
        "Create your own panel hidden",
        "Create your own panel shown",
        "Create your own panel hidden",
      ]);
      await core.dispatch("inf:settings:layout:set", [
        { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
      ]);
      // Two panels move to the left rail beside Activity and the slot.
      for (const surface of ["clock", "quota"])
        await change.run({
          action: "panel",
          value: { surface, rail: "left" },
          evidence: `move ${surface} left`,
        });
      expect(Object.keys((await layout()).placements)).toEqual(["clock", "quota"]);
    } finally {
      detach();
      // Restore the layout while the roster that owns any deviations is still present.
      await core.dispatch("inf:settings:layout:set", [old]);
      snapshot.mockRestore();
    }
  });

  it("configures repository policy through the dispatcher and broadcasts", async () => {
    const created = await core.services.repos.setup({ kind: "init", name: "policy-ui" });
    const origin = scratchDir("policy-ui-origin-");
    await git(origin, ["init", "--bare", "--initial-branch=main"]);
    await git(created.repo.path, ["remote", "add", "origin", origin]);
    const events: string[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push((payload as { type: string }).type);
    });
    const updated = await core.dispatch("inf:repos:configure", [
      created.repo.id,
      { delivery: "direct-pr", autonomy: true, rigor: "standard", origin },
    ]);
    detach();
    expect(updated).toMatchObject({
      id: created.repo.id,
      delivery: "direct-pr",
      autonomy: true,
      rigor: "standard",
    });
    expect(core.services.repos.get(created.repo.id)).toEqual(updated);
    expect(events).toContain("repo_configured");
    const operation = core.services.tasks
      .list()
      .find((task) => task.kind === "operation" && task.repoId === created.repo.id);
    expect(operation).toMatchObject({
      title: "Changed settings for project policy-ui",
      closedReason: "settled",
    });
    const status = core.services.tasks
      .timeline(operation?.id ?? "")
      .find((event) => event.kind === "status");
    expect(status?.actor).toBe("captain");
    expect(status?.text).toBe("settled by app_change");
    const notes: string[] = [];
    const watchNotes = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event" && (payload as { type: string }).type === "firstmate_note") {
        notes.push((payload as { text: string }).text);
      }
    });
    try {
      await expect(
        core.dispatch("inf:repos:configure", ["no-such-repo", { autonomy: true }]),
      ).rejects.toThrow(/Unknown repo_id/);
      expect(notes.some((text) => text.startsWith("Could not change the project's settings"))).toBe(
        true,
      );
    } finally {
      watchNotes();
      core.services.repos.unregister(created.repo.id);
    }
  });

  it("records a feed line that names its task on that task, and the feed reads it back as written", async () => {
    const { tasks, broadcastEvent } = core.services;
    tasks.create({ id: "feed-line-task", title: "Feed line", prompt: "p", repoId: null });
    const key = tasks.get("feed-line-task")?.key;
    broadcastEvent({
      type: "firstmate_note",
      text: 'Could not deliver the reply on "Which way?": the session is gone',
      taskId: "feed-line-task",
    });
    broadcastEvent({ type: "firstmate_note", text: "A line about no task." });
    const note = tasks.timeline("feed-line-task").find((event) => event.kind === "note");
    expect(note).toMatchObject({
      text: 'Could not deliver the reply on "Which way?": the session is gone',
      feed: true,
      data: { news: true, feedLine: true },
    });
    const feed = await core.dispatch("inf:feed:recent", []);
    expect(feed).toContainEqual(
      expect.objectContaining({
        taskKey: key,
        text: 'Could not deliver the reply on "Which way?": the session is gone',
      }),
    );
    expect(feed).toContainEqual(expect.objectContaining({ text: "A line about no task." }));
    expect(feed.filter((line) => line.text.startsWith("Could not deliver the reply"))).toHaveLength(
      1,
    );
  });

  it("pushes an event to every attached sink and stops when one detaches", async () => {
    const events: string[] = [];
    const cardPushes: Card[][] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:event") events.push((payload as { type: string }).type);
      if (channel === "inf:cards") cardPushes.push(payload as Card[]);
    });

    core.services.supervisor.addSystemNoteCard("card-core-test", "Core test", "A note body.");
    // Card broadcasts coalesce on a short timer, so wait for the push.
    await waitFor(() => cardPushes.length > 0);
    expect(cardPushes.at(-1)?.some((card) => card.id === "card-core-test")).toBe(true);
    // The notifier rides the same broadcast seam, so the fake shell's
    // Notification Center got the card too.
    expect(shell.notified.at(-1)?.title).toBe("Core test");

    detach();
    const before = cardPushes.length;
    core.services.supervisor.close("card-core-test");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cardPushes.length).toBe(before);
    expect(events).toEqual([]);
    // The still-attached client is what the dispatcher answers from.
    const cards = await core.dispatch("inf:cards:list", []);
    expect(cards.some((card) => card.id === "card-core-test")).toBe(false);
  });

  it("reads the quota snapshot the sensor produced without any provider HTTP", async () => {
    const snapshot = (await core.dispatch("inf:quota:refresh", [])) as QuotaSnapshotView | null;
    expect(snapshot?.providers[0]?.provider).toBe("codex");
    expect(await core.dispatch("inf:quota:snapshot", [])).not.toBeNull();
  });
});

/**
 * Capture (task-system P1, design section 6, acceptance in section 12): the
 * seven turn shapes the six-way contract produces - answer, ask, steer,
 * spawn, settle, operate, and a turn that does nothing - each driven through
 * `inf:converse` against a real Pi session scripted by the e2e mock provider,
 * and each ending with exactly one ask attached to a task. Plus the hinted
 * fallback: a turn that names a task and does nothing lands on that task.
 *
 * Each case owns its prerequisites (docs/testing.md): the core is shared to
 * save its boot, never as a prerequisite, so any case passes selected alone.
 * A case that needs a project registers its own. The crewmate's journey -
 * spawned, steered, nudged, settled, then read back through the protocol -
 * is one test with named sections, because each part acts on the task the
 * part before it made.
 */
describe("capture: every captain ask lands in a task", () => {
  let userDataDir: string;
  let adoptDir: string;
  let core: Core;
  let mock: MockProviderServer;
  /** The ask each captain turn of this file opened, oldest first. */
  const turnAsks: string[] = [];

  beforeAll(async () => {
    process.env.PI_OFFLINE = "1";
    userDataDir = scratchDir("infinitary-capture-");
    adoptDir = scratchDir("infinitary-capture-repo-");
    mock = await startMockProvider({ scenarios: [workspaceInference, projectSetup] });
    // The same seam the e2e suite uses: the app-scoped models.json points Pi
    // at the mock, so the Firstmate and its crewmate run real sessions.
    mkdirSync(join(userDataDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mock.port));
    core = await startCore(fakeHost(userDataDir).host);
  }, 120_000);

  /**
   * Every ask of the session is attached and closed, checked after each case
   * so it holds whichever cases ran: the asks are exactly the ones this
   * file's turns opened, one per turn, and none is left open or unattached.
   */
  afterEach(() => {
    const asks = core.services.tasks.listAsks();
    expect(asks.map((ask) => ask.id)).toEqual(turnAsks);
    expect(asks.every((ask) => ask.taskId !== null && ask.turnState === "closed")).toBe(true);
  });

  afterAll(async () => {
    // Keep userData until the crew, the worktree pool's background reset,
    // its trash deletion, and Pi's catalog writes have all finished. Removing
    // it while git resets a returned tree races rmSync with ENOTEMPTY on macOS.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    await mock?.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(adoptDir, { recursive: true, force: true });
    expect(existsSync(userDataDir)).toBe(false);
    expect(existsSync(adoptDir)).toBe(false);
  }, 30_000);

  /** One captain turn: the ask closes when the turn ends. */
  async function turn(payload: string | { text: string; taskId?: string }): Promise<AskRecord> {
    const before = new Set(core.services.tasks.listAsks().map((ask) => ask.id));
    await core.dispatch("inf:converse", [payload]);
    const opened = core.services.tasks.listAsks().find((ask) => !before.has(ask.id));
    if (!opened) throw new Error("the turn opened no ask");
    turnAsks.push(opened.id);
    await waitFor(() => core.services.tasks.getAsk(opened.id)?.turnState !== "open", 60_000);
    const closed = core.services.tasks.getAsk(opened.id);
    if (!closed) throw new Error("the ask vanished");
    return closed;
  }

  async function crewIdle(title: string): Promise<string> {
    let taskId = "";
    await waitFor(() => {
      const entry = core.services.supervisor
        .crewStatus()
        .find((row) => row.title === title && row.status === "idle");
      taskId = entry?.taskId ?? "";
      return taskId !== "";
    }, 60_000);
    return taskId;
  }

  /** A named part of one journey: a failure says which part it stopped in. */
  async function section<T>(name: string, part: () => Promise<T>): Promise<T> {
    try {
      return await part();
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`;
      throw error;
    }
  }

  it("operate: a fleet operation files an operation task", async () => {
    const ask = await turn(`${ADOPT_REPO_PROMPT_MARKER}${adoptDir}`);
    expect(ask.attachedVia).toBe("tool:app_change");
    // The ask lands on the setup card's own row; the captain's Add project
    // answers it and files the setup's own operation.
    const asked = core.services.tasks.get(ask.taskId ?? "");
    expect(asked?.kind).toBe("operation");
    const card = core.services.supervisor
      .cardsSnapshot()
      .find((c) => c.title === SETUP_CARD_WORDS.title(basename(adoptDir)));
    expect(asked?.gate?.ref).toBe(card?.id);
    await core.dispatch("inf:cards:act", [card?.id ?? "", "add", "chrome"]);
    await waitFor(() => core.services.repos.list().some((r) => r.path === adoptDir), 30_000);
    expect(core.services.tasks.get(ask.taskId ?? "")).toMatchObject({
      status: "done",
      closedReason: "answered",
    });
    const task = core.services.tasks
      .list()
      .find((t) => t.kind === "operation" && /^Set up project /.test(t.title));
    expect(task?.status).toBe("done");
    expect(task?.closedReason).toBe("settled");
    const repoId = task?.repoId ?? "";
    expect(core.services.repos.managesProjectPath(repoId, adoptDir)).toBe(true);
    // Scratch first; the adopted repo's project rides the board with its repo facts.
    const board = await core.dispatch("inf:tasks:board", []);
    expect(board.projects[0]?.id).toBe("scratch");
    expect(board.projects.find((project) => project.id === `proj-${repoId}`)?.repo?.name).toBe(
      core.services.repos.get(repoId)?.name,
    );
  }, 120_000);

  it("answer: a standalone note files a closed question task", async () => {
    const ask = await turn(ANSWER_PROMPT_MARKER);
    expect(ask.attachedVia).toBe("tool:emit_card");
    const task = core.services.tasks.get(ask.taskId ?? "");
    expect(task?.kind).toBe("question");
    expect(task?.status).toBe("done");
    expect(task?.title).toBe(MOCK_ANSWER_TITLE);
    expect(task?.outcome).toBe(MOCK_ANSWER_TEXT);
  }, 120_000);

  it("ask: a task-less decision opens a decision task the captain's choice closes", async () => {
    // The mock Firstmate offers the projects in its context as the choices,
    // and a decision gives two or three, so this case registers both it
    // offers rather than borrowing the one an earlier case adopts.
    await core.services.repos.setup({ kind: "init", name: "capture-decision" });
    await core.services.repos.setup({ kind: "init", name: "capture-decision-other" });
    const ask = await turn(AMBIGUOUS_PROMPT_MARKER);
    expect(ask.attachedVia).toBe("tool:emit_card");
    const task = core.services.tasks.get(ask.taskId ?? "");
    expect(task?.kind).toBe("decision");
    expect(task?.status).toBe("open");
    const cardId = task?.gate?.ref ?? "";
    const card = core.services.supervisor.cardsSnapshot().find((c) => c.id === cardId);
    expect(card?.actions.length).toBeGreaterThan(0);
    const choice = card?.actions.find((action) => action.id !== "later");
    await core.dispatch("inf:cards:act", [cardId, choice?.id ?? "", "chrome"]);
    const closed = core.services.tasks.get(task?.id ?? "");
    expect(closed?.status).toBe("done");
    expect(closed?.closedReason).toBe("answered");
    // The choice returns to the Firstmate as a turn of its own; the case ends
    // once that turn has, so nothing it writes outlives the case.
    const returned = captainCardChoice(
      { id: cardId, title: card?.title ?? "", taskId: task?.id ?? "" },
      { id: choice?.id ?? "", label: choice?.label ?? "" },
    );
    await waitFor(
      () =>
        mock.requestBodies().some((body) => {
          const served = latestServedTurn(body);
          return served !== undefined && holdsSegment(served, returned);
        }) && !core.services.firstmate.isBusy(),
      60_000,
    );
  }, 120_000);

  it("crewmate journey: spawn, steer, a hinted turn and settle land on its task, and the protocol carries that record", async () => {
    const title = "Fix the flaky test";
    const taskId = await section("spawn: the ask lands on the new work task", async () => {
      const ask = await turn(`${SPAWN_PROMPT_MARKER} ${title}`);
      expect(ask.attachedVia).toBe("tool:spawn_crewmate");
      const task = core.services.tasks.get(ask.taskId ?? "");
      expect(task?.kind).toBe("work");
      expect(task?.title).toBe(title);
      expect(await crewIdle(title)).toBe(task?.id);
      return task?.id ?? "";
    });

    await section("steer: guidance lands on the task it names", async () => {
      const ask = await turn(`${STEER_PROMPT_MARKER}${title}: add a regression test`);
      expect(ask.attachedVia).toBe("tool:steer_crewmate");
      expect(ask.taskId).toBe(taskId);
      const steered = core.services.tasks
        .timeline(taskId)
        .filter((event) => event.kind === "ask")
        .map((event) => event.text);
      expect(steered).toContain(`${STEER_PROMPT_MARKER}${title}: add a regression test`);
      expect(await crewIdle(title)).toBe(taskId);
    });

    await section(
      "hinted fallback: a turn that names a task and does nothing lands on it",
      async () => {
        const ask = await turn({ text: "how is this going?", taskId });
        expect(ask.hintTaskId).toBe(taskId);
        expect(ask.taskId).toBe(taskId);
        expect(ask.attachedVia).toBe("host:fallback");
      },
    );

    await section("settle: landing an idle crewmate lands on the task it names", async () => {
      expect(await crewIdle(title)).toBe(taskId);
      const ask = await turn(`${FINISH_PROMPT_MARKER}${title}`);
      expect(ask.attachedVia).toBe("tool:settle_task");
      expect(ask.taskId).toBe(taskId);
      // WI-11 retired `finish`: an idle crewmate is settled by landing it. The
      // scratch task's branch has nothing new, so the land is a clean
      // fast-forward that closes the record and removes the real git worktree;
      // under a loaded full-suite run that took over 30s once, so the wait
      // matches crewIdle's window.
      await waitFor(() => core.services.tasks.get(taskId)?.workspaceState === "removed", 60_000);
      expect(core.services.tasks.get(taskId)).toMatchObject({
        status: "done",
        closedReason: "landed",
      });
      // The retired worktree goes back to the warm pool, not the trash.
      await core.services.workspace.poolSettled();
      expect(core.services.workspace.pooledTrees()).toHaveLength(1);
    });

    /**
     * The task protocol through the real core (task-system P3, design section
     * 9): the board a client resyncs from equals what the emitter pushed, the
     * detail carries the timeline the parts above wrote, and the feed is a
     * view over that timeline, keyed to the task.
     */
    await section(
      "protocol: the pushed board equals a fresh read, the detail and feed carry the record",
      async () => {
        // The landed task: no longer crew, still a record with a key.
        const key = core.services.tasks.get(taskId)?.key ?? "";
        expect(core.services.tasks.byKey(key)?.id).toBe(taskId);
        const boards: TaskBoard[] = [];
        const events: FmEvent[] = [];
        let fresh: TaskBoard | undefined;
        const detach = core.events.subscribe((channel, payload) => {
          if (channel === "inf:tasks") boards.push(payload as TaskBoard);
          if (channel === "inf:event") events.push(payload as FmEvent);
        });
        try {
          // A mutation the Firstmate would make: the board push that follows is
          // the snapshot rebuilt after the commit.
          core.services.tasks.noteProgress(taskId, "protocol probe", "host");
          await waitFor(() => boards.length > 0);
          const pushed = boards.at(-1) as TaskBoard;
          fresh = await core.dispatch("inf:tasks:board", []);
          expect(fresh.seq).toBe(pushed.seq);
          expect({ ...fresh, at: 0 }).toEqual({ ...pushed, at: 0 });
          const view = fresh.tasks.find((task) => task.id === taskId);
          expect(view).toMatchObject({
            key,
            kind: "work",
            status: "done",
            closedReason: "landed",
            assignee: "crewmate 1",
            flags: { blocked: false, held: false, needsYou: false, ready: false },
          });
          // Scratch first, then a project for each managed repo.
          expect(fresh.projects.map((project) => project.id)).toEqual([
            "scratch",
            ...core.services.repos.list().map((repo) => `proj-${repo.id}`),
          ]);
          expect(
            events.some((event) => event.type === "task_changed" && event.taskId === taskId),
          ).toBe(true);
          expect(
            events.find((event) => event.type === "task_event" && event.taskId === taskId),
          ).toMatchObject({ key, kind: "progress", text: "protocol probe", feed: false });
        } finally {
          detach();
        }
        const detail = await core.dispatch("inf:tasks:detail", [taskId]);
        expect(detail.brief.length).toBeGreaterThan(0);
        expect(detail.intent?.userWords).toContain(title);
        const kinds = detail.events.map((event) => event.kind);
        // The dispatch's quiet line about its working copy follows `dispatched`.
        expect(kinds.slice(0, 6)).toEqual([
          "created",
          "dispatched",
          "note",
          "briefed",
          "ask",
          "report",
        ]);
        expect(detail.events[2]?.text).toBe(
          "a new working copy was made, starting from the project's current commit",
        );
        // The landing close, then its clean worktree retiring (WI-7), then the probe.
        expect(kinds.slice(-3)).toEqual(["landed", "note", "progress"]);
        expect(detail.asks.map((ask) => ask.attachedVia)).toEqual([
          "tool:spawn_crewmate",
          "tool:steer_crewmate",
          "host:fallback",
          "tool:settle_task",
        ]);
        await expect(core.dispatch("inf:tasks:detail", ["nope"])).rejects.toThrow(
          'Unknown task "nope"',
        );
        expect(await core.dispatch("inf:projects:list", [])).toEqual(fresh?.projects);
        // The feed reads the timeline back: the lines the runtime used to author
        // now come from the record, prefixed by its key.
        const feed = await core.dispatch("inf:feed:recent", []);
        const keyed = feed.filter((line) => line.taskKey === key).map((line) => line.text);
        expect(keyed).toContain("Started");
        expect(keyed.some((text) => text.startsWith("Reported"))).toBe(true);
        // WI-11 retired `finish`: the idle crewmate was settled by a land, so its
        // close reads as the landing, not a decommission.
        expect(keyed.some((text) => text === "Merged")).toBe(true);
        // Task-less lines still ride beside them, unkeyed, and no line appears twice.
        expect(
          feed.some((line) => line.taskKey === undefined && line.text.startsWith("Captain: ")),
        ).toBe(true);
        expect(new Set(feed.map((line) => `${line.at}|${line.text}`)).size).toBe(feed.length);
      },
    );
  }, 120_000);

  it("nothing: a turn with no tool call files a question task with the closing text", async () => {
    const ask = await turn("hello there, all well?");
    expect(ask.attachedVia).toBe("host:fallback");
    const task = core.services.tasks.get(ask.taskId ?? "");
    expect(task?.kind).toBe("question");
    expect(task?.title).toBe("hello there, all well?");
    expect(task?.outcome).toBe(MOCK_FM_CHAT_TEXT);
  }, 120_000);
});

describe("the dev-only local orchestrator (roadmap 1.7)", () => {
  const LINE =
    "Your first mate is running on local-test at 127.0.0.1:9 for this dev checkout; crewmates route as usual.";
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  async function boot(
    packaged: boolean,
    environment = true,
    extra: Partial<HostCapabilities> = {},
  ): Promise<Core> {
    userDataDir = scratchDir("infinitary-core-local-");
    quotaDir = scratchDir("infinitary-core-local-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    if (environment) {
      process.env.INFINITARY_LOCAL_ORCHESTRATOR_URL = "http://127.0.0.1:9/v1";
      process.env.INFINITARY_LOCAL_ORCHESTRATOR_MODEL = "local-test";
    }
    core = await startCore({ ...fakeHost(userDataDir, packaged).host, ...extra });
    return core;
  }

  afterEach(async () => {
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
    delete process.env.INFINITARY_LOCAL_ORCHESTRATOR_URL;
    delete process.env.INFINITARY_LOCAL_ORCHESTRATOR_MODEL;
  });

  it("an unpackaged checkout seats the Firstmate on the named model: the gate closes and the feed says where", async () => {
    const booted = await boot(false);
    const feed = await booted.dispatch("inf:feed:recent", []);
    expect(feed.map((line) => line.text)).toContain(LINE);
    expect(feed.map((line) => line.text)).not.toContain(`First mate · note: ${LINE}`);
    // No account, no custom provider in the app's own models.json - only
    // the seat can answer, and that closes the first-run gate.
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(false);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator", "models.json"))).toBe(true);
    expect(existsSync(join(userDataDir, "auth", "models.json"))).toBe(false);
  }, 60_000);

  it("every build keeps task browsers on a host that has one, and a host with none keeps none", async () => {
    // The captain lifted the development gate (2026-10-07): an installed
    // build keeps task browsers exactly as a development one does. Only a
    // host with no browser engine keeps none.
    for (const { packaged, hasBrowser } of [
      { packaged: true, hasBrowser: true },
      { packaged: false, hasBrowser: true },
      { packaged: true, hasBrowser: false },
    ]) {
      let opened = 0;
      const proxies: { host: string; port: number }[] = [];
      const browser: HostTaskBrowser = {
        open: async (input) => {
          opened += 1;
          proxies.push({ host: input.proxy.host, port: input.proxy.port });
          throw new Error("this test makes no page");
        },
      };
      const booted = await boot(packaged, false, hasBrowser ? { browser } : {});
      // A core with task browsers hands a crewmate one, so its five tools are served.
      expect(booted.services.browsers !== undefined).toBe(hasBrowser);
      if (hasBrowser) {
        const answer = await booted.services.browsers
          ?.forTask("t1")
          .navigate({ url: "http://localhost:5173/" });
        expect(answer?.text).toBe(
          "This computer could not open a browser for this task right now.",
        );
        // Public websites (piece 5): the page's every connection off this
        // Mac goes through a guard listening on loopback, which goes with a
        // browser that did not open, so nothing is left listening.
        expect(proxies).toEqual([{ host: "127.0.0.1", port: expect.any(Number) }]);
        expect(await listening(proxies[0]?.port ?? 0)).toBe(false);
      }
      expect(opened).toBe(hasBrowser ? 1 : 0);
      // The captain's view of a task's browser (piece 2): Stop browser and
      // Open again reach a task browser wherever the host has one.
      expect(await booted.dispatch("inf:browser:stop", ["t1"])).toEqual(
        hasBrowser
          ? { ok: false, text: "This task's browser is not running." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(await booted.dispatch("inf:browser:reopen", ["t1"])).toEqual(
        hasBrowser
          ? { ok: false, text: "This task has no browser to open again." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      // Taking control and handing it back (piece 4) do too.
      const handle = { session: "run-1", generation: 1 };
      expect(await booted.dispatch("inf:browser:take", ["t1", handle])).toEqual(
        hasBrowser
          ? { ok: false, text: "This browser is no longer running, so there is nothing to take." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(await booted.dispatch("inf:browser:return", ["t1", handle])).toEqual(
        hasBrowser
          ? {
              ok: false,
              text: "This browser is no longer running, so there is nothing to return.",
            }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      // Saved website sign-ins (piece 6): Settings lists them wherever the
      // Mac keeps task browsers, in a folder of their own that nothing
      // writes until the captain ticks Remember.
      expect(await booted.dispatch("inf:browser:sign-ins", [])).toEqual({
        available: hasBrowser,
        signIns: [],
      });
      expect(await booted.dispatch("inf:browser:sign-ins:remove", ["aurora.example"])).toEqual(
        hasBrowser
          ? { ok: false, text: "No sign-in for aurora.example is saved on this computer." }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(
        await booted.dispatch("inf:browser:return", ["t1", handle, { remember: true }]),
      ).toEqual(
        hasBrowser
          ? {
              ok: false,
              text: "This browser is no longer running, so there is nothing to return.",
            }
          : { ok: false, text: "This computer keeps no task browsers." },
      );
      expect(existsSync(join(userDataDir, "web-sign-ins"))).toBe(false);
      expect(opened).toBe(hasBrowser ? 1 : 0);
      // A card's door to the browser (piece 3) needs a browser to name: a
      // crewmate is handed one only from this core's browsers, and only
      // with one does its emit_card offer browser_button.
      const emitCard = bindTool(EMIT_CARD_TOOL, {
        onCard: () => "card-t1-1",
        ...(booted.services.browsers ? { browser: booted.services.browsers.forTask("t1") } : {}),
      });
      expect(Object.hasOwn(emitCard.parameters.properties, "browser_button")).toBe(hasBrowser);
      // So does its request that the captain take the browser over.
      expect(Object.hasOwn(emitCard.parameters.properties, "browser_handoff")).toBe(hasBrowser);
      booted.dispose();
      core = undefined;
      await catalogRefreshesSettled();
    }
  });

  it("every build offers every device channel and card, packaged or not", async () => {
    for (const packaged of [true, false]) {
      const booted = await boot(packaged, false);
      // + A phone too, now the phone app is on TestFlight (the captain's
      // "Show it now, as you chose for TestFlight", INF-279).
      expect(await booted.dispatch("inf:devices:shown", [])).toEqual({
        shown: true,
      });
      // Joining by a command: another user on this Mac runs this one.
      await expect(
        booted.dispatch("inf:devices:invite", [{ kind: "work", command: "another-user" }]),
      ).resolves.toMatchObject({
        kind: "work",
        command: {
          for: "another-user",
          text: expect.stringContaining("'work' 'join' 'infinitary://join?as=work"),
        },
      });
      // A development copy, outside an app bundle, cannot send itself to
      // another computer; an installed release sends the Firstmate published
      // for that computer's system (docs/devices.md, "Firstmate for another
      // system"). A command adds only a computer that runs work.
      if (packaged)
        await expect(
          booted.dispatch("inf:devices:invite", [{ kind: "mac", command: "another-mac" }]),
        ).resolves.toMatchObject({ kind: "mac", command: { for: "another-mac" } });
      else
        await expect(
          booted.dispatch("inf:devices:invite", [{ kind: "mac", command: "another-mac" }]),
        ).rejects.toThrow("cannot send itself to another computer");
      await expect(
        booted.dispatch("inf:devices:invite", [{ kind: "mac", command: "another-user" }]),
      ).rejects.toThrow(
        "Only the command for another user on this computer adds one that only runs work",
      );
      await expect(
        booted.dispatch("inf:devices:invite", [{ kind: "work", command: "another-mac" }]),
      ).rejects.toThrow(
        "Only the command for another user on this computer adds one that only runs work",
      );
      // No new link makes a Mac that only controls.
      await expect(booted.dispatch("inf:devices:invite", [{ kind: "view" }])).rejects.toThrow(
        "A new link adds a computer that can control your first mate and run work",
      );
      expect(await booted.dispatch("inf:devices:list", [])).toEqual([]);
      expect(booted.services.appBundle()).toBeNull();
      await expect(booted.dispatch("inf:devices:keep", ["mini"])).rejects.toThrow(
        "No device with that id",
      );
      // Adding a computer by its address, its yes to leaving another
      // Firstmate there, and updating Firstmate there: a development copy
      // reaches no computer. An installed release asks the computer's system
      // first, so it is not asked here, where it would reach the network.
      if (!packaged) {
        await expect(booted.dispatch("inf:devices:add", ["sam@mini.local"])).rejects.toThrow(
          "This copy of Infinitary cannot send itself to another computer.",
        );
        await expect(
          booted.dispatch("inf:devices:add", ["sam@mini.local", { leave: true }]),
        ).rejects.toThrow("This copy of Infinitary cannot send itself to another computer.");
      }
      await expect(booted.dispatch("inf:devices:update", ["mini"])).rejects.toThrow(
        "No device with that id",
      );
      await expect(booted.dispatch("inf:devices:add", ["-oProxyCommand=x"])).rejects.toThrow();
      // This Mac's own SSH connections: the core starts none by itself -
      // only the shell does, once it attached the paired connection.
      await expect(booted.dispatch("inf:devices:try-again", [])).resolves.toEqual({ tried: 0 });
      await expect(
        booted.dispatch("inf:devices:change-address", ["mini", "sam@studio.local"]),
      ).rejects.toThrow("No device with that id");
      expect(booted.services.sshConnections.state("mini")).toBeUndefined();
      // A computer's own sign-in where projects live, asked whole.
      await expect(
        booted.dispatch("inf:devices:forge-sign-in", ["mini", "github.com"]),
      ).rejects.toThrow("No computer that runs work has that id");
      // A crewmate's conversation on a computer that runs work: every work
      // request is read, here refused only for its malformed request.
      const device = { kind: "device" as const, deviceId: "mini" };
      for (const channel of WORK_INVOKE_CHANNELS)
        await expect(
          booted.dispatch(channel, [{ task: "t1", callId: "c1" }], device),
        ).rejects.toThrow(`Rejected ${channel}: malformed request`);
      // A task whose record places it on such a computer never runs here
      // instead; no computer is ever in reach, and no Mac controls this
      // Firstmate, before the shell attaches the connection.
      seedTask(booted.services.tasks, {
        id: "t-placed",
        title: "website",
        status: "queued",
        deviceId: "mini",
      });
      await booted.services.supervisor.dispatchQueuedTask("t-placed");
      expect(booted.services.tasks.get("t-placed")?.status).toBe("open");
      expect(booted.services.workDevices.inReach("mini")).toBe(false);
      expect(booted.services.workDevices.controlling("mini")).toBe(false);
      expect((booted.services.placed as PlacedSessions).factories("mini")).toBeDefined();
      // A working copy asked of that computer, or an artifact written there,
      // is refused only while it is out of reach.
      const placed = booted.services.placed as PlacedSessions;
      const prepared = placed.prepare("mini", "t-placed", null);
      const written = placed.copies.writeArtifact("t-placed", "mini", {
        runId: 1,
        artifactId: 1,
        bytes: new Uint8Array([1]),
      });
      await Promise.all(
        [prepared, written].map((asked) =>
          expect(asked).rejects.toThrow("That computer is out of reach, so nothing was sent."),
        ),
      );
      // What a task this Mac no longer records left there is removed once
      // that computer is in reach.
      const orders: string[] = [];
      const detach = booted.services.workDevices.attach({
        ask: async (_deviceId, channel) => {
          orders.push(channel);
          // Asked its sign-ins, it says it is signed in to Claude alone.
          if (channel === "inf:sign-ins:list")
            return {
              providers: [],
              accounts: [
                {
                  id: "acct_claude_there",
                  providerId: "anthropic-claude",
                  kind: "subscription_oauth",
                  label: "Claude",
                  enabled: true,
                  connected: true,
                  pinned: false,
                  createdAt: 1,
                },
                // And to Codex, which its own turn found signed out there.
                {
                  id: "acct_codex_there",
                  providerId: "openai-codex",
                  kind: "subscription_oauth",
                  label: "Codex",
                  enabled: true,
                  connected: true,
                  pinned: true,
                  createdAt: 1,
                  cutOff: { class: "signed_out", since: 1 },
                },
              ],
              quota: null,
            };
          throw new Error("This test holds no computer.");
        },
        onWorkDevice: (listener) => {
          listener({ deviceId: "mini", contact: "in-reach" });
          return () => {};
        },
        onViewDevice: () => () => {},
      });
      await placed.copies.retireLeftover("mini", "t-gone");
      // A task there is routed among that computer's own sign-ins alone.
      const served = await placed.served("mini");
      expect(served.available).toContainEqual({
        provider: "anthropic-claude",
        id: "claude-sonnet-5-5",
      });
      expect(served.available.every((model) => model.provider === "anthropic-claude")).toBe(true);
      expect(served.accounts.get("anthropic-claude")).toBe("acct_claude_there");
      // A cut-off its sign-ins name is read: the cut-off sign-in is skipped,
      // and Claude there still serves, so nothing waits.
      expect(placed.cutOffOf("acct_codex_there@mini")?.class).toBe("signed_out");
      expect(placed.accountPlace("acct_codex_there@mini")).toEqual({
        provider: "Codex",
        where: "on the other computer",
      });
      expect(placed.signInWait("mini")).toBeUndefined();
      detach();
      expect(orders.includes("inf:session:close")).toBe(true);
      expect(orders.includes("inf:sign-ins:list")).toBe(true);
      const offered: string[] = [];
      const tools = createAppTools({
        dispatch: booted.dispatch,
        actor: () => ({ kind: "firstmate", wake: "captain" }),
        handover: (_target, offer) => {
          offered.push(offer.cardId);
          return "offered";
        },
      });
      const catalog = JSON.parse(
        (await tools.find((tool) => tool.name === "app_state")?.run({ area: "general" }))?.text ??
          "[]",
      ) as { action: string }[];
      for (const action of ["device-invite", "device-remove", "device-address", "device-update"])
        expect(catalog.some((line) => line.action === action)).toBe(true);
      // Signing a computer that runs work in to its own subscriptions.
      const intelligence = JSON.parse(
        (await tools.find((tool) => tool.name === "app_state")?.run({ area: "intelligence" }))
          ?.text ?? "[]",
      ) as { action: string }[];
      expect(intelligence.some((line) => line.action === "device-sign-in")).toBe(true);
      expect(await booted.dispatch("inf:devices:sign-ins", [])).toEqual([]);
      // Each device line offers its card, and the captain's click alone acts.
      const change = tools.find((tool) => tool.name === "app_change");
      for (const [value, evidence] of [
        [{ name: "MacBook Air" }, "connect my MacBook Air"],
        [{ how: "another-user" }, "run work as another user on this computer"],
        [{ how: "address", address: "sam@mini.local" }, "add my mini at sam@mini.local"],
      ] as const) {
        const asked = await change?.run({ action: "device-invite", value, evidence });
        expect(asked?.text, evidence).toBe("offered");
      }
      const signIn = await change?.run({
        action: "device-sign-in",
        value: { deviceId: "mini", provider: "openai-codex" },
        evidence: "sign in to codex on the mini",
      });
      expect(signIn?.text).toBe(
        "No computer that runs work has that deviceId. Look with app_state.",
      );
      // A project's Runs on is offered to the Firstmate and asked by the captain.
      const projects = JSON.parse(
        (await tools.find((tool) => tool.name === "app_state")?.run({ area: "projects" }))?.text ??
          "[]",
      ) as { action: string }[];
      expect(projects.some((line) => line.action === "project-runs-on")).toBe(true);
      expect(projects.some((line) => line.action === "project-settings")).toBe(true);
      const { repo } = await booted.dispatch("inf:repos:setup", [
        { kind: "init", name: "website" },
      ]);
      const runsOn = await change?.run({
        action: "project-runs-on",
        value: { repoId: repo.id, deviceId: "mini" },
        evidence: "run website on the mini",
        on_words: true,
      });
      expect(runsOn?.text).toBe(
        "No computer that runs work has that deviceId. Look with app_state.",
      );
      await expect(booted.dispatch("inf:devices:runs-on", [repo.id, null])).resolves.toMatchObject({
        id: repo.id,
        runsOn: null,
      });
      expect(
        (await booted.dispatch("inf:repos:list", [])).every((entry) => entry.runsOn === null),
      ).toBe(true);
      expect(offered).toEqual(["app-device-invite", "app-device-invite", "app-device-invite"]);
      // Devices says of a Mac a command added that macOS holds it on the
      // local network.
      const key = createKeyIdentity("Mac mini");
      const held = booted.services.devices.claim(
        {
          code: parsePairingLink(booted.services.devices.invite({ kind: "work" }).link).code,
          kind: "work",
          name: "Mac mini",
          user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1 },
        },
        {
          headers: {},
          socket: {
            remoteAddress: "192.168.4.30",
            localAddress: "192.168.4.48",
            localPort: CONNECTION_PORT,
            getPeerX509Certificate: () => new X509Certificate(key.cert),
          },
        } as unknown as IncomingMessage,
      );
      if (!held.ok) throw new Error(held.reason);
      expect(await booted.dispatch("inf:devices:list", [])).toEqual([
        expect.objectContaining({ id: held.grant.deviceId, heldOnLocalNetwork: true }),
      ]);
      booted.dispose();
      core = undefined;
      await catalogRefreshesSettled();
    }
  }, 60_000);

  it("a packaged build cannot enable it: the same environment seats nothing, the Settings control is absent, and the write is refused", async () => {
    const booted = await boot(true);
    const feed = await booted.dispatch("inf:feed:recent", []);
    expect(feed.map((line) => line.text)).not.toContain(LINE);
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator"))).toBe(false);
    // The Settings side of the same choice: the view says there is no
    // control, and the write a control would make is refused outright.
    expect(await booted.dispatch("inf:settings:local-orchestrator:get", [])).toEqual({
      available: false,
      setting: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "" },
      active: null,
      problem: null,
    });
    await expect(
      booted.dispatch("inf:settings:local-orchestrator:set", [
        { enabled: true, baseUrl: "http://127.0.0.1:9/v1", model: "local-test" },
      ]),
    ).rejects.toThrow(/packaged build has none/);
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator"))).toBe(false);
  }, 60_000);

  it("an unpackaged checkout seats the Firstmate from the Settings row, and unseats it: the gate follows", async () => {
    // No environment at all: the row is the only way to ask for the seat.
    const booted = await boot(false, false);
    const before = await booted.dispatch("inf:settings:local-orchestrator:get", []);
    expect(before).toMatchObject({ available: true, active: null, problem: null });
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    const on = await booted.dispatch("inf:settings:local-orchestrator:set", [
      { enabled: true, baseUrl: "http://127.0.0.1:9/v1/", model: " local-test " },
    ]);
    expect(on).toEqual({
      available: true,
      setting: { enabled: true, baseUrl: "http://127.0.0.1:9/v1/", model: "local-test" },
      active: { model: "local-test", host: "127.0.0.1:9", source: "setting" },
      problem: null,
    });
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(false);
    expect(existsSync(join(userDataDir, "dev", "local-orchestrator", "models.json"))).toBe(true);
    const feedOn = await booted.dispatch("inf:feed:recent", []);
    expect(feedOn.map((line) => line.text)).toContain(LINE);
    expect(feedOn.map((line) => line.text)).not.toContain(`First mate · note: ${LINE}`);
    const off = await booted.dispatch("inf:settings:local-orchestrator:set", [
      { enabled: false, baseUrl: "http://127.0.0.1:9/v1/", model: "local-test" },
    ]);
    expect(off.active).toBeNull();
    expect((await booted.dispatch("inf:app:first-run", [])).gateOpen).toBe(true);
    const feedOff = await booted.dispatch("inf:feed:recent", []);
    expect(feedOff.map((line) => line.text)).toContain(
      "Your first mate is back on its usual model; the local seat is off.",
    );
  }, 60_000);
});

/**
 * One switch for every plugin, and safe mode counts them all (one plugin
 * vehicle, Phase A, the captain's A3a): a panel the captain added comes up
 * off after two launches that never settled, exactly like his own, and the
 * switch in Settings brings both back. The record of what he added is
 * untouched by the switch.
 */
describe("safe mode takes back the panels the captain added", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  afterEach(async () => {
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("boots an added panel off with the captain's own, then serves both again on the switch", async () => {
    userDataDir = scratchDir("infinitary-core-safe-");
    quotaDir = scratchDir("infinitary-core-safe-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    // An added panel as the installer leaves one - its files and its
    // record through the record's one writer - beside one of his own, and
    // a launch record that says the last launch did not settle either.
    const panel =
      'import type { PanelProps } from "@firstmate/contracts";\nexport default (props: PanelProps) => props.id;\n';
    const added = join(userDataDir, "plugins", "meter");
    mkdirSync(added, { recursive: true });
    writeFileSync(
      join(added, "manifest.json"),
      JSON.stringify({ name: "Acme", version: "1.0.0", title: "Meter", sql: ["v_usage_v1"] }),
    );
    writeFileSync(join(added, "panel.tsx"), panel);
    const own = join(userDataDir, "fleet", "personal", "clock");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "panel.tsx"), panel);
    const db = openDatabase(userDataDir);
    new PluginRecords(db).commit("meter", {
      source: "path",
      spec: "/somewhere/meter",
      pinned: "sha256:0",
      name: "Acme",
      version: "1.0.0",
      title: "Meter",
      capabilities: { sql: ["v_usage_v1"] },
      stagedAt: 1,
    });
    new SettingsStore(db).setLaunchRecord({ pending: true, earlyCrashes: 1 });
    db.close();

    core = await startCore(fakeHost(userDataDir).host);
    const listed = async () =>
      (await core?.dispatch("inf:plugins:personal:list", []))?.extensions.map(
        (view) => `${view.source}:${view.id}`,
      );
    expect(await core.dispatch("inf:shell:preferences", [])).toMatchObject({
      panels: { enabled: false, offReason: "safe-mode" },
    });
    expect(await listed()).toEqual([]);

    await core.dispatch("inf:settings:panels:set", [true]);
    await waitFor(() => core?.services.personal.snapshot().extensions.length === 2, 10_000);
    expect(await listed()).toEqual(["yours:clock", "installed:meter"]);
  });
});

/**
 * The knowledge browser's reads at the protocol (docs/knowledge.md, "The
 * browser"): installed stable and alpha builds answer them, scoped and
 * counted, and a read makes no file of its own. Only this Mac's window
 * asks these browser reads.
 */
describe("the knowledge browser's reads, gated at the protocol", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  async function boot(version: string): Promise<Core> {
    userDataDir = scratchDir("infinitary-core-knowledge-");
    quotaDir = scratchDir("infinitary-core-knowledge-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    const { host } = fakeHost(userDataDir, true);
    core = await startCore({ ...host, app: { ...host.app, version } });
    return core;
  }

  afterEach(async () => {
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  const READS = [
    ["inf:knowledge:collections", []],
    ["inf:knowledge:graph", [{ scope: "captain" }]],
    ["inf:knowledge:concepts", [{ scope: "captain" }]],
    ["inf:knowledge:findings", [{ scope: "captain", filter: "recheck" }]],
    ["inf:knowledge:entry", [{ id: "c-abcdef" }]],
    ["inf:knowledge:directions", [{ scope: "captain" }]],
    ["inf:knowledge:refs", [{ ids: ["f-abcdef"] }]],
    ["inf:knowledge:uses", [{ task: "t-1" }]],
  ] as const;

  it("a stable build answers every Knowledge read", async () => {
    const booted = await boot("0.2.0");
    expect(await booted.dispatch("inf:knowledge:enabled", [])).toEqual({
      enabled: true,
      held: false,
    });
    for (const [channel, args] of READS) {
      await expect(booted.dispatch(channel, [...args] as never)).resolves.toHaveProperty("state");
      // Only this Mac's own window asks them; a view of another Mac reads none.
      expect(invokeContract[channel].reach).toBe("home");
    }
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
  }, 60_000);

  it("an alpha answers them, and reading them makes no collection file", async () => {
    const booted = await boot("0.2.0-alpha.1");
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
    // Nothing recorded yet: the build keeps knowledge, and has none to show.
    expect(await booted.dispatch("inf:knowledge:enabled", [])).toEqual({
      enabled: true,
      held: false,
    });
    expect(await booted.dispatch("inf:knowledge:collections", [])).toEqual({
      state: "ready",
      collections: [
        {
          scope: "captain",
          name: "",
          private: true,
          concepts: 0,
          findings: 0,
          directions: 0,
        },
        // The personal workspace is a project from the first start, so a
        // panel instruction can be a direction scoped to it (INF-1054).
        {
          scope: expect.any(String),
          name: PERSONAL_WORKSPACE_NAME,
          private: false,
          concepts: 0,
          findings: 0,
          directions: 0,
        },
      ],
    });
    // Reading makes nothing: the first write makes the collection's file.
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
    expect(await booted.dispatch("inf:knowledge:entry", [{ id: "c-abcdef" }])).toEqual({
      state: "missing",
    });
    expect(await booted.dispatch("inf:knowledge:refs", [{ ids: ["f-abcdef"] }])).toEqual({
      state: "ready",
      refs: [],
    });
    expect(await booted.dispatch("inf:knowledge:uses", [{ task: "t-1" }])).toEqual({
      state: "ready",
      uses: [],
      total: 0,
    });
    expect(existsSync(join(userDataDir, "knowledge"))).toBe(false);
    await expect(
      booted.dispatch("inf:knowledge:graph", [{ scope: "repo-elsewhere" }]),
    ).rejects.toThrow("No collection repo-elsewhere");
  }, 60_000);
});

/**
 * The idle ladder's clock survives the app closing (the captain's Q8,
 * "durable next tick"): a record the ladder should already have acted on
 * while the app was shut acts at boot, from its saved clock and rung, once.
 * Driven through the real boot - migrations, the task writer, the boot
 * sweep - and the protocol a client reads cards through.
 */
describe("the idle ladder across a restart", () => {
  let core: Core | undefined;
  let userDataDir: string;
  let quotaDir: string;

  afterEach(async () => {
    // Keep userData until the crew, the pool's background reset of the
    // dropped task's working copy, and its trash deletion have finished:
    // git still reading a tree this removes logs a late failure.
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  it("raises the overdue stall card at boot, once, and its Discard ends the task", async () => {
    userDataDir = scratchDir("infinitary-core-idle-");
    quotaDir = scratchDir("infinitary-core-idle-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    // It holds a working copy, so boot reads it as dispatched, not as a
    // claim that never started: a real checkout, made the way a dispatch
    // makes one, so dropping the task can retire it.
    const tree = await new WorkspaceService(appPathsFor(userDataDir), {
      pool: false,
    }).createTaskWorktree("stuck-task");
    // A crewmate idle for an hour and a half when the app last closed; the
    // ladder had nudged it and sent both wakes, the second 35 minutes ago.
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    seedTask(tasks, {
      id: "stuck-task",
      title: "Tidy the docs",
      status: "completed",
      repoDir: tree.repoDir,
      worktreeDir: tree.cwd,
      branch: tree.branch,
    });
    const now = Date.now();
    tasks.recordRecovery("stuck-task", {
      rung: 2,
      count: 2,
      at: now - 35 * 60_000,
      idleSince: now - 90 * 60_000,
    });
    db.close();

    core = await startCore(fakeHost(userDataDir).host);
    const booted = core;
    const stallCards = async () =>
      (await booted.dispatch("inf:cards:list", [])).filter(
        (card) => card.id === "card-stall-stuck-task",
      );
    await waitFor(() => booted.services.supervisor.cardsSnapshot().length > 0, 10_000);
    const [card] = await stallCards();
    expect(card).toMatchObject({
      taskId: "stuck-task",
      author: "host",
      title: "Tidy the docs has been stuck for 1h 30m",
    });
    expect(booted.services.tasks.get("stuck-task")).toMatchObject({ recoveryRung: 3 });
    // The next tick changes nothing: the card holds the turn.
    booted.services.supervisor.reconcileIdle(Date.now());
    expect(await stallCards()).toHaveLength(1);

    await booted.dispatch("inf:cards:act", ["card-stall-stuck-task", "discard", "chrome"]);
    await waitFor(() => booted.services.tasks.get("stuck-task")?.status === "dropped", 10_000);
    expect(booted.services.tasks.get("stuck-task")?.closedReason).toBe("discarded");
    expect(await stallCards()).toEqual([]);
    // The close retires the working copy after the row reads dropped; a
    // copy whose save failed would stay present.
    await waitFor(
      () => booted.services.tasks.get("stuck-task")?.workspaceState === "removed",
      10_000,
    );
    expect(existsSync(tree.cwd)).toBe(false);
  }, 60_000);
});

/**
 * The microphone note an earlier version raised on the first hold to talk
 * is a line under the input now (docs/composer.md, "Voice"): one still on
 * the stack comes down at the next launch.
 */
describe("a microphone card an earlier version left", () => {
  let core: Core | undefined;
  let userDataDir: string;

  afterEach(async () => {
    await core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("comes down at the next launch", async () => {
    userDataDir = scratchDir("infinitary-core-mic-card-");
    process.env.PI_OFFLINE = "1";
    const earlier = await startCore(fakeHost(userDataDir).host);
    core = earlier;
    earlier.services.supervisor.addSystemNoteCard(
      "card-voice-mic-primer",
      "Microphone access",
      "macOS will ask for microphone access the first time you hold to talk.",
    );
    const ids = async (booted: Core) =>
      (await booted.dispatch("inf:cards:list", [])).map((card) => card.id);
    expect(await ids(earlier)).toContain("card-voice-mic-primer");
    await earlier.dispose();

    const next = await startCore(fakeHost(userDataDir).host);
    core = next;
    expect(await ids(next)).not.toContain("card-voice-mic-primer");
  }, 60_000);
});

/**
 * The connection over the real core (docs/connection.md, docs/devices.md):
 * the core makes links through its own requests, and devices that know only
 * the wire join with them and use what a paired device may.
 */
describe("the connection serves the core to paired devices", () => {
  let userDataDir: string;
  let core: Core;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-connection-");
    process.env.PI_OFFLINE = "1";
    core = await startCore(fakeHost(userDataDir).host);
    at = `127.0.0.1:${await claimedPort()}`;
    connection = startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port: Number(at.split(":")[1]),
    });
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  /** The captain makes a link on this Mac; a device uses it. */
  const pairDevice = async (kind: "view" | "work" = "view", name = "Test Mac") => {
    const { link } = await core.dispatch("inf:devices:invite", [
      { kind: kind === "view" ? "mac" : "work", at },
    ]);
    await connection.settled();
    // A computer that runs work dials loopback here, so it runs as another
    // user than this process, as on the home's own Mac (docs/helper.md); a
    // view is a second app here, at its first launch.
    const user = { name: "builder", uid: (process.getuid?.() ?? 0) + 1 };
    return {
      link,
      grant: await claimLink(
        link,
        kind === "work" ? { kind, name, user } : { ...AT_FIRST_LAUNCH, name },
      ),
    };
  };

  it("listens once paired, numbers each push once for every device, and catches a dropped one up", async () => {
    await connection.settled();
    expect(connection.listening()).toEqual([]);
    const { grant: grantA } = await pairDevice("view", "Mac A");
    const { grant: grantB } = await pairDevice("view", "Mac B");
    const a = await connectClient(grantA);
    const b = await connectClient(grantB);
    expect(await a.invoke("inf:app:healthcheck", [])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...HOME_CAPABILITIES],
    });

    const shows = (id: string) => (push: ReceivedPush) =>
      push.channel === "inf:cards" && (push.payload as Card[]).some((card) => card.id === id);
    const { supervisor } = core.services;
    supervisor.addSystemNoteCard("card-connection-1", "Seen twice", "<p>One</p>");
    const [fromA, fromB] = await Promise.all([
      a.push(shows("card-connection-1")),
      b.push(shows("card-connection-1")),
    ]);
    expect(fromA).toEqual(fromB);

    // One device answers; the other sees the card go.
    await a.invoke("inf:cards:close", ["card-connection-1"]);
    await b.push(
      (push) =>
        push.seq > fromB.seq && push.channel === "inf:cards" && !shows("card-connection-1")(push),
    );
    expect((await b.invoke("inf:cards:list", [])).map((card) => card.id)).not.toContain(
      "card-connection-1",
    );

    // B drops; two cards arrive while it is away; it comes back with its cursor.
    const cursor = b.cursor();
    await b.close();
    supervisor.addSystemNoteCard("card-connection-2", "While away", "<p>Two</p>");
    supervisor.addSystemNoteCard("card-connection-3", "Still away", "<p>Three</p>");
    await a.push(shows("card-connection-3"));
    const back = await connectClient(grantB, { cursor });
    expect(back.welcome).toMatchObject({ catchUp: "replay", epoch: cursor.epoch });
    await a.push((push) => push.seq >= back.welcome.seq);
    const missed = a.pushes.filter((push) => push.seq > cursor.seq && push.seq <= back.welcome.seq);
    expect(back.pushes.filter((push) => push.seq <= back.welcome.seq)).toEqual(missed);
    expect(missed.some(shows("card-connection-2"))).toBe(true);
    expect(missed.some(shows("card-connection-3"))).toBe(true);

    await core.dispatch("inf:devices:remove", [grantA.deviceId]);
    await core.dispatch("inf:devices:remove", [grantB.deviceId]);
    expect(await Promise.all([a.closed, back.closed])).toEqual([
      CONNECTION_CLOSE.unpaired,
      CONNECTION_CLOSE.unpaired,
    ]);
    await connection.settled();
    expect(connection.listening()).toEqual([]);
  });

  it("says in Devices while a Mac that controls this Firstmate is connected, and since when it is out of reach", async () => {
    // The shell attaches the connection to the core's devices, as the app does.
    const unreach = core.services.workDevices.attach(connection);
    const pushed: unknown[] = [];
    const off = core.events.subscribe((channel, payload) => {
      if (channel === "inf:devices") pushed.push(payload);
    });
    try {
      const { grant } = await pairDevice("view", "MacBook Air");
      const listed = async () =>
        (await core.dispatch("inf:devices:list", [])).find(
          (device) => device.id === grant.deviceId,
        );
      // Never connected yet: out of reach, never seen.
      expect(await listed()).toEqual({
        id: grant.deviceId,
        kind: "view",
        name: "MacBook Air",
        pairedAt: expect.any(Number),
        onThisMac: true,
        inReach: false,
        controlling: false,
      });

      // Firstmate opens there: in reach and controlling, pushed to the window.
      const view = await connectClient(grant);
      await expect
        .poll(listed)
        .toMatchObject({ inReach: true, controlling: true, seenAt: expect.any(Number) });
      expect(pushed.at(-1)).toEqual([await listed()]);

      // It quits there: out of reach since then, which pairing keeps for a restart.
      const quit = Date.now();
      await view.close();
      await expect.poll(async () => (await listed())?.controlling).toBe(false);
      const away = await listed();
      expect(away).toMatchObject({ inReach: false, controlling: false });
      expect(away?.seenAt).toBeGreaterThanOrEqual(quit);
      expect(core.services.devices.lastSeen(grant.deviceId)).toBe(away?.seenAt);
      expect(pushed.at(-1)).toEqual([away]);

      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      expect(await core.dispatch("inf:devices:list", [])).toEqual([]);
    } finally {
      off();
      unreach();
    }
  });

  it("answers every read a view may ask intact over the wire, and refuses what stays home", async () => {
    const { grant } = await pairDevice("view", "Mac C");
    const view = await connectClient(grant);
    // Each answer is parsed against its channel's own response schema.
    const reads = VIEW_INVOKE_CHANNELS.filter(
      (channel) =>
        invokeContract[channel].effect === "read" &&
        invokeContract[channel].request.safeParse([]).success,
    );
    expect(reads).toContain("inf:tasks:board");
    for (const channel of reads) await view.invoke(channel, []);

    // A paired view cannot list, invite or remove: a lost Mac adds no other.
    for (const [channel, args] of [
      ["inf:settings:routing:get", []],
      ["inf:devices:list", []],
      ["inf:devices:invite", [{ kind: "mac" }]],
      ["inf:devices:remove", [grant.deviceId]],
    ] as const)
      await expect(view.invoke(channel, [...args])).rejects.toThrow(
        "answered only on the computer where your first mate lives",
      );
    await expect(view.invoke("inf:app:choose-folder", [])).rejects.toThrow(
      "not a request this home answers",
    );
    await expect(view.invoke("inf:cards:act", ["only-one-argument"])).rejects.toThrow(
      "malformed request",
    );
    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    expect(await view.closed).toBe(CONNECTION_CLOSE.unpaired);
  });

  it("shows a view a card's picture, recording and font by name, and says in the feed when a view leaves", async () => {
    const { grant } = await pairDevice("view", "Mac D");
    const view = await connectClient(grant);
    // The home's own copy, where the card picture host keeps it.
    const name = `task-pic-${"a".repeat(32)}.png`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    mkdirSync(join(core.paths.crewmatesDir, "task-pic", "cards"), { recursive: true });
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", name), bytes);
    expect(await view.invoke("inf:cards:picture", [name])).toEqual({
      contentType: "image/png",
      data: bytes.toString("base64"),
    });
    // Only a minted name, and never a path.
    for (const asked of ["../task-pic/cards/x.png", `task-pic-${"b".repeat(32)}.png`])
      await expect(view.invoke("inf:cards:picture", [asked])).rejects.toThrow(/card picture/);
    // A recording, a piece at a time, with the whole file's size; never a picture by that door.
    const recording = `task-pic-${"c".repeat(32)}.mp4`;
    const recorded = Buffer.from(Array.from({ length: 40 }, (_, at) => at));
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", recording), recorded);
    expect(await view.invoke("inf:cards:media", [recording, 10, 5])).toEqual({
      contentType: "video/mp4",
      size: 40,
      data: recorded.subarray(10, 15).toString("base64"),
    });
    expect(await view.invoke("inf:cards:media", [recording, 38, 5])).toMatchObject({
      size: 40,
      data: recorded.subarray(38).toString("base64"),
    });
    expect(await view.invoke("inf:cards:media", [recording, 0, 0])).toMatchObject({
      size: 40,
      data: "",
    });
    for (const asked of [name, `task-pic-${"d".repeat(32)}.mp4`])
      await expect(view.invoke("inf:cards:media", [asked, 0, 1])).rejects.toThrow(/recording/);
    // A project font a preview names (INF-128), whole, by its minted name alone.
    const typeface = `task-pic-${"e".repeat(32)}.woff2`;
    const font = projectFontBytes();
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", typeface), font);
    expect(await view.invoke("inf:cards:typeface", [typeface])).toEqual({
      contentType: "font/woff2",
      data: font.toString("base64"),
    });
    for (const asked of [name, `task-pic-${"f".repeat(32)}.woff2`, "../task-pic/cards/x.woff2"])
      await expect(view.invoke("inf:cards:typeface", [asked])).rejects.toThrow(/card('s)? font/);

    // Leave: the view comes off the list, cut as for a Remove, named in the feed.
    view.sendRaw(JSON.stringify({ t: "leave" }));
    expect(await view.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(core.services.devices.list().map((device) => device.id)).not.toContain(grant.deviceId);
    const feed = await core.dispatch("inf:feed:recent", []);
    expect(feed.map((line) => line.text)).toContain("Mac D left.");
  });

  it("makes a link only for the captain's own window, and keeps it out of everything saved", async () => {
    let wake: "captain" | "other" = "captain";
    const offered: { target: string; offer: HandoverOffer }[] = [];
    const firstmate = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
      handover: (target, offer) => {
        offered.push({ target, offer });
        return `offered ${offer.cardId}`;
      },
    });
    const change = firstmate.find((tool) => tool.name === "app_change");
    const state = firstmate.find((tool) => tool.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");

    // The Firstmate cannot make a link, whatever the captain said: it can
    // only offer the card whose button makes one in Settings -> Devices.
    const asked = await change.run({
      action: "device-invite",
      value: { name: "MacBook Air" },
      evidence: "connect my MacBook Air",
    });
    expect(asked.text).toBe("offered app-device-invite");
    expect(offered).toEqual([
      {
        target: "devices",
        offer: {
          cardId: "app-device-invite",
          title: "Connect your MacBook Air",
          paragraphs: [
            "Your first mate stays on this computer. Your MacBook Air will show it and can run work for it.",
            "Make a link here, then paste it into Infinitary on your MacBook Air.",
            "It works once, for ten minutes. Only your click can make it, so I never see it.",
          ],
          label: "Make a link",
          decline: "Not now",
          arrival: { make: "link" },
        },
      },
    ]);
    expect(core.services.devices.list()).toEqual([]);
    expect(core.services.devices.any()).toBe(false);
    wake = "other";
    expect(
      (await change.run({ action: "device-invite", value: {}, evidence: "a report" })).text,
    ).toContain("stays with the captain");
    expect(offered).toHaveLength(1);
    wake = "captain";

    // The captain's own window can; the feed says a link was made, and who
    // joined, never what the link is.
    const { link, grant } = await pairDevice("work", "Mini");
    const recent = await core.dispatch("inf:feed:recent", []);
    expect(
      recent.some((line) => line.text === "Captain · made a ten-minute link to add a device"),
    ).toBe(true);
    expect(
      recent.some(
        (line) =>
          line.text ===
          deviceJoinedLine({ name: "Mini", kind: "work", user: "builder", onThisMac: true }),
      ),
    ).toBe(true);
    expect(recent.some((line) => line.text.includes(parsePairingLink(link).code))).toBe(false);
    expect(await core.dispatch("inf:devices:list", [])).toEqual([
      {
        id: grant.deviceId,
        kind: "work",
        name: "Mini",
        pairedAt: expect.any(Number),
        user: "builder",
        onThisMac: true,
        // What the home reads of a computer that runs work now: no shell
        // attached the connection to the core's computers here.
        inReach: false,
        tasks: 0,
        runs: [],
      },
    ]);
    const look = JSON.parse((await state.run({ area: "general" })).text) as {
      action: string;
      current: unknown;
    }[];
    expect(look.find((line) => line.action === "device-remove")?.current).toEqual({
      devices: [{ id: grant.deviceId, kind: "work", name: "Mini" }],
    });

    // Removing stays the captain's too: words typed on a paired view reach
    // the Firstmate as the captain's, so it cannot remove a device either.
    // It offers the card, which the host writes from the list itself.
    const work = await connectClient(grant);
    const handed = await change.run({
      action: "device-remove",
      value: { deviceId: grant.deviceId },
      evidence: "remove the mini",
    });
    expect(handed.text).toMatch(/^offered app-device-remove-/);
    expect(offered.at(-1)).toMatchObject({
      target: "devices",
      offer: {
        title: "Remove Running as Builder?",
        label: "Remove Running as Builder",
        danger: true,
        decline: "Keep it",
        arrival: { remove: grant.deviceId },
      },
    });
    expect(
      (
        await change.run({
          action: "device-remove",
          value: { deviceId: "not-a-device" },
          evidence: "remove the mini",
        })
      ).text,
    ).toContain("No device with that id");
    expect(core.services.devices.list()).toHaveLength(1);
    // Out of reach of the core's computers, it is removed now, as the captain chose.
    await expect(core.dispatch("inf:devices:remove", [grant.deviceId])).rejects.toThrow(
      "out of reach",
    );
    await core.dispatch("inf:devices:remove", [grant.deviceId, "now"]);
    expect(await work.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(
      (await core.dispatch("inf:feed:recent", [])).some(
        (line) => line.text === "Captain · Removed Running as Builder.",
      ),
    ).toBe(true);

    // Nothing the home saved holds the link, its code, or the device's own key.
    const { code } = parsePairingLink(link);
    const saved = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? saved(join(dir, entry.name))
          : entry.isFile()
            ? [join(dir, entry.name)]
            : [],
      );
    const deviceKey = grant.key.split("\n")[1] ?? grant.key;
    const holding = saved(userDataDir).filter((file) => {
      const text = readFileSync(file, "latin1");
      return text.includes(code) || text.includes(link) || text.includes(deviceKey);
    });
    expect(holding).toEqual([]);
  });
});

/**
 * Where a development run's connection listens (docs/devices.md, "Where
 * devices find this Mac"): its loopback stand-in, which every e2e launch
 * sets, keeps the link and the listener on 127.0.0.1 at its own port, wired
 * as the app wires it; a packaged build ignores it.
 */
/**
 * INF-1228, the captain's answer control=all: a first mate started by a
 * command has no window, so the computer that controls it does everything
 * that window would, its sign-ins included, and a page it would open in a
 * browser opens there (docs/run.md, "Control from another computer").
 */
describe("a first mate started by a command, controlled from another computer", () => {
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-run-");
    process.env.PI_OFFLINE = "1";
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host, { startedByCommand: true });
    at = `127.0.0.1:${await claimedPort()}`;
    connection = startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port: Number(at.split(":")[1]),
      startedByCommand: true,
    });
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("answers the controlling computer's Settings and opens a page there, never on its own computer", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const view = await connectClient(
      await claimLink(link, { ...AT_FIRST_LAUNCH, name: "MacBook Air" }),
    );
    expect(view.welcome.startedByCommand).toBe(true);
    // A request only its window could ask before.
    expect(await view.invoke("inf:accounts:list", [])).toEqual(
      await core.dispatch("inf:accounts:list", []),
    );

    await core.dispatch("inf:update:open-release", []);
    const page = await view.push((push) => push.channel === "inf:app:open-page");
    expect((page.payload as { url: string }).url).toMatch(/^https:\/\//);
    expect(shell.opened).toEqual([]);
  });
});

describe("words typed on a paired Mac are the captain's own words", () => {
  // The captain's pick on FI3-709: a paired view is the captain at another
  // Mac, so what he types there may ask the Firstmate for an own-words change.
  let userDataDir: string;
  let core: Core;
  let mock: MockProviderServer;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  beforeAll(async () => {
    process.env.PI_OFFLINE = "1";
    userDataDir = scratchDir("infinitary-core-paired-words-");
    mock = await startMockProvider({ scenarios: [projectSetup] });
    mkdirSync(join(userDataDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mock.port));
    core = await startCore(fakeHost(userDataDir).host);
    at = `127.0.0.1:${await claimedPort()}`;
    connection = startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port: Number(at.split(":")[1]),
    });
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    await mock?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }, 30_000);

  /** One captain turn the view sent: the ask it opened, once the turn ends. */
  async function turnFrom(send: () => Promise<unknown>): Promise<AskRecord> {
    const before = new Set(core.services.tasks.listAsks().map((ask) => ask.id));
    await send();
    let opened: AskRecord | undefined;
    await waitFor(() => {
      opened = core.services.tasks.listAsks().find((ask) => !before.has(ask.id));
      return opened !== undefined;
    });
    const id = opened?.id ?? "";
    await waitFor(() => core.services.tasks.getAsk(id)?.turnState !== "open", 60_000);
    const closed = core.services.tasks.getAsk(id);
    if (!closed) throw new Error("the ask vanished");
    return closed;
  }

  it("removes a project asked in the input, and moves the projects folder asked under a card", async () => {
    const folder = scratchDir("infinitary-paired-words-repo-");
    const projects = scratchDir("infinitary-paired-words-projects-");
    writeFileSync(join(folder, "keep.txt"), "mine\n");
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const { repo } = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "MacBook Air" });
    const view = await connectClient(grant);
    const cardId = core.services.supervisor.addFirstmateCard({
      id: "paired-mac-projects-folder",
      title: "Where new projects go",
      body: "<p>New projects go in the default folder.</p>",
      actions: [],
    });
    try {
      // The input: inf:converse, as the view's window sends it.
      const removed = await turnFrom(() =>
        view.invoke("inf:converse", [
          APP_CATALOG_PROMPT_MARKER +
            JSON.stringify({ action: "project-remove", value: { repoId: repo.id } }),
        ]),
      );
      expect(removed.attachedVia).toBe("tool:app_change");
      expect(core.services.repos.get(repo.id)).toBeUndefined();
      expect(existsSync(join(folder, "keep.txt"))).toBe(true);
      expect(events.filter((e) => e.type === "repo_unregistered")).toMatchObject([
        { actor: "firstmate", repoId: repo.id, name: repo.name },
      ]);
      expect(core.services.tasks.get(removed.taskId ?? "")?.title).toBe(
        `Removed project ${repo.name}`,
      );

      // A reply under a Firstmate card: inf:cards:reply.
      const moved = await turnFrom(() =>
        view.invoke("inf:cards:reply", [
          cardId,
          APP_CATALOG_PROMPT_MARKER +
            JSON.stringify({ action: "projects-folder", value: { path: projects } }),
        ]),
      );
      expect(moved.attachedVia).toBe("tool:app_change");
      expect((await core.dispatch("inf:repos:folder", [])).path).toBe(projects);
    } finally {
      off();
      await core.dispatch("inf:repos:folder:set", [null]);
      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      await view.closed;
      rmSync(folder, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("a development run keeps the connection to loopback at its own port", () => {
  let userDataDir: string;
  let core: Core | undefined;
  let connection: ReturnType<typeof startConnection> | undefined;

  afterEach(async () => {
    await connection?.close();
    connection = undefined;
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_CONNECTION_LOOPBACK_PORT;
  });

  const boot = async (packaged: boolean) => {
    const port = await claimedPort();
    userDataDir = scratchDir("infinitary-core-loopback-");
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_CONNECTION_LOOPBACK_PORT = String(port);
    const booted = await startCore(fakeHost(userDataDir, packaged).host);
    core = booted;
    return { port, booted };
  };

  it("the link names 127.0.0.1 at that port, a device joins there, and nothing else listens", async () => {
    const { port, booted } = await boot(false);
    connection = startConnection({
      dispatch: booted.dispatch,
      events: booted.events,
      devices: booted.services.devices,
      address: () => booted.services.devices.listenHosts(),
      port: booted.services.devices.port,
    });
    expect(await booted.dispatch("inf:devices:addresses", [])).toEqual({
      addresses: [],
      chosen: null,
      current: null,
    });
    const { link } = await booted.dispatch("inf:devices:invite", [{ kind: "mac" }]);
    expect(parsePairingLink(link).at).toBe(`127.0.0.1:${port}`);
    await connection.settled();
    expect(connection.listening()).toEqual([`127.0.0.1:${port}`]);
    const device = await connectClient(
      await claimLink(link, { ...AT_FIRST_LAUNCH, name: "Test Mac" }),
    );
    expect(await device.invoke("inf:app:healthcheck", [])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
    });
    await device.close();
  }, 60_000);

  it("a packaged build ignores it and keeps the connection's own port", async () => {
    const { port, booted } = await boot(true);
    expect(booted.services.devices.port).toBe(CONNECTION_PORT);
    expect(booted.services.devices.port).not.toBe(port);
  }, 60_000);
});

/**
 * The published contract from outside (docs/contract.md): a client that knows
 * the home only through docs/contract.json, run as its own plain-Node process
 * against the real core and the real connection. Each case answers the stall
 * card of its own stuck task, raised at boot.
 */
describe("a client that knows only the published contract", () => {
  let userDataDir: string;
  let quotaDir: string;
  let core: Core;
  let connection: ReturnType<typeof startConnection>;
  let at: string;
  const stuck = ["contract-current", "contract-behind", "contract-outside"] as const;
  const major = Number(PROTOCOL_VERSION.split(".")[0]);

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-contract-");
    quotaDir = scratchDir("infinitary-core-contract-quota-");
    writeFileSync(
      join(quotaDir, "snapshot.json"),
      JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers: [] }),
    );
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
    // Crewmates idle for an hour and a half, nudged and woken twice: each
    // gets its stall card at boot.
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    const now = Date.now();
    for (const id of stuck) {
      const worktreeDir = join(userDataDir, "worktrees", id);
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, { id, title: `Tidy ${id}`, status: "completed", worktreeDir });
      tasks.recordRecovery(id, {
        rung: 2,
        count: 2,
        at: now - 35 * 60_000,
        idleSince: now - 90 * 60_000,
      });
    }
    db.close();
    core = await startCore(fakeHost(userDataDir).host);
    at = `127.0.0.1:${await claimedPort()}`;
    connection = startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port: Number(at.split(":")[1]),
    });
    const booted = core;
    await waitFor(
      () =>
        stuck.every((id) =>
          booted.services.supervisor.cardsSnapshot().some((card) => card.id === `card-stall-${id}`),
        ),
      10_000,
    );
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    core?.dispose();
    await catalogRefreshesSettled();
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  /** The captain makes a link on this Mac; a view uses it and keeps the grant. */
  const pairView = async (name: string, where = at) => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at: where }]);
    await connection.settled();
    return claimLink(link, { ...AT_FIRST_LAUNCH, name });
  };

  /** Answers a task's stall card with Discard, as the scripted client, and reads the feed after. */
  const answerAndRead = async (client: ScriptedClient, taskId: (typeof stuck)[number]) => {
    const cardId = `card-stall-${taskId}`;
    const listed = await client.ask("inf:cards:list", []);
    expect(listed).toMatchObject({ t: "result", ok: true });
    const card = (listed.value as Card[]).find((candidate) => candidate.id === cardId);
    expect(card?.actions.map((action) => action.id)).toContain("discard");

    expect(await client.ask("inf:cards:act", [cardId, "discard", "chrome"])).toMatchObject({
      t: "result",
      ok: true,
    });
    await client.line(
      (line) =>
        line.t === "push" &&
        line.channel === "inf:cards" &&
        !(line.payload as Card[]).some((candidate) => candidate.id === cardId),
    );
    await waitFor(() => core.services.tasks.get(taskId)?.status === "dropped", 10_000);

    const feed = await client.ask("inf:feed:recent", []);
    expect(feed).toMatchObject({ t: "result", ok: true });
    const key = core.services.tasks.get(taskId)?.key;
    expect(
      (feed.value as FeedLine[]).filter((line) => line.taskKey === key).map((line) => line.kind),
    ).toContain("warn");
  };

  it("answers a card and reads the feed, knowing only the published file", async () => {
    const client = await startScriptedClient(await pairView("Scripted"));
    expect(client.welcome).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      catchUp: "reload",
      access: "full",
    });
    await answerAndRead(client, "contract-current");
    // Exit 0: every frame, answer and push fit the published file.
    expect(await client.close()).toBe(0);
    expect(client.lines.filter((line) => line.t === "invalid")).toEqual([]);
  });

  it("requires a client one major behind to update before changing anything", async () => {
    const client = await startScriptedClient(await pairView("A major behind"), {
      speak: `${major - 1}.4.0`,
    });
    expect(client.welcome).toMatchObject({ protocolVersion: PROTOCOL_VERSION, access: "read" });
    expect(await client.ask("inf:feed:recent", [])).toMatchObject({ t: "result", ok: true });
    expect(
      await client.ask("inf:cards:act", ["card-stall-contract-behind", "discard", "chrome"]),
    ).toMatchObject({ t: "result", ok: false });
    expect(core.services.tasks.get("contract-behind")?.status).not.toBe("dropped");
    console.info(
      "Previous-major view reading:",
      JSON.stringify({
        welcome: client.welcome,
        taskStatus: core.services.tasks.get("contract-behind")?.status,
        cardStillOpen: (await core.dispatch("inf:cards:list", [])).some(
          (card) => card.id === "card-stall-contract-behind",
        ),
      }),
    );
    expect(await client.close()).toBe(0);
  });

  it("lets an older or newer client read the cards and the feed, and refuses its answer", async () => {
    // No client is older than the window while this contract is on its first
    // majors, so the same core is also served as a home two majors on.
    const laterAt = `127.0.0.1:${await claimedPort()}`;
    const later = startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port: Number(laterAt.split(":")[1]),
      protocolVersion: `${major + 2}.0.0`,
    });
    try {
      const older = await startScriptedClient(await pairView("Older", laterAt));
      const newer = await startScriptedClient(await pairView("Newer"), {
        speak: `${major + 1}.0.0`,
      });
      for (const client of [older, newer]) {
        expect(client.welcome.access).toBe("read");
        const listed = await client.ask("inf:cards:list", []);
        expect(
          (listed.value as Card[]).some((card) => card.id === "card-stall-contract-outside"),
        ).toBe(true);
        expect(await client.ask("inf:feed:recent", [])).toMatchObject({ t: "result", ok: true });
        const answered = await client.ask("inf:cards:act", [
          "card-stall-contract-outside",
          "discard",
          "chrome",
        ]);
        expect(answered).toMatchObject({ t: "result", ok: false });
        expect(String(answered.error)).toContain("until it is updated");
        expect(await client.close()).toBe(0);
      }
      expect(core.services.tasks.get("contract-outside")?.status).not.toBe("dropped");
      expect(
        (await core.dispatch("inf:cards:list", [])).some(
          (card) => card.id === "card-stall-contract-outside",
        ),
      ).toBe(true);
    } finally {
      await later.close();
    }
  });
});

describe("unsupported saved work stops before services start", () => {
  it("leaves accounts, conversations and launch state untouched", async () => {
    const userData = scratchDir("fm-core-refusal-");
    const db = openDatabase(userData);
    recordNewerMigration(db);
    db.close();
    const shell = fakeHost(userData);
    const host = {
      ...shell.host,
      keychain: {
        ...absentKeychain,
        read: async () => {
          throw new Error("must not read sign-ins on refusal");
        },
      },
    };
    await expect(startCore(host)).rejects.toMatchObject({ code: "unsupported-saved-data" });
    expect(existsSync(join(userData, "accounts"))).toBe(false);
    expect(existsSync(join(userData, "auth"))).toBe(false);
    expect(existsSync(join(userData, "firstmate"))).toBe(false);
  });
});
