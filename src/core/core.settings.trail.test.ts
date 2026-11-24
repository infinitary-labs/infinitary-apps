import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS } from "@shared/actions";
import type { FmEvent } from "@shared/events";
import { feedLineFrom } from "@shared/feed";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { fakeHost, quotaFixture } from "../../tests/helpers/bootedCore";
import { SAMPLE_NOTES } from "../../tests/helpers/mcpStandIn";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { SETTLE_MS } from "./dispatcher/actionTrail";
import { type Core, startCore } from "./index";
import { actionValue, createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";

// This file is not about the utility-QoS clamp, so what the product spawns
// runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The trail a change leaves (src/core/dispatcher/actionTrail.ts), driven
 * through the whole core: one operation and one Activity line per actual
 * change, a run of the captain's steps settled into one, and each line naming
 * who acted and on what.
 */
describe("the trail a change leaves, driven through the core with no Electron in the process", () => {
  let userDataDir: string;
  let core: Core;

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
    core = await startCore(fakeHost(userDataDir).host);
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
});
