import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SqlAnswer, SqlParam, StoreValue } from "@shared/personal/contracts";
import { MIN_BACKGROUND_INTERVAL_MS } from "@shared/personal/manifest";
import type { HostChildProcess, HostChildSpawner } from "../host";
import type { StoreSlice } from "../personal/personalStore";
import {
  PANEL_BEAT_MS,
  PANEL_MESSAGE_MAX_BYTES,
  type PanelAskOp,
  type PanelChildMessage,
  type PanelLoadedTask,
  type PanelParentMessage,
} from "./panelProtocol";
import type { PanelRuntimeIdentity, PanelStop, PanelStops } from "./panelStops";

/**
 * The one owner of every panel's background work (INF-2205 piece B,
 * docs/personal-panels.md "Background work runs apart"). Whatever a panel's
 * source - the app's own, the captain's, or one added from elsewhere - its
 * permitted background module runs here the same way: in a process of its
 * own, one per running panel version and live or draft runtime, never in
 * the app's. The source decides only whether a panel may have background
 * work at all (admission, in the source's adapter) and its identity; how it
 * runs, how it is watched and how it is stopped are this owner's alone. A
 * panel with no background module starts no process.
 *
 * Watching: the process beats from the event loop the panel's code runs on
 * every `PANEL_BEAT_MS`, starting before it imports the module. A loop
 * silent for `PANEL_SILENCE_MS` is stopped: the stop is written first (so an
 * app that ends mid-stop keeps it), then the process is killed, and its end
 * is waited for; one that has not ended after `PANEL_KILL_WAIT_MS` is
 * killed by its process id, and the stop says whether the end was seen.
 * A process that ends on its own is stopped too. Every call waiting on a
 * stopped or disposed process is refused; writes it had acknowledged stay.
 *
 * A gap the owner's own check also slept through - the computer asleep, or
 * the app's own loop held - blames no panel: the watch starts over.
 */

/**
 * How long a panel's loop may stay silent before it is stopped. A healthy
 * loop beats every `PANEL_BEAT_MS` (250 ms); the process's start and the
 * module's import run before the first beat after spawn, and on a loaded
 * build machine they take well under a second (the integration test's
 * measured runs). Ten seconds is forty missed beats: only code that holds
 * its loop is past it, never a slow await.
 */
export const PANEL_SILENCE_MS = 10_000;
/** How long a killed process has to end before it is killed by its process id. */
export const PANEL_KILL_WAIT_MS = 2_000;

/** The calls the process makes on the app, bound to one runtime's store slice and grant. */
export type PanelRuntimeServices = {
  store: StoreSlice;
  sql: (sql: string, params?: SqlParam[]) => Promise<SqlAnswer>;
  log: (message: string) => void;
};

export type PanelRuntimeState = "starting" | "running" | "stopped" | "disposed";

/** One running panel's background work, as its source's adapter holds it. */
export type PanelRuntime = {
  readonly identity: PanelRuntimeIdentity;
  readonly actions: readonly string[];
  readonly background: readonly PanelLoadedTask[];
  readonly state: PanelRuntimeState;
  invoke: (action: string, input: unknown) => Promise<unknown>;
  dispose: () => void;
};

/** Thrown by `start` for a runtime the host stopped: what stopped it, for the adapter's snapshot. */
export class PanelStoppedError extends Error {
  constructor(readonly stop: PanelStop) {
    super(stoppedLine(stop));
    this.name = "PanelStoppedError";
  }
}

/** The words a refused call and a crewmate's lint read for a stopped runtime. */
export function stoppedLine(stop: PanelStop): string {
  return stop.reason === "exited"
    ? "Its background work ended on its own, so the app stopped it; Retry it from its panel once it is fixed."
    : "Its background work stopped responding, so the app stopped it; Retry it from its panel once it is fixed.";
}

export type PanelClock = {
  /** Monotonic milliseconds. */
  now: () => number;
  /** Wall time, for labels only. */
  wall: () => Date;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realClock: PanelClock = {
  now: () => performance.now(),
  wall: () => new Date(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type PanelRuntimesOptions = {
  /** Where a panel's process comes from; absent, no panel's background work can run. */
  spawner?: HostChildSpawner;
  stops: PanelStops;
  /** A running runtime the host just stopped, for its adapter to take off and push. */
  onStop?: (runtime: PanelRuntime, stop: PanelStop) => void;
  clock?: PanelClock;
  /** Ends a process by its id when its own kill did not; injected for tests. */
  killPid?: (pid: number) => void;
  beatMs?: number;
  silenceMs?: number;
  killWaitMs?: number;
  minIntervalMs?: number;
};

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class PanelRuntimes {
  private readonly clock: PanelClock;
  private readonly live = new Set<Runtime>();
  private readonly stopListeners = new Set<(runtime: PanelRuntime, stop: PanelStop) => void>();

  constructor(private readonly options: PanelRuntimesOptions) {
    this.clock = options.clock ?? realClock;
  }

  /** Hears every running runtime the host stops; returns the unsubscribe. */
  onStop(listener: (runtime: PanelRuntime, stop: PanelStop) => void): () => void {
    this.stopListeners.add(listener);
    return () => {
      this.stopListeners.delete(listener);
    };
  }

  /** Whether this app can run a panel's background work at all. */
  get available(): boolean {
    return this.options.spawner !== undefined;
  }

  /** The stop holding this runtime, or null. */
  holding(identity: PanelRuntimeIdentity): PanelStop | null {
    return this.options.stops.holding(identity);
  }

  /** The captain's Retry, or the panel's removal: the runtime may start again. */
  clear(identity: Omit<PanelRuntimeIdentity, "version">): boolean {
    return this.options.stops.clear(identity);
  }

  /**
   * Starts one panel's background module in its own process and resolves
   * once it has loaded. Rejects with `PanelStoppedError` for a runtime a
   * stop holds (nothing is spawned) or one stopped while it loaded, and
   * with the module's own words for one that would not import.
   */
  start(
    identity: PanelRuntimeIdentity,
    entryPath: string,
    services: PanelRuntimeServices,
  ): Promise<PanelRuntime> {
    const held = this.options.stops.holding(identity);
    if (held) return Promise.reject(new PanelStoppedError(held));
    const spawner = this.options.spawner;
    if (!spawner) {
      return Promise.reject(new Error("this app cannot run a panel's background work"));
    }
    const runtime = new Runtime(identity, spawner.spawn(), services, this.clock, {
      beatMs: this.options.beatMs ?? PANEL_BEAT_MS,
      silenceMs: this.options.silenceMs ?? PANEL_SILENCE_MS,
      killWaitMs: this.options.killWaitMs ?? PANEL_KILL_WAIT_MS,
      minIntervalMs: this.options.minIntervalMs ?? MIN_BACKGROUND_INTERVAL_MS,
      killPid: this.options.killPid ?? defaultKillPid,
      stops: this.options.stops,
      onStop: (stop) => {
        this.live.delete(runtime);
        this.options.onStop?.(runtime, stop);
        for (const listener of this.stopListeners) listener(runtime, stop);
      },
      onGone: () => this.live.delete(runtime),
    });
    this.live.add(runtime);
    return runtime.load(entryPath);
  }

  /** Every runtime still running: the app is quitting or the panels switch went off. */
  disposeAll(): void {
    for (const runtime of [...this.live]) runtime.dispose();
    this.live.clear();
  }

  /** How many runtimes are running now, for tests and Diagnostics. */
  get running(): number {
    return this.live.size;
  }
}

function defaultKillPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

type RuntimeSettings = {
  beatMs: number;
  silenceMs: number;
  killWaitMs: number;
  minIntervalMs: number;
  killPid: (pid: number) => void;
  stops: PanelStops;
  onStop: (stop: PanelStop) => void;
  onGone: () => void;
};

class Runtime implements PanelRuntime {
  state: PanelRuntimeState = "starting";
  actions: string[] = [];
  background: PanelLoadedTask[] = [];
  private calls = 0;
  private readonly waiting = new Map<number, Waiting>();
  private lastBeat: number;
  private lastCheck: number;
  private readonly watch: unknown;
  private exited = false;
  private readonly exitWaiters: (() => void)[] = [];
  private loading: Waiting | null = null;

  constructor(
    readonly identity: PanelRuntimeIdentity,
    private readonly child: HostChildProcess,
    private readonly services: PanelRuntimeServices,
    private readonly clock: PanelClock,
    private readonly settings: RuntimeSettings,
  ) {
    this.lastBeat = clock.now();
    this.lastCheck = this.lastBeat;
    child.onMessage((message) => this.receive(message as PanelChildMessage));
    child.onExit(() => this.exitedOnItsOwn());
    // The watch starts at spawn: the process's start and the import count.
    this.watch = clock.setInterval(() => this.check(), settings.beatMs);
  }

  load(entryPath: string): Promise<PanelRuntime> {
    return new Promise<PanelRuntime>((resolve, reject) => {
      this.loading = { resolve: () => resolve(this), reject };
      this.send({
        type: "load",
        entryUrl: pathToFileURL(entryPath).href,
        id: this.identity.id,
        minIntervalMs: this.settings.minIntervalMs,
        beatMs: this.settings.beatMs,
        maxBytes: PANEL_MESSAGE_MAX_BYTES,
      });
    });
  }

  invoke(action: string, input: unknown): Promise<unknown> {
    if (this.state !== "running") return Promise.reject(new Error(this.refusal()));
    const text = input === undefined ? "" : JSON.stringify(input);
    const bytes = text === undefined ? 0 : Buffer.byteLength(text);
    if (bytes > PANEL_MESSAGE_MAX_BYTES) {
      return Promise.reject(
        new Error(
          `the input is ${bytes} bytes of JSON; a panel's action takes at most ${PANEL_MESSAGE_MAX_BYTES}`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.calls += 1;
      this.waiting.set(this.calls, { resolve, reject });
      this.send({ type: "invoke", call: this.calls, action, input });
    });
  }

  dispose(): void {
    if (this.state === "disposed" || this.state === "stopped") return;
    this.state = "disposed";
    this.end(new Error(`"${this.identity.id}"'s background work was stopped by the app`));
    void this.kill();
    this.settings.onGone();
  }

  private refusal(): string {
    if (this.state === "stopped") {
      const stop = this.settings.stops.holding(this.identity);
      if (stop) return stoppedLine(stop);
    }
    return `"${this.identity.id}"'s background work is not running`;
  }

  private send(message: PanelParentMessage): void {
    this.child.postMessage(message);
  }

  private receive(message: PanelChildMessage): void {
    if (this.state === "disposed" || this.state === "stopped") return;
    switch (message.type) {
      case "beat":
        this.lastBeat = this.clock.now();
        return;
      case "loaded":
        this.actions = message.actions;
        this.background = message.background;
        this.state = "running";
        this.loading?.resolve(this);
        this.loading = null;
        return;
      case "failed": {
        const loading = this.loading;
        this.loading = null;
        this.dispose();
        loading?.reject(new Error(message.message));
        return;
      }
      case "result": {
        const waiting = this.waiting.get(message.call);
        this.waiting.delete(message.call);
        if (!waiting) return;
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(new Error(message.message));
        return;
      }
      case "log":
        this.services.log(message.message);
        return;
      case "ask":
        void this.answer(message.ask, message.op, message.input);
        return;
    }
  }

  /**
   * One ask, answered before the process sends the next. A runtime that was
   * stopped or replaced is answered nothing: its write never lands.
   */
  private async answer(ask: number, op: PanelAskOp, input: unknown[]): Promise<void> {
    const reply = (ok: boolean, valueOrMessage: unknown) => {
      if (this.state === "disposed" || this.state === "stopped") return;
      this.send(
        ok
          ? { type: "answer", ask, ok: true, value: valueOrMessage ?? null }
          : { type: "answer", ask, ok: false, message: String(valueOrMessage) },
      );
    };
    try {
      const { store } = this.services;
      const [first, second] = input;
      switch (op) {
        case "store.get":
          reply(true, store.get(String(first)) ?? null);
          return;
        case "store.set":
          store.set(String(first), (second ?? null) as StoreValue);
          reply(true, null);
          return;
        case "store.delete":
          store.delete(String(first));
          reply(true, null);
          return;
        case "store.list":
          reply(true, store.list(typeof first === "string" ? first : ""));
          return;
        case "sql": {
          const params = Array.isArray(second) ? (second as SqlParam[]) : [];
          reply(true, await this.services.sql(String(first), params));
          return;
        }
      }
    } catch (error) {
      reply(false, error instanceof Error ? error.message : String(error));
    }
  }

  private check(): void {
    if (this.state === "disposed" || this.state === "stopped") return;
    const now = this.clock.now();
    const sinceCheck = now - this.lastCheck;
    this.lastCheck = now;
    // This check slept too: the computer was asleep or the app's own loop
    // was held. Nothing proves the panel's loop was the one stuck.
    if (sinceCheck > this.settings.silenceMs / 2) {
      this.lastBeat = now;
      return;
    }
    const silentMs = now - this.lastBeat;
    if (silentMs >= this.settings.silenceMs) this.stop("unresponsive", Math.round(silentMs));
  }

  private exitedOnItsOwn(): void {
    this.exited = true;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    if (this.state === "disposed" || this.state === "stopped") return;
    this.stop("exited", null);
  }

  private stop(reason: "unresponsive" | "exited", silentMs: number | null): void {
    this.state = "stopped";
    const incidentId = randomUUID();
    const stop = {
      incidentId,
      reason,
      at: this.clock.wall().toISOString(),
      silentMs,
      termination: this.exited ? ("confirmed" as const) : ("pending" as const),
    };
    // Written before the kill: an app that ends now still keeps the stop.
    this.settings.stops.record(this.identity, stop);
    const recorded = { ...stop, version: this.identity.version };
    this.end(new Error(stoppedLine(recorded)));
    const loading = this.loading;
    this.loading = null;
    loading?.reject(new PanelStoppedError(recorded));
    this.settings.onStop(recorded);
    if (!this.exited) {
      void this.kill().then((termination) => {
        this.settings.stops.terminated(this.identity, incidentId, termination);
      });
    }
  }

  /** Every call waiting on this runtime is refused, and the watch ends. */
  private end(error: Error): void {
    this.clock.clearInterval(this.watch);
    for (const waiting of this.waiting.values()) waiting.reject(error);
    this.waiting.clear();
    if (this.loading && this.state === "disposed") {
      this.loading.reject(error);
      this.loading = null;
    }
  }

  /** Kills the process and waits to see it end; by its id when its own kill did not. */
  private async kill(): Promise<"confirmed" | "unconfirmed"> {
    if (this.exited) return "confirmed";
    this.child.kill();
    if (await this.exitWithin(this.settings.killWaitMs)) return "confirmed";
    const pid = this.child.pid;
    if (pid !== undefined) this.settings.killPid(pid);
    return (await this.exitWithin(this.settings.killWaitMs)) ? "confirmed" : "unconfirmed";
  }

  private exitWithin(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(this.exited), ms);
      this.exitWaiters.push(() => {
        this.clock.clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
