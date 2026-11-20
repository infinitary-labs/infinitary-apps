import type { PanelSource } from "./contributions";

/**
 * The simplest PanelSource: a mutable cell. Built-in panels and tests set
 * it; the host reads it through `useSyncExternalStore`, which re-renders
 * only when `get()` returns a different value, so callers should hand it
 * primitives or already-stable objects.
 */
export function createPanelSource<T>(initial: T | null = null): {
  source: PanelSource<T>;
  set: (value: T | null) => void;
} {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      subscribe: (onChange) => {
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
        };
      },
      get: () => current,
    },
    set: (value) => {
      if (Object.is(value, current)) return;
      current = value;
      for (const listener of listeners) listener();
    },
  };
}
