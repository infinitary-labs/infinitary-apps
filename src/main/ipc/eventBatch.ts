import type { FmEvent } from "@shared/events";

/**
 * A pass's announcements cross Electron once, after its synchronous work.
 * Nothing is dropped or deduplicated: feed lines and status transitions are
 * events, not interchangeable invalidations. The preload fans them out in
 * order in the same renderer task, so reads and React renders can coalesce.
 */
export function eventBatch(send: (events: FmEvent[]) => void): {
  add: (event: FmEvent) => void;
  flush: () => void;
} {
  let pending: FmEvent[] = [];
  let queued = false;
  const flush = () => {
    if (pending.length === 0) return;
    const events = pending;
    pending = [];
    send(events);
  };
  return {
    add(event) {
      pending.push(event);
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        flush();
      });
    },
    flush,
  };
}
