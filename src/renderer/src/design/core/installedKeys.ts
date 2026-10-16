import type { Bindings } from "@shared/keyboard";
import { DEFAULT_KEYMAP_SNAPSHOT, type KeymapSnapshot } from "@shared/keymap";
import { useSyncExternalStore } from "react";

/**
 * The keys the window has installed, as the main process last said them
 * (docs/keyboard.md, "The installed map"): what a message field's keys,
 * every key hint, command search and Keyboard settings read, so none of
 * them shows or takes a key the window does not. Until the first reading
 * arrives they are the catalog's own.
 */

let installed: KeymapSnapshot = DEFAULT_KEYMAP_SNAPSHOT;
const listeners = new Set<() => void>();

export function installedKeymap(): KeymapSnapshot {
  return installed;
}

export function installedBindings(): Bindings {
  return installed.bindings;
}

/** Takes a newer install; an older one arriving late changes nothing. */
export function setInstalledKeymap(snapshot: KeymapSnapshot): void {
  if (snapshot.version < installed.version) return;
  installed = snapshot;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The installed keys, drawn again at every install. */
export function useInstalledKeymap(): KeymapSnapshot {
  return useSyncExternalStore(subscribe, installedKeymap, installedKeymap);
}
