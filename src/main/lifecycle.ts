export type BeforeQuitEvent = {
  preventDefault: () => void;
};

export type AppLifecycle = {
  on: (event: "before-quit", listener: (event: BeforeQuitEvent) => void) => unknown;
  quit: () => void;
};

export type DeferredQuitOptions = {
  schedule?: (run: () => void) => void;
  log?: (message: string, error: unknown) => void;
};

/**
 * Electron can emit before-quit from a native callback while a synchronous
 * SQLite query is still on the stack. Core disposal clears the launch marker,
 * so running it inside that callback would re-enter better-sqlite3. Hold the
 * quit and dispose on the next main-loop turn, after the emitting query has
 * returned, then let the second quit proceed once disposal has settled (the
 * core bounds that wait).
 */
export function deferCoreDisposal(
  app: AppLifecycle,
  dispose: () => void | Promise<void>,
  options: DeferredQuitOptions = {},
): void {
  const schedule = options.schedule ?? setImmediate;
  let disposalScheduled = false;
  let disposed = false;

  app.on("before-quit", (event) => {
    if (disposed) return;
    event.preventDefault();
    if (disposalScheduled) return;
    disposalScheduled = true;
    schedule(() => {
      // A throw inside dispose rejects this promise; the core's own bound
      // keeps the wait for its crewmates to settle short.
      void new Promise<void>((resolve) => resolve(dispose()))
        .catch((error: unknown) =>
          (options.log ?? defaultDisposeLog)("core disposal failed", error),
        )
        .finally(() => {
          disposed = true;
          app.quit();
        });
    });
  });
}

function defaultDisposeLog(message: string, error: unknown): void {
  console.error(`[infinitary] ${message}:`, error);
}
