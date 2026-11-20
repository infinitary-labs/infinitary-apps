// The one place the character rig asks whether motion should be reduced.
// The loop (./motion.ts) and any static-frame painter read the OS
// preference through here, so a review page can simulate the preference
// for a reviewer who has not set it system-wide - the product never calls
// `simulateReducedMotion`.

type Listener = () => void;

const listeners = new Set<Listener>();
let simulated: boolean | null = null;

function osQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

let osBound = false;
function bindOs(): void {
  if (osBound) return;
  osBound = true;
  osQuery()?.addEventListener("change", () => {
    if (simulated === null) for (const l of listeners) l();
  });
}

/** Whether motion should be reduced right now (simulation wins over the OS). */
export function prefersReducedMotion(): boolean {
  if (simulated !== null) return simulated;
  return osQuery()?.matches ?? false;
}

/** Called on every change of the effective preference. Returns the unsubscribe. */
export function onReducedMotionChange(listener: Listener): () => void {
  bindOs();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Review and test aid: force the preference on or off, or null to follow
 * the OS again. Notifies listeners exactly like a real change.
 */
export function simulateReducedMotion(value: boolean | null): void {
  if (simulated === value) return;
  simulated = value;
  for (const l of listeners) l();
}
