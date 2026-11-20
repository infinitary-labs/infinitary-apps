import { useSyncExternalStore } from "react";

// One presentation clock per realm, shared by timed facts rather than a timer per row.
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const read = () => now;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const repaint of listeners) repaint();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

/** Only the timed fact subscribes; unrelated rows retain their render and identity. */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, read, Date.now);
}
