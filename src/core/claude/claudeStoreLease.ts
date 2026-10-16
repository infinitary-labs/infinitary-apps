/**
 * One owner for every run of the Claude client that can rewrite an account's
 * credential store.
 *
 * The store behind a Claude account is rewritten by the client itself, and the
 * refresh token behind it is SINGLE USE. Infinitary reaches that one store from
 * three directions - a session's client (session.ts), the sign-in status
 * probe and login (claudeAuth.ts), and the quota sensor's delegated renewal
 * (services.ts) - so without an owner two of them can rotate the same token at
 * once and one holder is left presenting a spent one.
 *
 * Infinitary owns its own sessions, so this is a registry, not a process scan: a
 * session's client takes a SHARED lease for as long as it runs, and the
 * one-shot store tasks take an EXCLUSIVE one. Acquisition mutates the per-account state
 * synchronously and the decision to run is taken inside that same tick, so
 * there is no check-then-spawn window: by the time a caller learns the store
 * is free it already holds it.
 *
 * Priority is deliberate, and it is not symmetric:
 *
 * - A crewmate turn is the real work. It never waits on a background renewal
 *   for long, and a renewal never runs while one is live - the refresh token
 *   is single use, so standing down is the safe move.
 * - A renewal is the RECOVERY path, so it waits out an ordinary one-shot run
 *   (a status probe, a logout) instead of giving up on it. Refusing there was
 *   a real hole: the status probe polls on its own cadence, so the app's own
 *   routine activity could stand its own recovery down tick after tick and a
 *   401 would never get its delegated renewal (reproduced against the real
 *   interfaces in `renewalScheduling.test.ts`).
 * - A status probe is the one that gives way: its answer already falls back to
 *   the account's own store, which needs no client at all.
 */

type LeaseState = {
  /** Live client sessions holding the store open. */
  readers: number;
  /** A one-shot store task is running right now. */
  writer: boolean;
  /** Resolvers waiting for the current writer to finish. */
  waiting: (() => void)[];
};

const leases = new Map<string, LeaseState>();

function stateFor(configDir: string): LeaseState {
  let state = leases.get(configDir);
  if (!state) {
    state = { readers: 0, writer: false, waiting: [] };
    leases.set(configDir, state);
  }
  return state;
}

function releaseWriter(state: LeaseState): void {
  state.writer = false;
  const waiting = state.waiting;
  state.waiting = [];
  for (const resolve of waiting) resolve();
}

/** Why an exclusive store task did not run. */
export type StoreLeaseRefusal = "session_active" | "store_busy";

/**
 * How long a renewal waits for an ordinary one-shot run to finish before
 * giving up. Long enough to outlast a status probe (a spawn of the vendor's
 * client), short enough that a sign-in in progress - which makes a renewal
 * moot anyway - never stalls a refresh tick.
 */
const RENEWAL_WAIT_MS = 30_000;

export type StoreLeaseResult<T> =
  | { ran: true; value: T }
  | { ran: false; refusal: StoreLeaseRefusal };

/**
 * Hold the store open for one live client session. Waits out an in-flight
 * one-shot task (bounded by that task's own timeout) so a session never starts
 * while the store is mid-rewrite, then registers before any client is spawned.
 */
export async function acquireSessionLease(configDir: string): Promise<() => void> {
  const state = stateFor(configDir);
  while (state.writer) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.readers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.readers = Math.max(0, state.readers - 1);
  };
}

/** Whether a live client session currently holds this account's store. */
export function hasActiveSession(configDir: string): boolean {
  return (leases.get(configDir)?.readers ?? 0) > 0;
}

/**
 * Run a one-shot store task only if the store is free RIGHT NOW, and never
 * behind a live session. The check and the claim happen in one tick, so the
 * caller cannot lose a race between deciding and spawning.
 */
export async function tryExclusiveStoreTask<T>(
  configDir: string,
  task: () => Promise<T>,
): Promise<StoreLeaseResult<T>> {
  const state = stateFor(configDir);
  if (state.readers > 0) return { ran: false, refusal: "session_active" };
  if (state.writer) return { ran: false, refusal: "store_busy" };
  state.writer = true;
  try {
    return { ran: true, value: await task() };
  } finally {
    releaseWriter(state);
  }
}

/**
 * Run the RECOVERY task: wait out an ordinary one-shot run, but never a live
 * session.
 *
 * This is the asymmetry that keeps the app from starving its own recovery. A
 * renewal that simply refused whenever the store was busy could be stood down
 * indefinitely by the status probe's own polling; a renewal that waited for a
 * live SESSION would race that session over a single-use refresh token. So it
 * waits for the one and stands down for the other, and the session check
 * happens in the same tick as the claim, after the wait.
 */
export async function runRenewalStoreTask<T>(
  configDir: string,
  task: () => Promise<T>,
  waitMs: number = RENEWAL_WAIT_MS,
): Promise<StoreLeaseResult<T>> {
  const state = stateFor(configDir);
  const deadline = Date.now() + waitMs;
  while (state.writer) {
    if (Date.now() >= deadline) return { ran: false, refusal: "store_busy" };
    const released = await waitForWriter(state, deadline - Date.now());
    if (!released && state.writer) return { ran: false, refusal: "store_busy" };
  }
  // Whoever held it is gone. A session may have started while we waited, and
  // that one we do not race: the refresh token behind it is single use.
  if (state.readers > 0) return { ran: false, refusal: "session_active" };
  state.writer = true;
  try {
    return { ran: true, value: await task() };
  } finally {
    releaseWriter(state);
  }
}

/** Resolves true when the writer released, false when the wait ran out. */
function waitForWriter(state: LeaseState, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        resolve(false);
      },
      Math.max(0, timeoutMs),
    );
    state.waiting.push(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Run a one-shot store task, waiting for another one to finish. Used by the
 * user-initiated paths (login, logout), which must happen rather than defer.
 * It still never overlaps another store task.
 */
export async function runExclusiveStoreTask<T>(
  configDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = stateFor(configDir);
  while (state.writer) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.writer = true;
  try {
    return await task();
  } finally {
    releaseWriter(state);
  }
}

/** Test seam: forget every lease. Never called in production. */
export function resetStoreLeasesForTest(): void {
  leases.clear();
}
