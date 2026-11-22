/**
 * Every read this window holds, read again (docs/view.md): an app
 * controlling Firstmate on another Mac calls it when that Mac could not
 * replay what this one missed - it restarted, or this Mac was away too long -
 * so each panel, record and frame takes the other Mac's state as it is now.
 */

const listeners = new Set<() => void>();

export function onResync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resyncReads(): void {
  for (const listener of [...listeners]) listener();
}
