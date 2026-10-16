import type { AuthNotice, AuthPromptView } from "@shared/providers";

/**
 * The sign-in the person started, owned here rather than in the mounted
 * tab. Leaving Intelligence and coming back used to forget that a Claude
 * sign-in was still running, and a second click started another one.
 */

type Snapshot = {
  providerId: string | null;
  notice: AuthNotice | null;
  prompt: AuthPromptView | null;
};

const flights = new Map<string, Promise<unknown>>();
let notice: AuthNotice | null = null;
let prompt: AuthPromptView | null = null;
const listeners = new Set<() => void>();
let listening = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function ensure(): void {
  if (listening) return;
  if (typeof window === "undefined" || !window.infinitary?.auth) return;
  listening = true;
  window.infinitary.auth.onNotice((incoming) => {
    if (flights.size === 0) return;
    notice = incoming;
    emit();
  });
  window.infinitary.auth.onPrompt((incoming) => {
    if (flights.size === 0) return;
    prompt = incoming;
    emit();
  });
}

/** The sign-in still running, and the notice and prompt it already sent. */
export function signInFlightSnapshot(): Snapshot {
  ensure();
  return {
    providerId: flights.keys().next().value ?? null,
    notice,
    prompt,
  };
}

export function subscribeSignInFlight(listener: () => void): () => void {
  ensure();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Start `work` for `providerId`, or join the one already running. A second
 * click does not open a second sign-in.
 */
export function runAccountAdd<T>(providerId: string, work: () => Promise<T>): Promise<T> {
  ensure();
  const existing = flights.get(providerId);
  if (existing) return existing as Promise<T>;
  // Record the flight before work starts, so a notice it sends on the
  // first tick is kept for a tab that comes back.
  let start!: () => void;
  const promise = new Promise<T>((resolve, reject) => {
    start = () => {
      work().then(resolve, reject);
    };
  });
  flights.set(providerId, promise);
  emit();
  start();
  void promise.finally(() => {
    if (flights.get(providerId) !== promise) return;
    flights.delete(providerId);
    if (flights.size === 0) {
      notice = null;
      prompt = null;
    }
    emit();
  });
  return promise;
}
