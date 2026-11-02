import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionCompletionStore } from "../storage/sessionCompletionStore";
import { sessionCompleteOffset } from "../storage/sessionReader";
import type { ModelSession, SessionEvent } from "./session";

/**
 * Observe the complete durable source on the computer running the session,
 * never the display events or a remote copy. Pi persists after its display
 * notification, so one microtask reads that appended suffix. Claude refreshes
 * its incremental copy before reading. A failed delivery stays in the outbox.
 */
export async function followCompletions(
  session: ModelSession,
  listener: (event: SessionEvent) => void,
  now: () => number,
  local = true,
  journalPath?: string,
): Promise<() => Promise<void>> {
  if (!local) {
    const unsubscribe = session.subscribe(listener);
    return async () => unsubscribe();
  }
  const initial = await session.recordPath({ refresh: true });
  if (!initial) {
    const unsubscribe = session.subscribe(listener);
    return async () => unsubscribe();
  }
  const baseline = sessionCompleteOffset(initial);
  const journal = journalPath ?? join(dirname(initial), "completions.sqlite");
  let store: SessionCompletionStore | undefined;
  let recovering = true;
  let scheduled = false;
  let requested = false;
  let stopped = false;
  let running = Promise.resolve();
  let closing: Promise<void> | undefined;
  const scan = async () => {
    const refreshing = session.recordPath({ refresh: true });
    const path = refreshing instanceof Promise ? await refreshing : refreshing;
    if (!path) return;
    // Pi allocates a record's name before creating its file. Do not create
    // directories or indexes for a session that has not written anything.
    if (!store) {
      if (!existsSync(path) && !existsSync(journal)) return;
      store = new SessionCompletionStore(journal, now);
      store.activate(initial, baseline);
    }
    if (recovering) {
      store.recover(listener, dirname(path));
      recovering = false;
    }
    store.scan(path, listener);
  };
  const safelyScan = async () => {
    try {
      await scan();
    } catch (error) {
      console.error("[session] completion observation waits for recovery", error);
    }
  };
  const drain = async () => {
    while (requested && !stopped) {
      requested = false;
      await safelyScan();
    }
    scheduled = false;
  };
  const schedule = () => {
    if (stopped) return;
    requested = true;
    if (scheduled) return;
    scheduled = true;
    running = Promise.resolve().then(drain);
  };
  const unsubscribe = session.subscribe((event) => {
    listener(event);
    schedule();
  });
  schedule();
  return () => {
    if (closing) return closing;
    unsubscribe();
    stopped = true;
    // Finish the in-flight refresh and one last pass before closing its index.
    // The owner awaits this before deleting a task or closing its database.
    closing = running.then(safelyScan).finally(() => store?.close());
    return closing;
  };
}
