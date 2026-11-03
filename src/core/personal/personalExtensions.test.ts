import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_BACKGROUND_INTERVAL_MS, type PersonalSnapshot } from "@shared/personal/manifest";
import type { PanelMountState } from "@shared/personal/mounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { CoreEventSink } from "../events";
import { PanelRuntimes } from "../panels/panelRuntimes";
import { PanelStops } from "../panels/panelStops";
import { renderCaptureText, renderPlaceText } from "../pi/panelTools";
import { forkChildProcess } from "../sql/forkChildProcess";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { PanelMountsHolder } from "./panelMounts";
import { PersonalExtensions } from "./personalExtensions";
import { PersonalStore } from "./personalStore";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The Step 2 acceptance, against the real service over a temp workspace:
 * a fixture renders (a panel URL in the snapshot) and disappears when its
 * presence source is empty; an unsupported import is refused with the path
 * named; a background task under 60 s is clamped; a task on the extension
 * lights the running dot; an edit is a new version; a removal unmounts.
 */
const PANEL_PROCESS = fileURLToPath(new URL("../panels/panelProcess.ts", import.meta.url));
const runtimesOpen: PanelRuntimes[] = [];
afterEach(() => {
  for (const runtimes of runtimesOpen.splice(0)) runtimes.disposeAll();
});

/** Resolves once `check` holds, polled on the event loop; the test's budget bounds it. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function harness(watch: { silenceMs?: number } = {}) {
  const root = realpathSync(scratchDir("infinitary-personal-svc-"));
  const workspaceDir = join(root, "personal");
  const cacheRoot = join(root, "cache");
  const db = openInMemoryDatabase();
  const store = new PersonalStore(db);
  // Every server module runs in the real panel process, as in the app (INF-2205 piece B).
  const runtimes = new PanelRuntimes({
    spawner: forkChildProcess(PANEL_PROCESS),
    stops: new PanelStops(db),
    beatMs: 100,
    ...(watch.silenceMs ? { silenceMs: watch.silenceMs } : {}),
  });
  runtimesOpen.push(runtimes);
  const tasks = new TaskService({ db, strict: true });
  const pushes: { channel: string; payload: unknown }[] = [];
  const emit: CoreEventSink = (channel, payload) => {
    pushes.push({ channel, payload });
  };
  const write = (path: string, content: string) => {
    mkdirSync(join(workspaceDir, path, ".."), { recursive: true });
    writeFileSync(join(workspaceDir, path), content);
  };
  return { workspaceDir, cacheRoot, store, tasks, pushes, emit, write, runtimes, db };
}

const PANEL =
  'import type { PanelProps } from "@firstmate/contracts";\nexport default (props: PanelProps) => props.id;';

/** Commits the whole workspace the way a turn's report does, under a test identity. */
function commitAll(dir: string, message = "chore: build"): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

describe("PersonalExtensions", () => {
  it("serves a server module's sql over the views its manifest names now, and mounts nothing for a retired one", async () => {
    const h = await harness();
    const asked: unknown[] = [];
    const sql = async (request: unknown) => {
      asked.push(request);
      return { columns: ["n"], rows: [{ n: 2 }], truncated: false, elapsedMs: 1 };
    };
    h.write(
      "tokens/manifest.json",
      JSON.stringify({ api: 2, title: "Tokens", sql: ["v_usage_v1"] }),
    );
    h.write("tokens/panel.tsx", PANEL);
    h.write(
      "tokens/server.ts",
      'import type { ServerContext } from "@firstmate/contracts";\nexport const actions = { count: (input: unknown, context: ServerContext) => context.sql("SELECT COUNT(*) AS n FROM v_usage_v1", [input as number]) };',
    );
    h.write("newer/manifest.json", JSON.stringify({ title: "Newer", sql: ["v_usage_v2"] }));
    h.write("newer/panel.tsx", PANEL);
    h.write("typo/manifest.json", JSON.stringify({ title: "Typo", sql: ["v_usgae_v1"] }));
    h.write(
      "gone/manifest.json",
      JSON.stringify({ title: "Gone", sql: ["v_usage_v1", "v_quota_v1"] }),
    );
    h.write("gone/panel.tsx", PANEL);
    h.write("typo/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, watch: false, sql });
    try {
      const [, newer, tokens, typo] = service.snapshot().extensions;
      expect(tokens).toMatchObject({ sql: ["v_usage_v1"], present: true, error: null });
      expect(await service.invoke("tokens", "count", 5)).toEqual({
        ok: true,
        result: { columns: ["n"], rows: [{ n: 2 }], truncated: false, elapsedMs: 1 },
      });
      expect(asked).toEqual([
        { sql: "SELECT COUNT(*) AS n FROM v_usage_v1", params: [5], views: ["v_usage_v1"] },
      ]);
      // Written against views this version does not publish: nothing mounts,
      // and the line says why in plain words.
      expect(newer).toMatchObject({ frame: null, present: false, server: null });
      expect(newer?.error?.message).toContain("written for a newer version of the app");
      expect(typo?.frame).toBeNull();
      expect(service.snapshot().extensions.map((e) => e.id)).toEqual([
        "gone",
        "newer",
        "tokens",
        "typo",
      ]);
      expect(typo?.error?.message).toContain("asks for data the app does not publish");
    } finally {
      service.dispose();
    }
  });

  it("carries a panel's cards, buttons and commands, and names one that points at nothing", async () => {
    const h = await harness();
    const cards = { reader: { view: "reader", title: "Reading", width: "regular" } };
    const header = [{ id: "open", icon: "open", label: "Open reading", emits: "reader" }];
    const commands = [{ id: "open", label: "Open reading", emits: "reader", key: "⌘J" }];
    h.write("reading/manifest.json", JSON.stringify({ title: "Reading", cards, header, commands }));
    h.write("reading/panel.tsx", PANEL);
    h.write("reading/cards/reader.tsx", PANEL);
    h.write("broken/manifest.json", JSON.stringify({ title: "Broken", cards, header }));
    h.write("broken/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const [broken, reading] = service.snapshot().extensions;
      expect(reading).toMatchObject({
        cardViews: ["reader"],
        cards,
        header,
        commands,
        present: true,
        error: null,
      });
      // Its card view sits beside its panel in the same version.
      expect(
        existsSync(
          join(h.cacheRoot, "reading", reading?.frame?.version ?? "", "cards", "reader.mjs"),
        ),
      ).toBe(true);
      // A name that points at nothing: the panel still draws, without them.
      expect(broken).toMatchObject({
        cardViews: [],
        cards: {},
        header: [],
        commands: [],
        present: true,
      });
      expect(broken?.error?.message).toContain("there is no cards/reader.tsx");
    } finally {
      service.dispose();
    }
  });

  it("seeds the workspace, mounts a fixture, and follows its presence source", async () => {
    const h = await harness();
    h.write("prs/panel.tsx", PANEL);
    h.write(
      "prs/manifest.json",
      JSON.stringify({
        title: "Open PRs",
        presence: { store: "items", when: "nonEmpty" },
        placement: { x: "left", y: "top" },
      }),
    );
    h.write("always/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const snapshot = service.snapshot();
      expect(snapshot.extensions.map((e) => e.id)).toEqual(["always", "prs"]);
      const prs = snapshot.extensions[1];
      expect(prs).toMatchObject({
        title: "Open PRs",
        placement: { x: "left", y: "top" },
        present: false,
        running: false,
        server: null,
        error: null,
      });
      // Drawn in a frame (INF-2205 piece C): the view names a version only.
      expect(prs?.panel).toBeNull();
      expect(prs?.frame?.version).toMatch(/^[0-9a-f]{16}$/);
      expect(snapshot.extensions[0]).toMatchObject({
        title: "always",
        present: true,
        // A panel that names no place lands where the create-your-own-panel slot was.
        placement: { x: "left", y: "top" },
      });
      // The workspace was seeded around the fixture.
      expect(() => rmSync(join(h.workspaceDir, "AGENTS.md"))).not.toThrow();

      h.pushes.length = 0;
      h.store.set("prs", "items", [1]);
      expect(h.pushes.map((p) => p.channel)).toEqual(["inf:plugins:db", "inf:plugins:personal"]);
      expect(h.pushes[0]?.payload).toEqual({ extensionId: "prs", key: "items" });
      expect(service.snapshot().extensions[1]?.present).toBe(true);
      h.pushes.length = 0;
      h.store.set("prs", "other", "x");
      // A key the presence rule does not read changes nothing on the snapshot.
      expect(h.pushes.map((p) => p.channel)).toEqual(["inf:plugins:db"]);
      h.store.set("prs", "items", []);
      expect(service.snapshot().extensions[1]?.present).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("refuses an unsupported import with the path named, keeping the panel absent, and recovers on the fix", async () => {
    const h = await harness();
    h.write("bad/panel.tsx", 'import _ from "lodash";\nexport default () => _;');
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const [bad] = service.snapshot().extensions;
      expect(bad?.frame).toBeNull();
      expect(bad?.present).toBe(false);
      expect(bad?.error).toEqual({
        stage: "panel",
        message:
          'bad/panel.tsx imports "lodash", which a panel cannot use (react, @infinitary/ui, and files inside bad/)',
      });
      expect(service.errors()).toEqual([{ id: "bad", error: bad?.error }]);
      h.write("bad/panel.tsx", PANEL);
      await service.refresh();
      const fixed = service.snapshot().extensions[0];
      expect(fixed?.error).toBeNull();
      expect(fixed?.present).toBe(true);
      h.write("bad/panel.tsx", "export default (props => {");
      await service.refresh();
      expect(service.snapshot().extensions[0]?.error?.message).toMatch(/^bad\/panel\.tsx:1: /);
    } finally {
      service.dispose();
    }
  });

  it("finds a panel whose manifest.json is not JSON, and names the manifest's error on it", async () => {
    // INF-1055: the entry file makes the panel, whatever its manifest holds.
    const h = await harness();
    h.write("clock/panel.tsx", PANEL);
    h.write("clock/manifest.json", "{ not json");
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const [clock] = service.snapshot().extensions;
      expect(clock?.id).toBe("clock");
      expect(clock?.error).toMatchObject({ stage: "manifest" });
      expect(clock?.error?.message).toMatch(/^clock\/manifest\.json is not JSON: /);
    } finally {
      service.dispose();
    }
  });

  it("loads server.ts, clamps a fast background task, answers invoke, and reloads on edit", async () => {
    const h = await harness();
    h.write("meter/manifest.json", JSON.stringify({ api: 2 }));
    h.write(
      "meter/server.ts",
      [
        'import type { ServerModule } from "@firstmate/contracts";',
        "export const actions: ServerModule['actions'] = {",
        "  fill: async (input, context) => { await context.db.set('items', input as never); return 'filled'; },",
        "  boom: () => { throw new Error('no'); },",
        "};",
        "export const background: ServerModule['background'] = {",
        "  sample: { everyMs: 1000, run: (context) => context.db.set('sampled', 1) },",
        "};",
      ].join("\n"),
    );
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const [meter] = service.snapshot().extensions;
      expect(meter?.frame).toBeNull();
      expect(meter?.server).toEqual({
        actions: ["fill", "boom"],
        background: [{ id: "sample", everyMs: MIN_BACKGROUND_INTERVAL_MS }],
      });
      // runOnStart ran the task once through the bound store.
      await until(() => h.store.get("meter", "sampled") === 1);
      expect(await service.invoke("meter", "fill", [1, 2])).toEqual({ ok: true, result: "filled" });
      expect(h.store.get("meter", "items")).toEqual([1, 2]);
      expect(await service.invoke("meter", "boom", null)).toEqual({ ok: false, error: "no" });
      expect(await service.invoke("meter", "nope", null)).toEqual({
        ok: false,
        error: '"meter" has no action "nope" (it has fill, boom)',
      });
      expect(await service.invoke("ghost", "x", null)).toEqual({
        ok: false,
        error: '"ghost" is not in the personal workspace',
      });
      expect(service.storeRequest({ op: "get", extensionId: "meter", key: "items" })).toEqual({
        value: [1, 2],
      });
      expect(service.storeRequest({ op: "get", extensionId: "meter", key: "none" })).toEqual({});
      expect(
        service.storeRequest({ op: "list", extensionId: "meter", prefix: "it" }),
      ).toMatchObject({ entries: [{ key: "items" }] });
      service.storeRequest({ op: "delete", extensionId: "meter", key: "items" });
      expect(h.store.get("meter", "items")).toBeUndefined();

      h.write("meter/server.ts", "export const actions = { fill: () => 'v2' };");
      await service.refresh();
      expect(service.snapshot().extensions[0]?.server).toEqual({
        actions: ["fill"],
        background: [],
      });
      expect(await service.invoke("meter", "fill", null)).toEqual({ ok: true, result: "v2" });
    } finally {
      service.dispose();
    }
  });

  it("lights the running dot while the origin task is active, versions an edit, and unmounts a removal", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-1", title: "Build clock", status: "running" });
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      // A build that reported once and is still open: its last commit names it.
      h.write("clock/panel.tsx", PANEL);
      h.write("clock/manifest.json", JSON.stringify({ origin: { taskId: "t-1" } }));
      commitAll(h.workspaceDir);
      await service.refresh();
      const first = service.snapshot().extensions[0];
      expect(first?.running).toBe(true);
      h.pushes.length = 0;
      h.tasks.close("t-1", { status: "done", reason: "finished", actor: "host" });
      expect(service.snapshot().extensions[0]?.running).toBe(false);
      expect(h.pushes.some((p) => p.channel === "inf:plugins:personal")).toBe(true);

      h.write("clock/panel.tsx", `${PANEL}\n// edited`);
      await service.refresh();
      const edited = service.snapshot().extensions[0];
      expect(edited?.frame?.version).not.toBe(first?.frame?.version);

      rmSync(join(h.workspaceDir, "clock"), { recursive: true });
      await service.refresh();
      expect(service.snapshot().extensions).toEqual([]);

      await service.purge();
      expect(service.snapshot().extensions).toEqual([]);
    } finally {
      service.dispose();
    }
  });
  // INF-2205 piece B, the captain's "Update affected panel code, leaving saved
  // data unchanged": a module written for the store that answered at once is
  // refused before it runs, never run with answers it would misread.
  it("refuses a server.ts written for the earlier panel API before any of it runs", async () => {
    const h = await harness();
    const marker = join(h.workspaceDir, "..", "imported");
    h.write("old/panel.tsx", PANEL);
    h.write(
      "old/server.ts",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport const actions = { n: (_i: unknown, c: { db: { get: (k: string) => unknown } }) => c.db.get("n") };`,
    );
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const [old] = service.snapshot().extensions;
      expect(old).toMatchObject({ server: null, error: { stage: "server" } });
      expect(old?.error?.message).toContain('set "api": 2 in manifest.json');
      // The panel itself still draws; only its background work waits for the update.
      expect(old?.frame).not.toBeNull();
      expect(existsSync(marker)).toBe(false);
      expect(h.runtimes.running).toBe(0);
    } finally {
      service.dispose();
    }
  });

  // INF-2470, the captain's "Approve and build" on direction A with "Start the
  // update at once": a refused panel carries the typed fact the window and
  // the first mate read, the log says so once per code version, Update panel
  // tells the first mate once, and fixed files clear it with no Retry.
  it("pauses a panel written for the earlier panel API, asks its update once, and runs it once fixed", async () => {
    const h = await harness();
    const logs: string[] = [];
    const asks: unknown[] = [];
    const older = [
      'import type { ServerContext } from "@infinitary/contracts";',
      "export const actions = {",
      "  count: (_input: unknown, context: ServerContext) => {",
      '    const n = (context.db.get("n") as unknown as number | undefined) ?? 0;',
      '    context.db.set("n", n + 1);',
      "    return n + 1;",
      "  },",
      "};",
    ].join("\n");
    h.write("counter/manifest.json", JSON.stringify({ title: "Counter" }));
    h.write("counter/panel.tsx", PANEL);
    h.write("counter/server.ts", older);
    h.store.set("counter", "n", 4);
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      log: (message) => logs.push(message),
      askUpdate: (ask) => asks.push(ask),
    });
    try {
      const counter = () => service.snapshot().extensions.find((e) => e.id === "counter");
      expect(counter()?.paused).toEqual({ api: 1, serves: [2], asked: false });
      expect(counter()?.frame).not.toBeNull();
      const refusals = () => logs.filter((line) => line.includes("counter/server.ts is written"));
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]).toContain("Updating a panel written for an earlier panel API");

      // The same text refused again is not logged again; a new version of it is.
      await service.refresh();
      h.write("counter/panel.tsx", `${PANEL}\n`);
      await service.refresh();
      expect(refusals()).toHaveLength(1);
      h.write("counter/server.ts", `${older}\n// still the earlier API\n`);
      await service.refresh();
      expect(refusals()).toHaveLength(2);

      expect(service.askUpdate("counter")).toBe(true);
      expect(service.askUpdate("counter")).toBe(false);
      expect(asks).toEqual([{ id: "counter", title: "Counter", api: 1, serves: [2] }]);
      expect(counter()?.paused?.asked).toBe(true);
      // A panel that is not paused tells no one.
      expect(service.askUpdate("absent")).toBe(false);

      h.write(
        "counter/server.ts",
        [
          'import type { ServerContext } from "@infinitary/contracts";',
          "export const actions = {",
          "  count: async (_input: unknown, context: ServerContext) => {",
          '    const n = ((await context.db.get("n")) as number | undefined) ?? 0;',
          '    await context.db.set("n", n + 1);',
          "    return n + 1;",
          "  },",
          "};",
        ].join("\n"),
      );
      h.write("counter/manifest.json", JSON.stringify({ api: 2, title: "Counter" }));
      await service.refresh();
      expect(counter()?.paused).toBeUndefined();
      expect(counter()?.error).toBeNull();
      // Its background work runs at once, with no Retry, on the data it kept.
      expect(await service.invoke("counter", "count", null)).toEqual({ ok: true, result: 5 });
    } finally {
      service.dispose();
    }
  });

  // INF-2205 piece B, the captain's "Stop only the identified panel; keep the
  // broad fallback": the stop holds across a restart and a new version until
  // the captain's Retry, and the panel's data stays.
  it("stops a server that holds its loop, keeps it stopped across a restart and an edit, and Retry starts it", async () => {
    const h = await harness({ silenceMs: 1_500 });
    h.write("spin/manifest.json", JSON.stringify({ api: 2, title: "Spin" }));
    h.write("spin/panel.tsx", PANEL);
    h.write(
      "spin/server.ts",
      "export const actions = { spin: async (_i: unknown, c: { db: { set: (k: string, v: number) => Promise<void> } }) => { await c.db.set('kept', 1); for (;;) {} }, ping: () => 'v1' };",
    );
    h.write("calm/manifest.json", JSON.stringify({ api: 2, title: "Calm" }));
    h.write("calm/server.ts", "export const actions = { ping: () => 'pong' };");
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const spun = await service.invoke("spin", "spin", null);
      expect(spun.ok).toBe(false);
      await until(() => service.snapshot().extensions.some((e) => e.stopped !== undefined));
      const spin = service.snapshot().extensions.find((e) => e.id === "spin");
      expect(spin).toMatchObject({ server: null, stopped: { reason: "unresponsive" } });
      expect(h.store.get("spin", "kept")).toBe(1);
      expect(await service.invoke("calm", "ping", null)).toEqual({ ok: true, result: "pong" });
      expect(await service.invoke("spin", "ping", null)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Retry"),
      });
      expect(await service.lint("spin")).toContain("stopped:");
    } finally {
      service.dispose();
    }

    // The app starts again on the same record: still stopped, nothing spawned for it.
    const again = new PanelRuntimes({
      spawner: forkChildProcess(PANEL_PROCESS),
      stops: new PanelStops(h.db),
      beatMs: 100,
    });
    runtimesOpen.push(again);
    const restarted = await PersonalExtensions.start({ ...h, runtimes: again, watch: false });
    try {
      const spin = () => restarted.snapshot().extensions.find((e) => e.id === "spin");
      expect(spin()).toMatchObject({ server: null, stopped: { reason: "unresponsive" } });
      expect(again.running).toBe(1);
      // A fix on the rail does not start itself.
      h.write("spin/server.ts", "export const actions = { ping: () => 'v2' };");
      await restarted.refresh();
      expect(spin()?.stopped).toBeDefined();
      // The captain's Retry.
      expect(await restarted.retry("spin")).toBe(true);
      expect(spin()?.stopped).toBeUndefined();
      expect(await restarted.invoke("spin", "ping", null)).toEqual({ ok: true, result: "v2" });
      expect(await restarted.retry("calm")).toBe(false);
    } finally {
      restarted.dispose();
    }
    // It waits out a shortened 1.5 s silence and the kill; its fastest
    // measured run is 3 s (docs/test-cohorts.md, "Budgets").
  }, 15_000);
});

/**
 * The live build loop (talk-to-personalize Step 4), against the real
 * service over a temp workspace that the seeder made a git repo: a live
 * task's saves are stamped onto the manifest (the running dot follows the
 * first save), the turn's commit carries the report and lints what it
 * touched, a lint answers findings and the compiler's verdict, a removal
 * waits for the building task, and a capture without a host says so.
 */
describe("PersonalExtensions live build loop (Step 4)", () => {
  const log = (dir: string) =>
    execFileSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

  it("stamps a live task onto touched extensions, commits the turn with the report, and lints at the commit", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-live", title: "Tokyo clock", status: "running" });
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      const seeded = log(h.workspaceDir).length;
      service.beginLiveTask("t-live");
      h.write("clock/panel.tsx", `${PANEL}\nconst color = "#ff0000";`);
      await service.refresh();
      // The stamp landed before the load read the manifest: the draft is
      // the task's, and a new panel is on no rail until its first commit.
      expect(JSON.parse(readFileSync(join(h.workspaceDir, "clock/manifest.json"), "utf8"))).toEqual(
        {
          origin: { taskId: "t-live" },
        },
      );
      expect(service.snapshot().extensions).toEqual([]);
      expect(service.snapshot().drafts?.[0]).toMatchObject({ id: "clock", running: true });
      expect(await service.touched()).toEqual(["clock"]);

      const commit = await service.commitTurn("t-live", "Tokyo clock panel added. It is small.");
      expect(commit.committed).toBe(true);
      expect(commit.touched).toEqual(["clock"]);
      expect(commit.findings.map((finding) => finding.rule)).toEqual(["raw-color"]);
      expect(log(h.workspaceDir)).toHaveLength(seeded + 1);
      expect(log(h.workspaceDir)[0]).toBe("chore: Tokyo clock panel added.");
      expect(await service.touched()).toEqual([]);
      // The commit is the report: the panel is on its rail, its build still open.
      expect(service.snapshot().extensions[0]).toMatchObject({ id: "clock", running: true });
      expect(service.snapshot().drafts).toBeUndefined();
      // Nothing changed since: no empty commit.
      expect((await service.commitTurn("t-live", "again")).committed).toBe(false);
      expect(log(h.workspaceDir)).toHaveLength(seeded + 1);
      service.endLiveTask("t-live");
      h.tasks.close("t-live", { status: "done", reason: "finished", actor: "host" });
      expect(service.snapshot().extensions[0]?.running).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("commits lesson turns that end together one after another, none failing on git's lock", async () => {
    // INF-539: a choice the captain made while a lesson turn was finishing
    // started the next turn as the last one's commit ran. The two commits
    // raced for git's index lock, one failed on `index.lock: File exists`,
    // and the first mate was woken about a lesson with nothing wrong.
    const h = await harness();
    const service = await PersonalExtensions.start({ ...h, watch: false });
    const progress = (round: number) =>
      `# Chess\nGoal: beat my dad at chess\n## Skills\n- rook slides | practising | round ${round}\n`;
    try {
      const reports = ["Round ready.", "Round ready.", "Progress saved.", "Round ready."];
      const turns = reports.map((report, index) => {
        h.write("lessons/chess/progress.md", progress(index + 1));
        return service.commitTurn("t-lesson", report);
      });
      // A turn whose commit lost the race rejects with git's words.
      const commits = await Promise.all(turns);
      expect(commits.some((commit) => commit.committed)).toBe(true);
      const workspace = (...args: string[]) =>
        execFileSync("git", ["-C", h.workspaceDir, ...args], { encoding: "utf8" });
      expect(workspace("show", "HEAD:lessons/chess/progress.md")).toBe(progress(reports.length));
      expect(workspace("status", "--porcelain")).toBe("");
    } finally {
      service.dispose();
    }
  });

  it("leaves lesson files alone in a live build: no manifest written, nothing touched, no committed copy", async () => {
    // INF-1055: only a folder holding panel.tsx or server.ts is a panel.
    const h = await harness();
    seedTask(h.tasks, { id: "t-lesson", title: "Chess", status: "running" });
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      h.write("lessons/learner.md", "# Learner\nLikes short rounds.\n");
      h.write("lessons/chess/record.json", JSON.stringify({ goal: "beat my dad at chess" }));
      commitAll(h.workspaceDir);
      service.beginLiveTask("t-lesson");
      h.write("lessons/chess/progress.md", "# Chess\nGoal: beat my dad at chess\n");
      await service.refresh();
      expect(await service.touched()).toEqual([]);
      expect(existsSync(join(h.workspaceDir, "lessons/manifest.json"))).toBe(false);
      expect(existsSync(join(h.cacheRoot, ".committed", "lessons"))).toBe(false);
      expect(service.snapshot().extensions).toEqual([]);
      expect(service.snapshot().drafts).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it("lints one extension or every touched one, naming the compiler's verdict, and refuses a capture without a host", async () => {
    const h = await harness();
    h.write("good/panel.tsx", PANEL);
    h.write(
      "bad/panel.tsx",
      'import lodash from "lodash";\nexport default () => String(lodash);\n',
    );
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      expect(await service.lint("good")).toBe("good: No findings.");
      const bad = await service.lint("bad");
      expect(bad).toContain("bad: No findings.");
      expect(bad).toContain('compile: bad/panel.tsx imports "lodash"');
      // Both are uncommitted: an id-less lint covers every touched one.
      const all = await service.lint();
      expect(all).toContain("bad:");
      expect(all).toContain("good:");
      expect(await service.lint("missing")).toContain("no files found");
      expect(await service.capture("good", "t-1")).toEqual({
        ok: false,
        id: "good",
        reason: "captures are not available in this build",
      });
    } finally {
      service.dispose();
    }
  });

  it("captures a docked panel in both themes through the host and writes the files under the task", async () => {
    const h = await harness();
    h.write("clock/panel.tsx", PANEL);
    const captureCalls: { panelId: string; theme: string }[] = [];
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      capture: {
        capturePanel: async (input) => {
          captureCalls.push(input);
          return { png, width: 300, height: 120 };
        },
      },
      captureDirFor: (taskId) => join(h.cacheRoot, "..", "captures", taskId),
    });
    try {
      const result = await service.capture("clock", "t-9");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a capture");
      expect(captureCalls).toEqual([
        { panelId: "clock", theme: "dark" },
        { panelId: "clock", theme: "light" },
      ]);
      expect(result.images.map((image) => [image.theme, image.width, image.height])).toEqual([
        ["dark", 300, 120],
        ["light", 300, 120],
      ]);
      for (const image of result.images) {
        expect(image.path.endsWith(`captures/t-9/clock-${image.theme}.png`)).toBe(true);
        expect(readFileSync(image.path).equals(png)).toBe(true);
        expect(image.data).toBe(png.toString("base64"));
      }
      expect(await service.capture("nope", "t-9")).toMatchObject({ ok: false, id: "nope" });
    } finally {
      service.dispose();
    }
  });

  it("refuses a removal while a task is building the extension, and allows it once the task closed", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-b", title: "Build clock", status: "running" });
    h.write("clock/panel.tsx", PANEL);
    h.write("clock/manifest.json", JSON.stringify({ title: "Clock", origin: { taskId: "t-b" } }));
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      await service.commitTurn("t-b", "Clock added");
      await expect(service.remove("clock")).rejects.toThrow(/still being built/);
      h.tasks.close("t-b", { status: "done", reason: "finished", actor: "host" });
      expect(await service.remove("clock")).toEqual({ removed: true, committed: true });
      expect(log(h.workspaceDir)[0]).toBe("chore: remove clock on the captain's word");
      expect(service.snapshot().extensions).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("removes an extension that was never committed, with no commit to make", async () => {
    const h = await harness();
    h.write("draft/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      expect(await service.remove("draft")).toEqual({ removed: true, committed: false });
      expect(service.snapshot().extensions).toEqual([]);
    } finally {
      service.dispose();
      rmSync(join(h.workspaceDir, ".."), { recursive: true, force: true });
    }
  });
});

/**
 * A build runs apart from the rails (docs/personal-panels.md, "Built
 * apart"): while a crewmate is building an extension, the rails keep its
 * last commit - the same version, the same server module, the same store -
 * and the working files run as a draft with a store and server of their
 * own; the report's commit swaps the new version in and the draft goes.
 */
describe("PersonalExtensions builds apart from the rails", () => {
  const SERVER = (word: string) =>
    [
      'import type { ServerModule } from "@firstmate/contracts";',
      `export const actions: ServerModule["actions"] = { word: () => "${word}" };`,
      "",
    ].join("\n");

  it("keeps the rails on the last commit while a live task saves, runs the draft apart, and swaps in at the report", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-live", title: "Change the clock", status: "running" });
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      h.write("clock/panel.tsx", PANEL);
      h.write("clock/server.ts", SERVER("before"));
      h.write("clock/manifest.json", JSON.stringify({ api: 2, title: "Clock" }));
      commitAll(h.workspaceDir);
      await service.refresh();
      h.store.set("clock", "note", "the captain's");
      const before = service.snapshot().extensions[0];
      expect(before?.frame?.version).toMatch(/^[0-9a-f]{16}$/);
      expect(await service.invoke("clock", "word", null)).toEqual({ ok: true, result: "before" });

      service.beginLiveTask("t-live");
      h.write("clock/panel.tsx", `${PANEL}\n// smaller rows`);
      h.write("clock/server.ts", SERVER("after"));
      h.write("clock/manifest.json", JSON.stringify({ api: 2, title: "Clock, smaller" }));
      h.pushes.length = 0;
      await service.refresh();
      // The rails: the same version and title as before, with the running dot.
      const during = service.snapshot();
      expect(during.extensions[0]).toMatchObject({
        id: "clock",
        title: "Clock",
        running: true,
        frame: before?.frame,
      });
      // The draft: the working files, compiled.
      expect(during.drafts?.[0]).toMatchObject({ id: "clock", title: "Clock, smaller" });
      expect(during.drafts?.[0]?.frame?.version).not.toBe(before?.frame?.version);
      // Each runs its own server.
      expect(await service.invoke("clock", "word", null)).toEqual({ ok: true, result: "before" });
      expect(await service.invoke("clock", "word", null, { draft: true })).toEqual({
        ok: true,
        result: "after",
      });
      // The draft's store starts as the panel's, and what it writes stays its own.
      expect(
        service.storeRequest({ op: "get", extensionId: "clock", key: "note", draft: true }),
      ).toEqual({ value: "the captain's" });
      service.storeRequest({
        op: "set",
        extensionId: "clock",
        key: "note",
        value: "the build's",
        draft: true,
      });
      expect(h.pushes).toContainEqual({
        channel: "inf:plugins:db",
        payload: { extensionId: "clock", key: "note", draft: true },
      });
      expect(h.store.get("clock", "note")).toBe("the captain's");

      // A save that does not compile is the draft's to show, never the rails'.
      h.write("clock/panel.tsx", "export default () => <div>");
      await service.refresh();
      expect(service.snapshot().extensions[0]).toMatchObject({ frame: before?.frame, error: null });
      expect(service.snapshot().drafts?.[0]?.error?.stage).toBe("panel");
      expect(await service.lint("clock")).toContain("compile: clock/panel.tsx");
      h.write("clock/panel.tsx", `${PANEL}\n// smaller rows`);
      await service.refresh();
      const draftVersion = service.snapshot().drafts?.[0]?.frame?.version;
      // Every push while the build went on drew the rails' panel as it was.
      const railVersions = h.pushes
        .filter((push) => push.channel === "inf:plugins:personal")
        .map((push) => (push.payload as PersonalSnapshot).extensions[0]?.frame?.version);
      expect(new Set(railVersions)).toEqual(new Set([before?.frame?.version]));

      // The report's commit: the rails take the version the draft had, and the draft goes.
      h.pushes.length = 0;
      await service.commitTurn("t-live", "The clock rows are smaller.");
      const after = service.snapshot();
      expect(after.extensions[0]).toMatchObject({ title: "Clock, smaller", running: true });
      expect(after.extensions[0]?.frame?.version).toBe(draftVersion);
      expect(after.drafts).toBeUndefined();
      expect(await service.invoke("clock", "word", null)).toEqual({ ok: true, result: "after" });
      expect(await service.invoke("clock", "word", null, { draft: true })).toEqual({
        ok: false,
        error: '"clock" is not being built right now',
      });
      // The build's store went with it; the panel's own is as the captain left it.
      expect(h.store.get("clock", "note")).toBe("the captain's");
      expect(h.store.slices()).toEqual(["clock"]);
      expect(() =>
        service.storeRequest({
          op: "set",
          extensionId: "clock",
          key: "note",
          value: "late",
          draft: true,
        }),
      ).toThrow(/not being built/);
      const lastRail = h.pushes
        .filter((push) => push.channel === "inf:plugins:personal")
        .map((push) => (push.payload as PersonalSnapshot).extensions[0]?.frame?.version);
      expect(lastRail.at(-1)).toBe(draftVersion);
    } finally {
      service.dispose();
    }
  });

  it("puts a new panel on no rail until its first commit, and captures its draft", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-new", title: "Build a clock", status: "running" });
    const captureCalls: { panelId: string; theme: string }[] = [];
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      capture: {
        capturePanel: async (input) => {
          captureCalls.push(input);
          return { png, width: 300, height: 120 };
        },
      },
    });
    try {
      service.beginLiveTask("t-new");
      h.write("fresh/panel.tsx", PANEL);
      await service.refresh();
      expect(service.snapshot().extensions).toEqual([]);
      expect(service.snapshot().drafts?.map((draft) => [draft.id, draft.present])).toEqual([
        ["fresh", true],
      ]);
      // The capture photographs the version being built, where the window draws it.
      expect((await service.capture("fresh", "t-new")).ok).toBe(true);
      expect(captureCalls).toEqual([
        { panelId: "fresh.draft", theme: "dark" },
        { panelId: "fresh.draft", theme: "light" },
      ]);
      // "Remove it" names what is on the rails; a panel still being built is not.
      expect(await service.remove("fresh")).toEqual({ removed: false, committed: false });

      await service.commitTurn("t-new", "A clock panel.");
      expect(service.snapshot().extensions.map((e) => [e.id, e.present])).toEqual([
        ["fresh", true],
      ]);
      expect(service.snapshot().drafts).toBeUndefined();
      captureCalls.length = 0;
      expect((await service.capture("fresh", "t-new")).ok).toBe(true);
      expect(captureCalls.map((call) => call.panelId)).toEqual(["fresh", "fresh"]);
    } finally {
      service.dispose();
    }
  });

  it("keeps a build that stopped before its report apart, and lets a hand edit through", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-gone", title: "Change the clock", status: "running" });
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      h.write("clock/panel.tsx", PANEL);
      h.write("hand/panel.tsx", PANEL);
      commitAll(h.workspaceDir);
      await service.refresh();
      const committed = Object.fromEntries(
        service.snapshot().extensions.map((e) => [e.id, e.frame?.version]),
      );
      // Left by a build whose session is gone (the app restarted mid-build):
      // the files name the task, which has not finished.
      h.write("clock/panel.tsx", `${PANEL}\n// half done`);
      h.write("clock/manifest.json", JSON.stringify({ origin: { taskId: "t-gone" } }));
      // Edited by hand, with no task behind it: it hot-reloads as it always has.
      h.write("hand/panel.tsx", `${PANEL}\n// by hand`);
      await service.refresh();
      const [clock, hand] = service.snapshot().extensions;
      expect(clock).toMatchObject({ id: "clock", running: true });
      expect(clock?.frame?.version).toBe(committed.clock);
      expect(hand?.frame?.version).not.toBe(committed.hand);
      // No session, no draft: nothing reads one.
      expect(service.snapshot().drafts).toBeUndefined();

      // Dropped before its report: still not ready, so still apart.
      h.tasks.close("t-gone", { status: "dropped", reason: "cancelled", actor: "host" });
      await service.refresh();
      expect(service.snapshot().extensions[0]).toMatchObject({ id: "clock", running: false });
      expect(service.snapshot().extensions[0]?.frame?.version).toBe(committed.clock);
    } finally {
      service.dispose();
    }
  });
});

/**
 * A build placed on the captain's own rail (INF-607, docs/personal-panels.md
 * "Placed on the rail"): the crewmate's `place_panel` puts its working
 * files where its last commit was, the answer is the window's own word,
 * and the capture photographs the docked panel. The window here is a stand-in
 * that answers every snapshot it is pushed the way the real one does
 * (src/renderer/src/plugins/panelMounts.ts): the app's own Activity drawn,
 * and each panel of the captain's with the state the test gives.
 */
describe("PersonalExtensions places a build on the rail", () => {
  type WindowWord = { state: PanelMountState; why: string | null };
  const APP_ACTIVITY = {
    id: "activity",
    kind: "app",
    version: null,
    state: "drawn",
    rail: "left",
    why: null,
  } as const;
  function windowFor(word: (id: string) => WindowWord | null) {
    const mounts = new PanelMountsHolder();
    const answer = (snapshot: PersonalSnapshot) =>
      queueMicrotask(() =>
        mounts.note({
          panels: [
            APP_ACTIVITY,
            ...snapshot.extensions.flatMap((view) => {
              const said = word(view.id);
              return said
                ? [
                    {
                      id: view.id,
                      kind: "personal" as const,
                      version: view.frame?.version ?? null,
                      rail: view.placement.x,
                      ...said,
                    },
                  ]
                : [];
            }),
          ],
        }),
      );
    return { mounts, answer };
  }

  it("puts a new panel's working files on the rail, answers with the window's word, and photographs it docked", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-new", title: "Build a clock", status: "running" });
    const window = windowFor(() => ({ state: "drawn", why: null }));
    const captureCalls: string[] = [];
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      mounts: window.mounts,
      emit: (channel, payload) => {
        h.emit(channel, payload);
        if (channel === "inf:plugins:personal") window.answer(payload as PersonalSnapshot);
      },
      capture: {
        capturePanel: async (input) => {
          captureCalls.push(input.panelId);
          return { png, width: 300, height: 120 };
        },
      },
    });
    try {
      service.beginLiveTask("t-new");
      h.write("fresh/panel.tsx", PANEL);
      await service.refresh();
      expect(service.snapshot().extensions).toEqual([]);
      const draftVersion = service.snapshot().drafts?.[0]?.frame?.version;
      const before = await service.capture("fresh", "t-new");
      expect(before).toMatchObject({ ok: true, photographed: "draft" });
      expect(renderCaptureText(before)).toContain("the captain's rail does not show it yet");

      const placed = await service.place("t-new");
      expect(placed).toMatchObject({
        ok: true,
        panels: [
          {
            id: "fresh",
            placed: true,
            mount: { state: "drawn", version: draftVersion, rail: "left" },
            last: null,
          },
        ],
      });
      expect(renderPlaceText(placed)).toContain("The window says it is drawn on the left rail.");
      // On the rail as the working files have it, with the running dot; no draft runs beside it.
      expect(service.snapshot().extensions).toMatchObject([
        { id: "fresh", running: true, frame: { version: draftVersion } },
      ]);
      expect(service.snapshot().drafts).toBeUndefined();
      // Nothing was committed: the report still makes the one save point.
      expect(
        execFileSync("git", ["-C", h.workspaceDir, "status", "--porcelain"], { encoding: "utf8" }),
      ).toContain("fresh/");
      captureCalls.length = 0;
      const docked = await service.capture("fresh", "t-new");
      expect(docked).toMatchObject({ ok: true, photographed: "docked" });
      expect(captureCalls).toEqual(["fresh", "fresh"]);

      // A save after placing runs apart again; the rail keeps what was placed.
      h.write("fresh/panel.tsx", `${PANEL}\n// smaller rows`);
      await service.refresh();
      expect(service.snapshot().extensions[0]?.frame?.version).toBe(draftVersion);
      const newer = service.snapshot().drafts?.[0]?.frame?.version;
      expect(newer).not.toBe(draftVersion);
      expect(await service.place("t-new", "fresh")).toMatchObject({
        ok: true,
        panels: [{ id: "fresh", placed: true, mount: { state: "drawn", version: newer } }],
      });
      expect(service.snapshot().drafts).toBeUndefined();

      // The report's commit holds it: the rail keeps the same version.
      await service.commitTurn("t-new", "A clock panel.");
      expect(service.snapshot().extensions[0]?.frame?.version).toBe(newer);
      expect(service.snapshot().drafts).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it("answers the window's refusal, never photographs the app's panel holding its id, and takes the placed version back at the task's end", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-live", title: "Change my activity panel", status: "running" });
    // The captain's own panel named after the app's Activity: the one
    // refusal a rail still makes (PR #187), in the window's words.
    const why =
      'side-panel: "activity" from "personal-activity" is already registered by "firstmate"';
    const window = windowFor(() => ({ state: "refused", why }));
    const captureCalls: string[] = [];
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      mounts: window.mounts,
      emit: (channel, payload) => {
        h.emit(channel, payload);
        if (channel === "inf:plugins:personal") window.answer(payload as PersonalSnapshot);
      },
      // The rail holds the app's Activity under that id, which the window
      // would photograph if it were asked.
      capture: {
        capturePanel: async (input) => {
          captureCalls.push(input.panelId);
          return { png: Buffer.from("89504e47", "hex"), width: 300, height: 120 };
        },
      },
    });
    try {
      h.write("activity/panel.tsx", PANEL);
      commitAll(h.workspaceDir);
      await service.refresh();
      const committed = service.snapshot().extensions[0]?.frame?.version;
      service.beginLiveTask("t-live");
      h.write("activity/panel.tsx", `${PANEL}\n// smaller rows`);
      const placed = await service.place("t-live", "activity");
      expect(placed).toMatchObject({
        ok: true,
        panels: [
          { id: "activity", placed: true, mount: { kind: "personal", state: "refused", why } },
        ],
      });
      expect(renderPlaceText(placed)).toContain(`The window says it is refused: ${why}.`);
      const capture = await service.capture("activity", "t-live");
      expect(capture).toEqual({
        ok: false,
        id: "activity",
        reason: `"activity" is not on screen: refused: ${why}`,
      });
      expect(captureCalls).toEqual([]);
      expect(service.snapshot().extensions[0]?.frame?.version).not.toBe(committed);

      // The task ended with no report: the rail goes back to the last commit.
      service.endLiveTask("t-live");
      await service.refresh();
      expect(service.snapshot().extensions[0]?.frame?.version).toBe(committed);
    } finally {
      service.dispose();
    }
  });

  it("says where a short rail put a placed panel: folded for room, or gathered into More with no picture to take", async () => {
    // INF-711: a panel the rail folded or gathered is built and on the
    // captain's rail; the crewmate hears where it sits, never "drawn".
    const h = await harness();
    seedTask(h.tasks, { id: "t-short", title: "Build a clock", status: "running" });
    let word: WindowWord = { state: "folded", why: null };
    const window = windowFor(() => word);
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      mounts: window.mounts,
      emit: (channel, payload) => {
        h.emit(channel, payload);
        if (channel === "inf:plugins:personal") window.answer(payload as PersonalSnapshot);
      },
      // The window has no box for a panel gathered into More, as for any
      // panel it does not show.
      capture: {
        capturePanel: async () =>
          word.state === "gathered"
            ? null
            : { png: Buffer.from("89504e47", "hex"), width: 300, height: 40 },
      },
    });
    try {
      service.beginLiveTask("t-short");
      h.write("fresh/panel.tsx", PANEL);
      const folded = renderPlaceText(await service.place("t-short"));
      expect(folded).toContain(
        "The window says it is on the left rail, folded to its header for room",
      );
      expect(folded).not.toContain("drawn");
      const header = await service.capture("fresh", "t-short");
      expect(header).toMatchObject({
        ok: true,
        photographed: "docked",
        window: { state: "folded" },
      });
      expect(renderCaptureText(header)).toContain("folded to its header for room");

      word = { state: "gathered", why: null };
      h.write("fresh/panel.tsx", `${PANEL}\n// smaller rows`);
      const gathered = renderPlaceText(await service.place("t-short"));
      expect(gathered).toContain(
        "The window says it is in the More row at the foot of the left rail",
      );
      const capture = await service.capture("fresh", "t-short");
      expect(capture).toMatchObject({ ok: false, id: "fresh" });
      expect(capture.ok ? "" : capture.reason).toContain(
        '"fresh" is not on screen: in the More row at the foot of the left rail',
      );
    } finally {
      service.dispose();
    }
  });

  it("says the window did not answer, and refuses with nothing to place", async () => {
    const h = await harness();
    seedTask(h.tasks, { id: "t-quiet", title: "Build a clock", status: "running" });
    const service = await PersonalExtensions.start({
      ...h,
      watch: false,
      mounts: new PanelMountsHolder(),
      placeWaitMs: 20,
    });
    try {
      service.beginLiveTask("t-quiet");
      expect(await service.place("t-quiet")).toEqual({
        ok: false,
        reason: "nothing to place: no extension has uncommitted changes. Pass id to look at one",
      });
      h.write("fresh/panel.tsx", PANEL);
      const placed = await service.place("t-quiet");
      expect(placed).toMatchObject({
        ok: true,
        panels: [{ id: "fresh", placed: true, mount: null, last: null }],
      });
      expect(renderPlaceText(placed)).toContain("The window did not answer for it");
    } finally {
      service.dispose();
    }
  });
});

describe("PersonalExtensions and the host-owned switch (Step 5)", () => {
  /**
   * Off is not a renderer trick: the core stops every server module and pushes ONE empty
   * snapshot, which is what unmounts the panels. A background task still
   * ticking, or a `server.ts` still answering, would mean the switch did
   * not take back what it promises to.
   */
  it("off unmounts everything personal in one push and stops the server modules; on brings them back", async () => {
    const h = await harness();
    h.write("prs/panel.tsx", PANEL);
    h.write("meter/manifest.json", JSON.stringify({ api: 2 }));
    h.write(
      "meter/server.ts",
      [
        "let ticks = 0;",
        "export const actions = { count: () => ticks };",
        "export const background = {",
        "  sample: { everyMs: 1000, run: async (context) => { ticks += 1; await context.db.set('ticks', ticks); } },",
        "};",
      ].join("\n"),
    );
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      expect(service.isEnabled).toBe(true);
      expect(service.snapshot().extensions.map((e) => e.id)).toEqual(["meter", "prs"]);
      await until(() => h.store.get("meter", "ticks") === 1);

      h.pushes.length = 0;
      await service.setEnabled(false);
      // One tick: one push, and it is empty.
      expect(h.pushes).toEqual([{ channel: "inf:plugins:personal", payload: { extensions: [] } }]);
      expect(service.isEnabled).toBe(false);
      expect(service.snapshot()).toEqual({ extensions: [] });
      // The server module is gone, not merely hidden: its action is
      // unreachable and its background timer is disposed with it.
      expect(await service.invoke("meter", "count", null)).toEqual({
        ok: false,
        error: '"meter" is not in the personal workspace',
      });
      const ticksWhenOff = h.store.get("meter", "ticks");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.store.get("meter", "ticks")).toBe(ticksWhenOff);

      // Setting it to what it already is changes nothing and pushes nothing.
      h.pushes.length = 0;
      await service.setEnabled(false);
      expect(h.pushes).toEqual([]);

      // On again: the workspace is scanned and the panels come back.
      await service.setEnabled(true);
      expect(service.snapshot().extensions.map((e) => e.id)).toEqual(["meter", "prs"]);
      expect(await service.invoke("meter", "count", null)).toMatchObject({ ok: true });
    } finally {
      service.dispose();
      rmSync(join(h.workspaceDir, ".."), { recursive: true, force: true });
    }
  });

  it("a rescan that changed nothing does not push again", async () => {
    const h = await harness();
    h.write("prs/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, watch: false });
    try {
      h.pushes.length = 0;
      await service.refresh();
      expect(h.pushes.filter((p) => p.channel === "inf:plugins:personal")).toEqual([]);
    } finally {
      service.dispose();
      rmSync(join(h.workspaceDir, ".."), { recursive: true, force: true });
    }
  });

  it("a save on disk reloads without a manual refresh", async () => {
    const h = await harness();
    h.write("clock/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, debounceMs: 20, pollMs: 25 });
    try {
      const first = service.snapshot().extensions[0]?.frame?.version;
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      h.write("clock/panel.tsx", `${PANEL}\n// edited`);
      await vi.waitFor(
        () => {
          expect(service.snapshot().extensions[0]?.frame?.version).not.toBe(first);
        },
        { timeout: 3_000, interval: 20 },
      );
    } finally {
      service.dispose();
      rmSync(join(h.workspaceDir, ".."), { recursive: true, force: true });
    }
  });

  it("starting off runs nothing at all: no seed, no scan, no compile", async () => {
    const h = await harness();
    h.write("prs/panel.tsx", PANEL);
    const service = await PersonalExtensions.start({ ...h, watch: false, enabled: false });
    try {
      expect(service.isEnabled).toBe(false);
      expect(service.snapshot()).toEqual({ extensions: [] });
      // The workspace was never seeded and nothing was compiled into the cache.
      expect(existsSync(join(h.workspaceDir, "AGENTS.md"))).toBe(false);
      expect(existsSync(h.cacheRoot)).toBe(false);
      // The two crewmate-facing checks say why rather than answering blankly.
      expect(await service.lint("prs")).toContain("turned off right now");
      expect(await service.capture("prs", "task-1")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("turned off right now"),
      });

      // The switch is the only way in, and it seeds on the way.
      await service.setEnabled(true);
      expect(service.snapshot().extensions.map((e) => e.id)).toEqual(["prs"]);
      expect(existsSync(join(h.workspaceDir, "AGENTS.md"))).toBe(true);
    } finally {
      service.dispose();
      rmSync(join(h.workspaceDir, ".."), { recursive: true, force: true });
    }
  });
});
