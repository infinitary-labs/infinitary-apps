import type {
  PanelAskOp,
  PanelChildMessage,
  PanelLoadedTask,
  PanelParentMessage,
} from "./panelProtocol";

/**
 * One panel's background process (INF-2205 piece B, docs/personal-panels.md
 * "Background work runs apart"): the only place a panel's background module
 * is imported, its actions are called and its background tasks run. One
 * process per running panel version, live or draft, started by the core's
 * `PanelRuntimes` through `HostCapabilities.panelProcess`.
 *
 * It beats from its own event loop, the loop the panel's code runs on, and
 * starts beating before it imports the module: a module, action or task
 * that never gives the loop back - a loop, a native wait - stops the beats,
 * and the core stops this process. A slow asynchronous action gives the
 * loop back while it waits, so it keeps beating and is never stopped.
 *
 * The panel's store and query are asks to the core, sent one at a time:
 * the next waits in this process until the core acknowledged the last. Its
 * integrations' asks wait the same way in a lane of their own, so a slow
 * call to a place never holds a store write behind it.
 * Every value crossing to the core is JSON and at most `maxBytes`.
 *
 * The same file runs under Electron's `utilityProcess` in the app and under
 * a plain `fork` in tests, so it speaks to whichever parent port it was
 * given. It imports nothing but Node itself, so a test forks it as it stands.
 */

type Port = {
  send: (message: PanelChildMessage) => void;
  listen: (listener: (message: PanelParentMessage) => void) => void;
};

function parentPort(): Port {
  const electronPort = (
    process as unknown as {
      parentPort?: {
        postMessage: (message: unknown) => void;
        on: (event: "message", listener: (event: { data: unknown }) => void) => void;
      };
    }
  ).parentPort;
  if (electronPort) {
    return {
      send: (message) => electronPort.postMessage(message),
      listen: (listener) =>
        electronPort.on("message", (event) => listener(event.data as PanelParentMessage)),
    };
  }
  if (process.send) {
    const send = process.send.bind(process);
    return {
      send: (message) => {
        send(message);
      },
      listen: (listener) =>
        process.on("message", (message) => listener(message as PanelParentMessage)),
    };
  }
  throw new Error("the panel process has no parent to answer");
}

type Action = (input: unknown, context: unknown) => unknown;
type Task = { everyMs: number; runOnStart?: boolean; run: (context: unknown) => unknown };

const port = parentPort();
let maxBytes = Number.POSITIVE_INFINITY;
let loaded = false;
const actions = new Map<string, Action>();

function errorText(error: unknown): string {
  if (error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function log(message: string): void {
  port.send({ type: "log", message: String(message).slice(0, 4_000) });
}

/** A value as JSON, refused past the bound, with nothing returned read as null. */
function asJson(value: unknown, what: string): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) {
    throw new Error(`${what} is ${bytes} bytes of JSON; the app takes at most ${maxBytes}`);
  }
  return JSON.parse(text) as unknown;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Lane = {
  queue: { op: PanelAskOp; input: unknown[]; pending: Pending }[];
  waiting: Map<number, Pending>;
};
const lanes: Record<"store" | "integrations", Lane> = {
  store: { queue: [], waiting: new Map() },
  integrations: { queue: [], waiting: new Map() },
};
let asks = 0;

function pump(lane: Lane): void {
  if (lane.waiting.size > 0) return;
  const next = lane.queue.shift();
  if (!next) return;
  asks += 1;
  lane.waiting.set(asks, next.pending);
  port.send({ type: "ask", ask: asks, op: next.op, input: next.input });
}

function ask(op: PanelAskOp, input: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let checked: unknown[];
    try {
      checked = asJson(input, `the ${op} call`) as unknown[];
    } catch (error) {
      reject(error as Error);
      return;
    }
    // An integration's ask waits in its own lane (`PanelAskOp`).
    const lane = lanes[op.startsWith("integrations.") ? "integrations" : "store"];
    lane.queue.push({ op, input: checked, pending: { resolve, reject } });
    pump(lane);
  });
}

type EventListener = (items: { id: string; summary: string }[]) => void;
const listeners = new Map<string, Set<EventListener>>();

function eventKey(integration: string, event: string): string {
  return `${integration}\u0000${event}`;
}

function heard(message: Extract<PanelParentMessage, { type: "event" }>): void {
  for (const listener of listeners.get(eventKey(message.integration, message.event)) ?? []) {
    try {
      listener(message.items);
    } catch (error) {
      log(`listener for "${message.integration}" ${message.event} failed: ${errorText(error)}`);
    }
  }
}

function contextFor(id: string): unknown {
  return Object.freeze({
    id,
    db: Object.freeze({
      get: (key: string) => ask("store.get", [key]).then((value) => value ?? undefined),
      set: (key: string, value: unknown) => ask("store.set", [key, value]).then(() => undefined),
      delete: (key: string) => ask("store.delete", [key]).then(() => undefined),
      list: (prefix?: string) => ask("store.list", [prefix ?? ""]),
    }),
    log,
    sql: (sql: string, params?: unknown[]) => ask("sql", [sql, params ?? []]),
    integrations: Object.freeze({
      list: () => ask("integrations.list", []),
      show: (name: string) => ask("integrations.show", [String(name)]),
      call: (name: string, action: string, input?: unknown) =>
        ask("integrations.call", [String(name), String(action), input ?? {}]),
      on: (integration: string, event: string, listener: EventListener) => {
        const key = eventKey(String(integration), String(event));
        const set = listeners.get(key) ?? new Set<EventListener>();
        set.add(listener);
        listeners.set(key, set);
        return () => {
          set.delete(listener);
        };
      },
    }),
  });
}

function namedActions(value: unknown): Map<string, Action> {
  const out = new Map<string, Action>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, handler] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim().length > 0 && typeof handler === "function") out.set(name, handler as Action);
  }
  return out;
}

function namedTasks(value: unknown): Map<string, Task> {
  const out = new Map<string, Task>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object") continue;
    const task = candidate as Partial<Task>;
    if (typeof task.run !== "function") continue;
    if (typeof task.everyMs !== "number" || !Number.isFinite(task.everyMs) || task.everyMs <= 0) {
      continue;
    }
    out.set(id, task as Task);
  }
  return out;
}

async function load(message: Extract<PanelParentMessage, { type: "load" }>): Promise<void> {
  maxBytes = message.maxBytes;
  // Beating starts before the import: a module whose top level never
  // returns stops the beats as surely as an action that never does.
  setInterval(() => port.send({ type: "beat" }), message.beatMs);
  port.send({ type: "beat" });
  let raw: { actions?: unknown; background?: unknown };
  try {
    raw = (await import(message.entryUrl)) as typeof raw;
  } catch (error) {
    port.send({ type: "failed", message: errorText(error) });
    return;
  }
  const context = contextFor(message.id);
  shared = context;
  for (const [name, handler] of namedActions(raw.actions)) actions.set(name, handler);
  const background: PanelLoadedTask[] = [];
  const starts: (() => void)[] = [];
  for (const [id, task] of namedTasks(raw.background)) {
    const everyMs = Math.max(task.everyMs, message.minIntervalMs);
    background.push({ id, everyMs, declaredMs: task.everyMs });
    let running = false;
    const tick = async (): Promise<void> => {
      // A run still in flight when its tick arrives is skipped, never overlapped.
      if (running) return;
      running = true;
      try {
        await task.run(context);
      } catch (error) {
        log(`background task "${id}" failed: ${errorText(error)}`);
      } finally {
        running = false;
      }
    };
    setInterval(() => void tick(), everyMs);
    if (task.runOnStart !== false) starts.push(() => void tick());
  }
  loaded = true;
  port.send({ type: "loaded", actions: [...actions.keys()], background });
  for (const start of starts) start();
}

async function invoke(call: number, action: string, input: unknown): Promise<void> {
  const handler = actions.get(action);
  if (!loaded || !handler) {
    port.send({
      type: "result",
      call,
      ok: false,
      message:
        `"${currentId}" has no action "${action}"` +
        (actions.size > 0 ? ` (it has ${[...actions.keys()].join(", ")})` : ""),
    });
    return;
  }
  try {
    const value = asJson(await handler(input, shared), `"${action}"'s answer`);
    port.send({ type: "result", call, ok: true, value });
  } catch (error) {
    port.send({ type: "result", call, ok: false, message: errorText(error) });
  }
}

let currentId = "";
/** The one context every action and task of the module is handed. */
let shared: unknown = null;

// A part the panel's code never awaited may fail on its own; the process goes on, as it did in the app.
process.on("unhandledRejection", (reason) => log(`unhandled: ${errorText(reason)}`));
process.on("uncaughtException", (error) => log(`uncaught: ${errorText(error)}`));

port.listen((message) => {
  if (message.type === "load") {
    if (currentId) return;
    currentId = message.id;
    void load(message);
    return;
  }
  if (message.type === "invoke") {
    void invoke(message.call, message.action, message.input);
    return;
  }
  if (message.type === "event") {
    heard(message);
    return;
  }
  for (const lane of Object.values(lanes)) {
    const pending = lane.waiting.get(message.ask);
    if (!pending) continue;
    lane.waiting.delete(message.ask);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.message));
    pump(lane);
  }
});
