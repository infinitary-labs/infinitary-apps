import { describe, expect, it } from "vitest";
import type { HostChildProcess } from "../host";
import { openInMemoryDatabase } from "../storage/db";
import type { PanelChildMessage, PanelParentMessage } from "./panelProtocol";
import {
  type PanelClock,
  type PanelRuntimeServices,
  PanelRuntimes,
  PanelStoppedError,
} from "./panelRuntimes";
import { type PanelRuntimeIdentity, type PanelStop, PanelStops } from "./panelStops";

/**
 * The watch's decisions on a controlled clock (INF-2205 piece B, the
 * approved plan: "Derive/document liveness deadlines from healthy operation
 * and test decisions with controlled clocks"; "Sleep, hidden drawing and
 * connection loss do not establish panel blame"). The process is a stand-in
 * that beats only when told; the real process is the integration test's.
 */

const BEAT = 250;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SILENCE = 10_000;

class ManualClock implements PanelClock {
  t = 0;
  private timers: { at: number; every: number | null; fn: () => void; id: number }[] = [];
  private ids = 0;
  now = () => this.t;
  wall = () => new Date(Date.UTC(2026, 10, 2, 9, 0, 0) + this.t);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms, null);
  clearInterval = (handle: unknown) => this.remove(handle as number);
  clearTimeout = (handle: unknown) => this.remove(handle as number);
  private add(fn: () => void, ms: number, every: number | null): number {
    this.ids += 1;
    this.timers.push({ at: this.t + ms, every, fn, id: this.ids });
    return this.ids;
  }
  private remove(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
  advance(ms: number, each?: () => void): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      if (next.every === null) this.remove(next.id);
      else next.at += next.every;
      each?.();
      next.fn();
    }
    this.t = end;
  }
  /** Moves time forward with no timer firing: the whole computer asleep. */
  sleep(ms: number): void {
    this.t += ms;
    for (const timer of this.timers) timer.at = Math.max(timer.at, this.t);
  }
}

class StandIn implements HostChildProcess {
  readonly pid = 4242;
  sent: PanelParentMessage[] = [];
  killed = 0;
  private listeners: ((message: unknown) => void)[] = [];
  private exits: ((code: number | null) => void)[] = [];
  postMessage = (message: unknown) => {
    this.sent.push(message as PanelParentMessage);
  };
  onMessage = (listener: (message: unknown) => void) => {
    this.listeners.push(listener);
  };
  onExit = (listener: (code: number | null) => void) => {
    this.exits.push(listener);
  };
  kill = () => {
    this.killed += 1;
    this.exit(null);
  };
  say(message: PanelChildMessage): void {
    for (const listener of this.listeners) listener(message);
  }
  exit(code: number | null): void {
    const exits = this.exits.splice(0);
    for (const listener of exits) listener(code);
  }
}

const services: PanelRuntimeServices = {
  store: { get: () => undefined, set: () => {}, delete: () => {}, list: () => [] },
  sql: async () => ({ refused: "sql_invalid", message: "none" }),
  log: () => {},
};

function setup() {
  const clock = new ManualClock();
  const children: StandIn[] = [];
  const stops = new PanelStops(openInMemoryDatabase());
  const stopped: PanelStop[] = [];
  const runtimes = new PanelRuntimes({
    spawner: {
      spawn: () => {
        const child = new StandIn();
        children.push(child);
        return child;
      },
    },
    stops,
    clock,
    beatMs: BEAT,
    silenceMs: SILENCE,
    onStop: (_runtime, stop) => stopped.push(stop),
  });
  return { clock, children, stops, stopped, runtimes };
}

const identity: PanelRuntimeIdentity = {
  source: "yours",
  id: "meter",
  runtime: "live",
  version: "v1",
};

describe("PanelRuntimes' watch", () => {
  it("never stops a panel whose loop keeps beating through a long wait", async () => {
    const { clock, children, runtimes, stopped } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    const child = children[0] as StandIn;
    child.say({ type: "loaded", actions: ["slow"], background: [] });
    const runtime = await started;
    const answer = runtime.invoke("slow", null);
    // A minute of a slow await: the loop is free, so it beats.
    clock.advance(60_000, () => child.say({ type: "beat" }));
    expect(stopped).toEqual([]);
    const call = child.sent.find((m) => m.type === "invoke");
    child.say({
      type: "result",
      call: call?.type === "invoke" ? call.call : 0,
      ok: true,
      value: 7,
    });
    await expect(answer).resolves.toBe(7);
    expect(runtime.state).toBe("running");
  });

  it("stops a loop silent for the deadline, records the stop first, and refuses its waiting calls", async () => {
    const { clock, children, runtimes, stops, stopped } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    const child = children[0] as StandIn;
    child.say({ type: "loaded", actions: ["spin"], background: [] });
    const runtime = await started;
    const answer = runtime.invoke("spin", null);
    clock.advance(SILENCE - BEAT);
    expect(stopped).toEqual([]);
    clock.advance(BEAT);
    await expect(answer).rejects.toThrow(/stopped responding/);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ reason: "unresponsive", silentMs: SILENCE, version: "v1" });
    expect(child.killed).toBe(1);
    await flush();
    expect(stops.holding(identity)).toMatchObject({
      reason: "unresponsive",
      termination: "confirmed",
    });
    expect(runtime.state).toBe("stopped");
    await expect(runtime.invoke("spin", null)).rejects.toThrow(/Retry/);
  });

  it("blames no panel for a gap its own watch slept through", async () => {
    const { clock, children, runtimes, stopped } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    const child = children[0] as StandIn;
    child.say({ type: "loaded", actions: [], background: [] });
    await started;
    clock.advance(1_000, () => child.say({ type: "beat" }));
    // The computer sleeps for an hour: no timer of anyone's fires.
    clock.sleep(3_600_000);
    clock.advance(BEAT);
    expect(stopped).toEqual([]);
    clock.advance(5_000, () => child.say({ type: "beat" }));
    expect(stopped).toEqual([]);
  });

  it("stops one whose import never returns, so start rejects with the stop and nothing runs", async () => {
    const { clock, runtimes } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    clock.advance(SILENCE);
    const error = await started.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PanelStoppedError);
    expect(runtimes.running).toBe(0);
  });

  it("kills by process id when the process outlives its own kill, and says whether its end was seen", async () => {
    const clock = new ManualClock();
    const stops = new PanelStops(openInMemoryDatabase());
    const child = new StandIn();
    child.kill = () => {
      child.killed += 1;
    };
    const killedPids: number[] = [];
    const runtimes = new PanelRuntimes({
      spawner: { spawn: () => child },
      stops,
      clock,
      beatMs: BEAT,
      silenceMs: SILENCE,
      killWaitMs: 2_000,
      killPid: (pid) => killedPids.push(pid),
    });
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    child.say({ type: "loaded", actions: [], background: [] });
    await started;
    clock.advance(SILENCE);
    expect(stops.holding(identity)?.termination).toBe("pending");
    await flush();
    clock.advance(2_000);
    await flush();
    expect(killedPids).toEqual([4242]);
    clock.advance(2_000);
    await flush();
    expect(stops.holding(identity)?.termination).toBe("unconfirmed");
  });

  it("stops one whose process ended on its own", async () => {
    const { children, runtimes, stopped } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    const child = children[0] as StandIn;
    child.say({ type: "loaded", actions: [], background: [] });
    await started;
    child.exit(1);
    expect(stopped).toMatchObject([{ reason: "exited", silentMs: null, termination: "confirmed" }]);
  });

  it("starts nothing for a live panel a stop holds, at any version, until Retry", async () => {
    const { clock, children, runtimes } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", services);
    clock.advance(SILENCE);
    await started.catch(() => undefined);
    const next = { ...identity, version: "v2" };
    await expect(runtimes.start(next, "/tmp/server.mjs", services)).rejects.toBeInstanceOf(
      PanelStoppedError,
    );
    expect(children).toHaveLength(1);
    // A draft of the fix is tried apart.
    const draft = runtimes.start({ ...next, runtime: "draft" }, "/tmp/server.mjs", services);
    expect(children).toHaveLength(2);
    (children[1] as StandIn).say({ type: "loaded", actions: [], background: [] });
    await draft;
    expect(runtimes.clear(identity)).toBe(true);
    const again = runtimes.start(next, "/tmp/server.mjs", services);
    (children[2] as StandIn).say({ type: "loaded", actions: [], background: [] });
    await expect(again).resolves.toMatchObject({ state: "running" });
  });

  it("answers no ask of a runtime that was replaced", async () => {
    const writes: string[] = [];
    const { children, runtimes } = setup();
    const started = runtimes.start(identity, "/tmp/server.mjs", {
      ...services,
      store: { ...services.store, set: (key) => writes.push(key) },
    });
    const child = children[0] as StandIn;
    child.say({ type: "loaded", actions: [], background: [] });
    const runtime = await started;
    runtime.dispose();
    child.say({ type: "ask", ask: 1, op: "store.set", input: ["late", 1] });
    expect(writes).toEqual([]);
    expect(child.sent.filter((m) => m.type === "answer")).toEqual([]);
  });
});
