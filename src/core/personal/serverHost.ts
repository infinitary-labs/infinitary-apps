import { pathToFileURL } from "node:url";
import type {
  BackgroundTask,
  ServerAction,
  ServerContext,
  ServerModule,
} from "@shared/personal/contracts";
import { MIN_BACKGROUND_INTERVAL_MS } from "@shared/personal/manifest";

/**
 * One extension's loaded `server.ts` (talk-to-personalize Step 2; baby-menu's
 * server-action registry and background scheduler, report section 4.1):
 * its actions, callable by name, and its background tasks on host-owned
 * timers. The module runs in the core with the core's privilege (decision
 * Q7) - the same trust the crewmate that wrote it already holds.
 *
 * Loading is a real `import()` of the compiled entry: the content hash in
 * its path makes an edit a fresh module and unchanged code the same
 * instance (module-scope state survives between calls until the code
 * changes). Node never unloads a module, so each edit leaves one stale copy
 * behind; an evening's edits are a handful, and it is gone at relaunch.
 *
 * Background tasks: a cadence under MIN_BACKGROUND_INTERVAL_MS is clamped
 * up to the floor (a task's timer keeps the machine on its cadence whether
 * or not the panel is open, so the floor is the host's, not the author's);
 * a run still in flight when its tick arrives is skipped; a throw is logged
 * and never stops the timer; every timer is unref'd and cleared on dispose.
 */
export type LoadedBackgroundTask = {
  id: string;
  /** After clamping. */
  everyMs: number;
  declaredMs: number;
};

export type ServerHost = {
  readonly actions: readonly string[];
  readonly background: readonly LoadedBackgroundTask[];
  invoke: (action: string, input: unknown) => Promise<unknown>;
  dispose: () => void;
};

export type ServerHostOptions = {
  extensionId: string;
  /** The compiled `server.mjs`, absolute. */
  entryPath: string;
  context: ServerContext;
  /** Injected for tests; the app passes nothing. */
  importModule?: (url: string) => Promise<unknown>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  minIntervalMs?: number;
};

export async function loadServerHost(options: ServerHostOptions): Promise<ServerHost> {
  const importModule = options.importModule ?? ((url: string) => import(url));
  const raw = (await importModule(pathToFileURL(options.entryPath).href)) as ServerModule;
  const actions = normalizeActions(raw.actions);
  const declared = normalizeBackground(raw.background);
  const minIntervalMs = options.minIntervalMs ?? MIN_BACKGROUND_INTERVAL_MS;
  const set = options.setInterval ?? globalThis.setInterval;
  const clear = options.clearInterval ?? globalThis.clearInterval;
  const timers: ReturnType<typeof globalThis.setInterval>[] = [];
  const background: LoadedBackgroundTask[] = [];
  const { context } = options;
  let disposed = false;

  for (const [id, task] of declared) {
    const everyMs = Math.max(task.everyMs, minIntervalMs);
    background.push({ id, everyMs, declaredMs: task.everyMs });
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || disposed) return;
      running = true;
      try {
        await task.run(context);
      } catch (error) {
        context.log(`background task "${id}" failed: ${errorText(error)}`);
      } finally {
        running = false;
      }
    };
    const timer = set(() => void tick(), everyMs);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    timers.push(timer);
    if (task.runOnStart !== false) void tick();
  }

  return {
    actions: [...actions.keys()],
    background,
    invoke: async (action, input) => {
      const handler = actions.get(action);
      if (!handler) {
        throw new Error(
          `"${options.extensionId}" has no action "${action}"` +
            (actions.size > 0 ? ` (it has ${[...actions.keys()].join(", ")})` : ""),
        );
      }
      return await handler(input, context);
    },
    dispose: () => {
      disposed = true;
      for (const timer of timers) clear(timer);
      timers.length = 0;
    },
  };
}

function normalizeActions(value: unknown): Map<string, ServerAction> {
  const out = new Map<string, ServerAction>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, handler] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim().length > 0 && typeof handler === "function") {
      out.set(name, handler as ServerAction);
    }
  }
  return out;
}

function normalizeBackground(value: unknown): Map<string, BackgroundTask> {
  const out = new Map<string, BackgroundTask>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object") continue;
    const task = candidate as Partial<BackgroundTask>;
    if (typeof task.run !== "function") continue;
    if (typeof task.everyMs !== "number" || !Number.isFinite(task.everyMs) || task.everyMs <= 0) {
      continue;
    }
    out.set(id, {
      everyMs: task.everyMs,
      run: task.run,
      ...(typeof task.runOnStart === "boolean" ? { runOnStart: task.runOnStart } : {}),
    });
  }
  return out;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
