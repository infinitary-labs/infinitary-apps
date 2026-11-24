import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { undeclaredIntegrationMessage } from "@shared/personal/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostChildSpawner } from "../host";
import { githubIntegration, IntegrationSettingsStore, IntegrationsService } from "../integrations";
import { PersonalStore } from "../personal/personalStore";
import { forkChildProcess } from "../sql/forkChildProcess";
import { openInMemoryDatabase } from "../storage/db";
import {
  NO_PANEL_INTEGRATIONS,
  type PanelRuntime,
  type PanelRuntimeServices,
  PanelRuntimes,
  PanelStoppedError,
} from "./panelRuntimes";
import {
  type PanelRuntimeIdentity,
  type PanelSource,
  type PanelStop,
  PanelStops,
} from "./panelStops";

/**
 * The real panel process under the real runtime owner (INF-2205 piece B,
 * the approved plan's acceptance: "Integration checks cover
 * import/action/timer hangs, native waits, child exit and confirmed
 * termination, store acknowledgements, ... late replies and cleanup", and
 * "One parameterized panel contract suite must exercise built-in, personal
 * and installed sources through the same lifecycle and containment
 * owners"). Each fixture is a compiled background module as the compiler
 * writes one. Every stop is read from the stop record, never from timing.
 *
 * The watch here is shortened to a 100 ms beat and a 1.5 s silence so a
 * case ends quickly; the app's own deadline is PANEL_SILENCE_MS. A case's
 * fastest measured run is under 2 s (a hang waits out the silence and the
 * kill), so the budget is 10 s (docs/test-cohorts.md, "Budgets").
 */
vi.setConfig({ testTimeout: 10_000 });

const ENTRY = fileURLToPath(new URL("./panelProcess.ts", import.meta.url));

const open: PanelRuntimes[] = [];
afterEach(() => {
  for (const runtimes of open.splice(0)) runtimes.disposeAll();
});

function setup(options: { spawner?: HostChildSpawner; startMs?: number } = {}) {
  const db = openInMemoryDatabase();
  const store = new PersonalStore(db);
  const stops = new PanelStops(db);
  const stopped: { runtime: PanelRuntime; stop: PanelStop }[] = [];
  const runtimes = new PanelRuntimes({
    spawner: options.spawner ?? forkChildProcess(ENTRY),
    stops,
    beatMs: 100,
    silenceMs: 1_500,
    ...(options.startMs !== undefined ? { startMs: options.startMs } : {}),
    killWaitMs: 1_000,
    minIntervalMs: 50,
    onStop: (runtime, stop) => stopped.push({ runtime, stop }),
  });
  open.push(runtimes);
  const dir = scratchDir("panel-runtime-");
  const logs: string[] = [];
  const servicesFor = (slice: string): PanelRuntimeServices => ({
    store: store.forExtension(slice),
    sql: async (sql) => ({ columns: ["q"], rows: [{ q: sql }], truncated: false, elapsedMs: 0 }),
    log: (message) => logs.push(message),
  });
  const module = (name: string, source: string): string => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, source);
    return path;
  };
  return { runtimes, stops, store, stopped, servicesFor, module, logs };
}

/**
 * The real panel process, held for `stallMs` before any of its own code
 * runs: alive, with its pid, but silent, as a process starting on a machine
 * short of memory is while it reads its code back in. What the owner sends
 * meanwhile waits in the channel, as it waits for a utility process.
 */
function slowToStart(stallMs: number): HostChildSpawner {
  const entry = join(scratchDir("panel-slow-start-"), "slow-start.mjs");
  writeFileSync(
    entry,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${stallMs});
await import(${JSON.stringify(pathToFileURL(ENTRY).href)});`,
  );
  return forkChildProcess(entry);
}

/** Resolves once `check` holds, polled on the event loop; the test's budget bounds it. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 20));
}

const SOURCES: PanelSource[] = ["builtin", "yours", "installed"];

describe.each(SOURCES)("a %s panel's background work, run apart", (source) => {
  const identity = (id: string, runtime: "live" | "draft" = "live"): PanelRuntimeIdentity => ({
    source,
    id,
    runtime,
    version: "v1",
  });

  it("answers actions, writes its store slice through acknowledged asks, and runs its tasks", async () => {
    const { runtimes, store, servicesFor, module } = setup();
    const entry = module(
      "meter",
      `let calls = 0;
export const actions = {
  bump: async (input, { db }) => {
    calls += 1;
    await db.set("count", calls);
    return { calls, got: await db.get("count"), input };
  },
  ask: (_input, { sql }) => sql("SELECT 1"),
};
export const background = {
  tick: { everyMs: 1, run: async ({ db }) => { await db.set("ticked", true); } },
};`,
    );
    const runtime = await runtimes.start(identity("meter"), entry, servicesFor("meter"));
    expect(runtime.actions).toEqual(["bump", "ask"]);
    expect(runtime.background).toEqual([{ id: "tick", everyMs: 50, declaredMs: 1 }]);
    await expect(runtime.invoke("bump", "x")).resolves.toEqual({ calls: 1, got: 1, input: "x" });
    await expect(runtime.invoke("bump", null)).resolves.toMatchObject({ calls: 2 });
    expect(store.get("meter", "count")).toBe(2);
    await until(() => store.get("meter", "ticked") === true);
    await expect(runtime.invoke("ask", null)).resolves.toMatchObject({ rows: [{ q: "SELECT 1" }] });
    await expect(runtime.invoke("missing", null)).rejects.toThrow(/no action "missing"/);
  });

  it("refuses an unknown action by name, ignores what is not a function, and never overlaps a task", async () => {
    const { runtimes, store, logs, servicesFor, module } = setup();
    const entry = module(
      "clock",
      `let running = 0;
let most = 0;
let runs = 0;
export const actions = { notes: () => ({ runs, most }), notAFunction: 3 };
export const background = {
  fast: {
    everyMs: 1,
    run: async ({ db }) => {
      running += 1;
      runs += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 300));
      running -= 1;
      await db.set("runs", runs);
    },
  },
  slow: { everyMs: 300000, run: () => { throw new Error("boom"); } },
  malformed: { everyMs: -1, run: () => {} },
};`,
    );
    const runtime = await runtimes.start(identity("clock"), entry, servicesFor("clock"));
    expect(runtime.actions).toEqual(["notes"]);
    expect(runtime.background).toEqual([
      { id: "fast", everyMs: 50, declaredMs: 1 },
      { id: "slow", everyMs: 300000, declaredMs: 300000 },
    ]);
    await expect(runtime.invoke("nope", null)).rejects.toThrow('no action "nope" (it has notes)');
    await until(() => ((store.get("clock", "runs") as number | undefined) ?? 0) >= 2);
    // Ticks every 50 ms against a 300 ms run: a tick in flight is skipped.
    await expect(runtime.invoke("notes", null)).resolves.toMatchObject({ most: 1 });
    expect(logs).toContain('background task "slow" failed: boom');
  });

  it("stops an action that holds its loop, keeps its acknowledged write, and leaves a sibling answering", async () => {
    const { runtimes, stops, store, stopped, servicesFor, module } = setup();
    const spin = module(
      "spin",
      `export const actions = {
  spin: async (_input, { db }) => { await db.set("before", 1); for (;;) {} },
};`,
    );
    const calm = module("calm", `export const actions = { ping: () => "pong" };`);
    const offender = await runtimes.start(identity("spin"), spin, servicesFor("spin"));
    const sibling = await runtimes.start(identity("calm"), calm, servicesFor("calm"));
    await expect(offender.invoke("spin", null)).rejects.toThrow(/stopped responding/);
    expect(stopped.map((entry) => entry.runtime.identity.id)).toEqual(["spin"]);
    expect(store.get("spin", "before")).toBe(1);
    await expect(sibling.invoke("ping", null)).resolves.toBe("pong");
    await until(() => stops.holding(identity("spin"))?.termination === "confirmed");
    expect(stops.holding(identity("calm"))).toBeNull();
  });

  it("stops a module whose import never returns, and starts nothing for it again", async () => {
    const { runtimes, stops, servicesFor, module } = setup();
    const entry = module("stuck", "for (;;) {}\nexport const actions = {};");
    const error = await runtimes
      .start(identity("stuck"), entry, servicesFor("stuck"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PanelStoppedError);
    expect(stops.holding(identity("stuck"))).toMatchObject({ reason: "unresponsive" });
    await expect(
      runtimes.start(identity("stuck"), entry, servicesFor("stuck")),
    ).rejects.toBeInstanceOf(PanelStoppedError);
  });

  it("stops a background task that holds its loop", async () => {
    const { runtimes, stopped, servicesFor, module } = setup();
    const entry = module(
      "timer",
      "export const background = { loop: { everyMs: 60000, run: () => { for (;;) {} } } };",
    );
    await runtimes.start(identity("timer"), entry, servicesFor("timer"));
    await until(() => stopped.length === 1);
    expect(stopped[0]?.stop).toMatchObject({ reason: "unresponsive" });
  });

  it("stops one held in a native wait and sees its process end", async () => {
    const { runtimes, stops, servicesFor, module } = setup();
    const entry = module(
      "native",
      `export const actions = {
  wait: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000),
};`,
    );
    const runtime = await runtimes.start(identity("native"), entry, servicesFor("native"));
    await expect(runtime.invoke("wait", null)).rejects.toThrow(/stopped responding/);
    await until(() => stops.holding(identity("native"))?.termination === "confirmed");
  });

  it("stops one whose process ended on its own and refuses the call it left waiting", async () => {
    const { runtimes, stopped, servicesFor, module } = setup();
    const entry = module("quits", "export const actions = { quit: () => process.exit(3) };");
    const runtime = await runtimes.start(identity("quits"), entry, servicesFor("quits"));
    await expect(runtime.invoke("quit", null)).rejects.toThrow(/ended on its own/);
    expect(stopped[0]?.stop).toMatchObject({ reason: "exited", termination: "confirmed" });
  });

  it("refuses a module that will not import, in its own words, and records no stop", async () => {
    const { runtimes, stops, servicesFor, module } = setup();
    const entry = module("broken", 'throw new Error("no clock today");');
    await expect(runtimes.start(identity("broken"), entry, servicesFor("broken"))).rejects.toThrow(
      "no clock today",
    );
    expect(stops.holding(identity("broken"))).toBeNull();
    expect(runtimes.running).toBe(0);
  });
});

// A process's start runs none of the panel's code, so it is not held to the
// silence deadline the panel's loop is: on a machine short of memory a start
// outlasted it and the panel's first call was refused.
describe("a panel's process slow to start", () => {
  const identity: PanelRuntimeIdentity = {
    source: "yours",
    id: "late",
    runtime: "live",
    version: "v1",
  };

  it("answers its first call though its start outlasts the silence deadline", async () => {
    const { runtimes, stops, store, servicesFor, module } = setup({
      spawner: slowToStart(2_500),
      startMs: 6_000,
    });
    const entry = module(
      "late",
      `export const actions = {
  fill: async (input, { db }) => { await db.set("items", input); return { filled: input.length }; },
};`,
    );
    const runtime = await runtimes.start(identity, entry, servicesFor("late"));
    await expect(runtime.invoke("fill", ["alpha", "beta", "gamma"])).resolves.toEqual({
      filled: 3,
    });
    expect(store.get("late", "items")).toEqual(["alpha", "beta", "gamma"]);
    expect(stops.holding(identity)).toBeNull();
  });

  it("stops one that never starts once its start allowance has passed, and sees it end", async () => {
    const { runtimes, stops, servicesFor, module } = setup({
      spawner: slowToStart(600_000),
      startMs: 3_000,
    });
    const entry = module("never", "export const actions = {};");
    const error = await runtimes
      .start(identity, entry, servicesFor("never"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PanelStoppedError);
    expect((error as PanelStoppedError).stop).toMatchObject({ reason: "unresponsive" });
    expect((error as PanelStoppedError).stop.silentMs).toBeGreaterThanOrEqual(3_000);
    await until(() => stops.holding(identity)?.termination === "confirmed");
  });
});

// INF-2334 piece 1, the captain's consent A ("one rule for every caller"):
// a panel's background code reaches GitHub through `context.integrations`,
// the same service and binding the agents use, here over a stand-in gateway
// that answers in GitHub's shape. A call its manifest does not name is
// refused before anything is sent. (The gateway's own panel reads, past a
// task's whole allowance, are `gateway.test.ts`'s.)
describe("a panel's background work reaches its integrations", () => {
  it("calls GitHub as the panel through the integration, and is refused what its manifest does not name", async () => {
    const sent: { panel: string; path: string }[] = [];
    const integrations = new IntegrationsService({
      bindings: [
        githubIntegration({
          signIns: {
            stateOf: () => "ok",
            loginOf: () => "kunchenguid",
            checkNow: async () => {},
            signOut: () => {},
          },
          gateway: {
            read: async () => {
              throw new Error("a panel's call never goes as a task's");
            },
            write: async () => {
              throw new Error("a panel's call never goes as a task's");
            },
            readAsSeat: async () => {
              throw new Error("a panel's call never goes as the first mate's");
            },
            writeAsSeat: async () => {
              throw new Error("a panel's call never goes as the first mate's");
            },
            readAsPanel: async (panel, input) => {
              sent.push({ panel, path: input.path });
              return JSON.stringify({ status: 200, body: { login: "kunchenguid" } });
            },
            writeAsPanel: async () => {
              throw new Error("the panel names no write");
            },
          },
        }),
      ],
      store: new IntegrationSettingsStore(join(scratchDir("panel-integrations-"), "integrations")),
    });
    // The captain's rule in Settings: GitHub's read is always allowed.
    integrations.setRule("github", "read", true);
    const reach = integrations.forPanel({
      key: "yours:pr-checks",
      title: "PR checks",
      uses: [{ integration: "github", actions: ["read"], why: "Shows your pull requests." }],
    });
    const { runtimes, servicesFor, module } = setup();
    const entry = module(
      "pr-checks",
      `export const actions = {
  reads: (_input, { integrations }) => integrations.call("github", "read", { path: "/user" }),
  writes: (_input, { integrations }) =>
    integrations.call("github", "write", { method: "POST", path: "/user/repos", body: "{}" }),
  lists: (_input, { integrations }) => integrations.list(),
};`,
    );
    const runtime = await runtimes.start(
      { source: "yours", id: "pr-checks", runtime: "live", version: "v1" },
      entry,
      {
        ...servicesFor("pr-checks"),
        integrations: {
          list: async () => reach.list(),
          show: async (name) => reach.show(name),
          call: (name, action, input) => reach.call(name, action, input),
        },
      },
    );
    const answer = (await runtime.invoke("reads", null)) as { text: string; refused?: string };
    expect(answer.refused).toBeUndefined();
    expect(JSON.parse(answer.text)).toMatchObject({ status: 200, body: { login: "kunchenguid" } });
    expect(sent).toEqual([{ panel: "yours:pr-checks", path: "/user" }]);

    await expect(runtime.invoke("writes", null)).resolves.toEqual({
      text: undeclaredIntegrationMessage("GitHub", { action: "write" }),
      refused: "refused",
    });
    expect(sent).toHaveLength(1);
    const listed = (await runtime.invoke("lists", null)) as { actions: { name: string }[] }[];
    expect(listed.map((entry) => entry.actions.map((action) => action.name))).toEqual([["read"]]);
  });

  it("answers every call of a panel whose host serves it no integrations in one wording", async () => {
    const { runtimes, servicesFor, module } = setup();
    const entry = module(
      "bare",
      `export const actions = {
  calls: (_input, { integrations }) => integrations.call("github", "read", { path: "/user" }),
  lists: (_input, { integrations }) => integrations.list(),
};`,
    );
    const runtime = await runtimes.start(
      { source: "yours", id: "bare", runtime: "live", version: "v1" },
      entry,
      servicesFor("bare"),
    );
    await expect(runtime.invoke("calls", null)).resolves.toEqual({
      text: NO_PANEL_INTEGRATIONS,
      refused: "refused",
    });
    await expect(runtime.invoke("lists", null)).resolves.toEqual([]);
  });
});
