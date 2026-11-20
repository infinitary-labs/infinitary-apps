/**
 * One upstream subscription shared by every local subscriber: attached when
 * the first one arrives, detached when the last one leaves, and each value
 * decoded once and handed to all of them.
 *
 * The task board is pushed on every task change - several times per
 * crewmate spawn or dispose - and the page runs on the renderer's main
 * thread, the thread that draws the character. A copy or parse per read
 * subscription was frame time spent once per subscriber; shared, it is
 * spent once per push (character-jank scout, fm3000-character-anim-jank-s1).
 *
 * The shared value is deep-frozen: subscribers receive one object between
 * them, and reads are read-only by contract (a personal panel's
 * `PanelProps.reads`), so a subscriber that writes to it fails in its own
 * code instead of changing what every other surface sees.
 */
export function sharedSubscription<Raw, Value>(
  upstream: (listener: (raw: Raw) => void) => () => void,
  decode: (raw: Raw) => Value,
  report: (error: unknown) => void = rethrowLater,
): (listener: (value: Value) => void) => () => void {
  const listeners = new Set<(value: Value) => void>();
  let detach: (() => void) | undefined;
  return (listener) => {
    const deliver = (value: Value) => listener(value);
    listeners.add(deliver);
    detach ??= upstream((raw) => {
      const value = deepFreeze(decode(raw));
      for (const each of [...listeners]) {
        try {
          each(value);
        } catch (caught) {
          // One failing subscriber must not starve the others.
          report(caught);
        }
      }
    });
    return () => {
      if (!listeners.delete(deliver) || listeners.size > 0) return;
      detach?.();
      detach = undefined;
    };
  };
}

/** Surfaces a subscriber's error without stopping delivery to the rest. */
function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
