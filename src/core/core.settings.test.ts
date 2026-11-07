import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_NAMES, ACTIONS } from "@shared/actions";
import type { FmEvent } from "@shared/events";
import { feedLineFrom } from "@shared/feed";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { fakeHost, quotaFixture } from "../../tests/helpers/bootedCore";
import { SAMPLE_NOTES } from "../../tests/helpers/mcpStandIn";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { SETTLE_MS } from "./dispatcher";
import { ForgeSignInStore } from "./forge/signIns";
import { type Core, startCore } from "./index";
import { automationWords } from "./orchestrator/scheduler";
import { actionValue, createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { NO_PLACED_TASK } from "./placed/placedWork";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The whole core booted in a plain Node process (tests/helpers/bootedCore.ts):
 * the handshake, Settings writes and their Activity runs, the app catalog's
 * actions and trails, integrations, presence, the card and What's new doors,
 * and the voice model.
 */

describe("the core, driven with no Electron in the process", () => {
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-");
    // The same isolation e2e uses: no pi.dev catalog fetch, quota off files.
    process.env.PI_OFFLINE = "1";
    quotaFixture("infinitary-core-quota-", [
      {
        provider: "codex",
        label: "Codex",
        status: "ok",
        stale: false,
        windows: [{ id: "weekly", label: "weekly", percentRemaining: 62 }],
      },
    ]);
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
      "project-queue-answer",
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
      supervisor.cards.addSystemNoteCard("card-show-open", "Still open", "On the stage.");
      supervisor.cards.addSystemNoteCard("card-show-past", "An earlier plan", "What it said.");
      supervisor.pressNote("card-show-past");
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
      supervisor.pressNote("card-show-open");
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
      supervisor.cards.addSystemNoteCard(
        "card-note-listed",
        "What’s new in stable 0.0.2",
        "Changes.",
      );
      supervisor.pressNote("card-note-listed");
      supervisor.cards.addSystemNoteCard(
        "card-note-quiet",
        "Your alpha is now stable",
        "Nothing new.",
      );
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
      supervisor.pressNote("card-note-quiet");
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
});
