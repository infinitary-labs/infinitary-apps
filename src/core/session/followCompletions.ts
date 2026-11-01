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
export function followCompletions(
  session: ModelSession,
  listener: (event: SessionEvent) => void,
  now: () => number,
  local = true,
  journalPath?: string,
): () => void {
  if (!local) return session.subscribe(listener);
  const initial = session.recordPath({ refresh: true });
  if (!initial) return session.subscribe(listener);
  const baseline = sessionCompleteOffset(initial);
  const journal = journalPath ?? join(dirname(initial), "completions.sqlite");
  let store: SessionCompletionStore | undefined;
  let recovering = true;
  let scheduled = false;
  let closed = false;
  const scan = () => {
    scheduled = false;
    if (closed) return;
    const path = session.recordPath({ refresh: true });
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
  const safelyScan = () => {
    try {
      scan();
    } catch (error) {
      console.error("[session] completion observation waits for recovery", error);
    }
  };
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(safelyScan);
  };
  const unsubscribe = session.subscribe((event) => {
    listener(event);
    schedule();
  });
  schedule();
  return () => {
    unsubscribe();
    safelyScan();
    closed = true;
    store?.close();
  };
}
