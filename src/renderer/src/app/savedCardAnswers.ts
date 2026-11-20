import { type FrameAnswers, frameAnswersSchema } from "@shared/plugins/bridge";

/**
 * Each open card's unsent picks, saved in this window's own storage on this
 * computer, so a restart or a reopened window gives them back until the card
 * closes (INF-2710; the captain chose "Keep picks across restarts",
 * reversing Q4 A). The shell's `cardAnswers` stays the one live reading:
 * this file only mirrors it, so the stack's own retirement of a card that
 * left takes its saved picks with it. Storage that is missing, full or
 * unreadable costs the saved copy alone, never a pick.
 */

const PREFIX = "infinitary.cardAnswers.";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** The window's own storage, or none where there is no window (a node test). */
function windowStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The picks saved before this window started, by card id. */
export function savedCardAnswers(
  storage: Store | null = windowStorage(),
): Record<string, FrameAnswers> {
  const saved: Record<string, FrameAnswers> = {};
  if (!storage) return saved;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const parsed = frameAnswersSchema.safeParse(JSON.parse(storage.getItem(key) ?? "null"));
      if (parsed.success) saved[key.slice(PREFIX.length)] = parsed.data;
    }
  } catch {
    // An unreadable entry, or storage refused: the cards return as written.
  }
  return saved;
}

/** A reading worth keeping holds a pick, written words, or a cleared proposal. */
const keeps = (reading: FrameAnswers) => reading.picked > 0 || reading.changed > 0;

/**
 * Brings the saved copy in line with the shell's readings: a new or changed
 * reading is written, an empty one or a card the stack retired is removed.
 */
export function mirrorCardAnswers(
  next: Record<string, FrameAnswers>,
  previous: Record<string, FrameAnswers>,
  storage: Store | null = windowStorage(),
): void {
  if (next === previous || !storage) return;
  for (const [cardId, reading] of Object.entries(next)) {
    if (previous[cardId] === reading) continue;
    const { answered, of, changed, picked, answers } = reading;
    try {
      if (keeps(reading))
        storage.setItem(
          PREFIX + cardId,
          JSON.stringify({ answered, of, changed, picked, answers }),
        );
      else storage.removeItem(PREFIX + cardId);
    } catch {
      // Full storage keeps the pick in this run only, as before.
    }
  }
  for (const cardId of Object.keys(previous)) {
    if (cardId in next) continue;
    try {
      storage.removeItem(PREFIX + cardId);
    } catch {
      // Nothing to undo: the card is gone from the stack either way.
    }
  }
}
