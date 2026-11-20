/**
 * The signal a fault in this process's own running code raises: Chromium's
 * fatal checks stop on a trap instruction, which the system delivers as
 * SIGTRAP to that very instruction. A handler that returns runs the same
 * instruction again. Node installs a handler for every signal JavaScript
 * listens for, and that handler only queues the listener for the event loop,
 * which never runs again: one listener turns the crash Chromium meant into a
 * frozen app at full processor use (INF-5226). signal-exit, which
 * proper-lockfile loads for Pi's sign-in store, listens for it.
 */
const FAULT_SIGNAL = "SIGTRAP";

/**
 * Keeps a fault fatal for the rest of the process: takes away every
 * listener for its signal now, and each one added later, before the turn
 * that added it ends. A process whose fault signal has no listener gets the
 * system's own handling back, and ends.
 */
export function keepFaultSignalsFatal(): void {
  process.removeAllListeners(FAULT_SIGNAL);
  process.on("newListener", (event: string | symbol, listener: (...args: unknown[]) => void) => {
    // Added only once this event's own listeners have run: take it away then.
    if (event === FAULT_SIGNAL)
      queueMicrotask(() => process.removeListener(FAULT_SIGNAL, listener));
  });
}
