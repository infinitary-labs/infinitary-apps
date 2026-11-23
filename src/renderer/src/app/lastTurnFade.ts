import type { LastTurn } from "@shared/lastTurn";

/**
 * The last turn's reading clock (docs/composer.md "The last turn"). One
 * window owns it: it is not saved, and a relaunch starts again. Opening
 * Settings unmounts the pair and only pauses this clock.
 */

/** Visible reading time after a round becomes second-to-last. The captain's choice. */
export const READING_MS = 15_000;

export type FadePhase = "shown" | "fading" | "hidden";

export type FadeSnapshot = {
  key: string | null;
  phase: FadePhase;
  remainingMs: number;
};

type Listener = () => void;

let snapshot: FadeSnapshot = { key: null, phase: "shown", remainingMs: READING_MS };
const listeners = new Set<Listener>();
const announced = new Set<string>();
let running = false;
let tickAt = 0;
let timer: number | undefined;

function emit(next: FadeSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  running = false;
}

/** How long the dissolve takes: `--dur-slow`, which reduced motion cuts to zero. */
export function fadeDurationMs(): number {
  if (typeof document === "undefined") return 700;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--dur-slow").trim();
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) ? ms : 700;
}

function beginFade(): void {
  clearTimer();
  emit({ ...snapshot, phase: "fading", remainingMs: 0 });
  timer = window.setTimeout(() => {
    timer = undefined;
    if (snapshot.phase !== "fading") return;
    emit({ ...snapshot, phase: "hidden" });
  }, fadeDurationMs());
}

function arm(): void {
  clearTimer();
  running = true;
  tickAt = performance.now();
  timer = window.setTimeout(() => {
    if (!running || snapshot.phase !== "shown" || snapshot.key === null) return;
    const elapsed = performance.now() - tickAt;
    const remainingMs = Math.max(0, snapshot.remainingMs - elapsed);
    if (remainingMs <= 0) {
      beginFade();
      return;
    }
    emit({ ...snapshot, remainingMs });
    arm();
  }, snapshot.remainingMs);
}

function pause(): void {
  if (!running) return;
  const remainingMs = Math.max(0, snapshot.remainingMs - (performance.now() - tickAt));
  clearTimer();
  emit({ ...snapshot, remainingMs });
}

/**
 * The older round's arrival, independent of the newest reply or its work:
 * the newest round's key, while a round shows above it. A new round of any
 * kind, a message or a card round, starts the older one's reading time.
 */
export function fadeKey(strip: readonly { key: string }[]): string | null {
  return strip.length > 1 ? (strip.at(-1)?.key ?? null) : null;
}

/** The completed newest reply to announce, kept separate from the older-round clock. */
export function replyAnnouncementKey(turn: LastTurn | null, replySeq: number): string | null {
  const reply = turn?.reply;
  if (!reply || reply.problem || reply.eligibility !== "completed") return null;
  return `${replySeq}\u0000${reply.text}`;
}

/** Whether this reply was already read out, so a remount does not say it again. */
export function replyAnnounced(key: string): boolean {
  return announced.has(key);
}

export function markReplyAnnounced(key: string): void {
  announced.add(key);
}

export function subscribeFade(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFade(): FadeSnapshot {
  return snapshot;
}

/**
 * Keep the clock with the older round on screen. A new key starts 15 seconds.
 * `readable` false pauses the count and never restarts a fade already begun.
 * Unmounting calls this with `readable` false so Settings keeps the remainder.
 */
export function syncFade(key: string | null, readable: boolean): void {
  if (key !== snapshot.key) {
    clearTimer();
    const next: FadeSnapshot = { key, phase: "shown", remainingMs: READING_MS };
    emit(next);
    if (key && readable) arm();
    return;
  }
  if (!key || snapshot.phase !== "shown") return;
  if (readable && !running) arm();
  else if (!readable && running) pause();
}
