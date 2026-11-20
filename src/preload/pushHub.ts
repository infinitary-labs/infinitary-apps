/**
 * One IPC listener per push channel, however many subscribers the window
 * has. Each push is validated once and handed to every subscriber, instead
 * of every subscription registering its own `ipcRenderer` handler and
 * re-validating the same payload. The preload runs on the renderer's main
 * thread - the thread that draws the character - so per-subscriber work on
 * a push is time taken from its frames (character-jank scout,
 * fm3000-character-anim-jank-s1).
 *
 * Kept free of Electron so it can be exercised directly: the preload hands
 * it `ipcRenderer`'s on/off and the push contract's validation.
 */

export type PushSource = {
  on(channel: string, handler: (event: unknown, raw: unknown) => void): void;
  off(channel: string, handler: (event: unknown, raw: unknown) => void): void;
};

/** A payload the contract accepted, or nothing when it refused it. */
export type Validated = { ok: true; value: unknown } | { ok: false };

export type PushHub = {
  subscribe(channel: string, listener: (value: unknown) => void): () => void;
};

/** Surfaces a subscriber's error without stopping delivery to the rest. */
function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

export function createPushHub(
  source: PushSource,
  validate: (channel: string, raw: unknown) => Validated,
  report: (error: unknown) => void = rethrowLater,
): PushHub {
  const channels = new Map<
    string,
    {
      listeners: Set<(value: unknown) => void>;
      handler: (event: unknown, raw: unknown) => void;
    }
  >();
  return {
    subscribe(channel, listener) {
      let entry = channels.get(channel);
      if (!entry) {
        const listeners = new Set<(value: unknown) => void>();
        const handler = (_event: unknown, raw: unknown) => {
          const validated = validate(channel, raw);
          if (!validated.ok) return;
          // A snapshot, so a subscriber that unsubscribes (or subscribes)
          // while being called changes the next push, not this one.
          for (const deliver of [...listeners]) {
            try {
              deliver(validated.value);
            } catch (caught) {
              // One failing subscriber must not starve the others.
              report(caught);
            }
          }
        };
        entry = { listeners, handler };
        channels.set(channel, entry);
        source.on(channel, handler);
      }
      // A wrapper per subscription, so subscribing the same function twice
      // yields two independent subscriptions, as separate handlers did.
      const deliver = (value: unknown) => listener(value);
      entry.listeners.add(deliver);
      const subscribed = entry;
      return () => {
        if (!subscribed.listeners.delete(deliver)) return;
        if (subscribed.listeners.size === 0 && channels.get(channel) === subscribed) {
          channels.delete(channel);
          source.off(channel, subscribed.handler);
        }
      };
    },
  };
}
