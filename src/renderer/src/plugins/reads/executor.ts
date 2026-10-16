import type { FmEvent } from "@shared/events";
import type { CorePushChannel } from "@shared/ipc";
import type { FrameError } from "@shared/plugins/bridge";
import { type ReadEntry, type ReadGrant, type ReadName, readCatalog } from "@shared/reads";
import type { z } from "zod";

/**
 * Executes read-catalog subscriptions for the plugin host (docs/ui-plugins.md,
 * phase 1). A subscriber names a catalog entry and args; the executor
 * validates the args against the entry's own schema, runs the read, and
 * re-runs it on every invalidation the entry declares - an event the
 * predicate accepts, a core push, a poll tick - handing each value to the
 * subscriber. It is the "host executes and pushes" half of the read
 * catalog; the frame controller turns these values into bridge messages.
 *
 * Re-runs coalesce: a burst of invalidations (a streaming turn's deltas)
 * becomes one read per COALESCE_MS, and an invalidation that lands while a
 * read is in flight is honoured by exactly one follow-up read. A push the
 * entry names as its VALUE (`valueFromPush`) is different: the payload is
 * handed to the subscriber the moment it arrives, with no window and no
 * read, and a read still in flight from before it is dropped as stale.
 * Framework-free and built over an injected api, so it is unit-tested
 * against fakes and served in the app over `window.infinitary`.
 */

export type ReadApi = {
  /** Local presentation overlay; the raw value remains the delta base. */
  present?: (name: ReadName, value: unknown) => unknown;
  onPresentation?: (listener: () => void) => () => void;
  /** `grant` is what the host adds for the plugin (src/shared/reads.ts ReadGrant). */
  read: (name: ReadName, args: unknown, grant: ReadGrant) => Promise<unknown>;
  onEvent: (listener: (event: FmEvent) => void) => () => void;
  onPush: (
    channel: Exclude<CorePushChannel, "inf:event">,
    listener: (payload: unknown) => void,
  ) => () => void;
  /** Every read runs again: the source of truth could not replay a gap (docs/view.md). */
  onResync?: (listener: () => void) => () => void;
};

export type ReadListener = {
  onValue: (value: unknown) => void;
  onError: (error: FrameError) => void;
};

export const COALESCE_MS = 40;

export class ReadSubscriptionError extends Error {
  constructor(
    readonly code: FrameError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ReadSubscriptionError";
  }
}

type AnyEntry = ReadEntry<never, z.ZodType>;

export class ReadExecutor {
  constructor(
    private readonly api: ReadApi,
    private readonly catalog: Record<string, AnyEntry> = readCatalog as unknown as Record<
      string,
      AnyEntry
    >,
  ) {}

  /**
   * Starts one subscription. Throws synchronously when the read is not in
   * the catalog or the args do not parse; every later failure reaches
   * `listener.onError`. The returned function stops it. `grant` is the
   * plugin's, from its manifest, added by the host that binds it - never
   * something the subscriber passes.
   */
  subscribe(
    name: string,
    rawArgs: unknown,
    listener: ReadListener,
    grant: ReadGrant = {},
  ): () => void {
    const entry = Object.hasOwn(this.catalog, name) ? this.catalog[name] : undefined;
    if (!entry) throw new ReadSubscriptionError("read_unknown", `no read named "${name}"`);
    const parsed = entry.args.safeParse(rawArgs);
    if (!parsed.success) {
      throw new ReadSubscriptionError("bad_args", `"${name}" args: ${parsed.error.message}`);
    }
    const args = parsed.data;
    const readName = name as ReadName;

    let disposed = false;
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Counts every value delivered. A read that started before a pushed
    // value landed resolves to an older snapshot than the subscriber
    // already holds, so its result is dropped rather than delivered late.
    let epoch = 0;
    // The value the subscriber holds, for a delta push to fold onto.
    let current: unknown;
    let hasValue = false;
    const deliver = (value: unknown) => {
      epoch += 1;
      current = value;
      hasValue = true;
      listener.onValue(this.api.present?.(readName, value) ?? value);
    };

    const { sameValue } = entry.invalidate;
    const run = () => {
      timer = undefined;
      if (disposed) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      const started = epoch;
      this.api
        .read(readName, args, grant)
        .then((value) => {
          if (disposed || started !== epoch) return;
          // A re-run that found nothing new is not news to the subscriber.
          if (hasValue && sameValue?.(current, value)) return;
          deliver(value);
        })
        .catch((caught: unknown) => {
          if (!disposed) {
            listener.onError({
              code: "read_failed",
              message: caught instanceof Error ? caught.message : String(caught),
            });
          }
        })
        .finally(() => {
          inFlight = false;
          if (dirty && !disposed) {
            dirty = false;
            schedule();
          }
        });
    };
    const schedule = () => {
      if (disposed || timer !== undefined) return;
      timer = setTimeout(run, COALESCE_MS);
    };

    const detach: (() => void)[] = [];
    const { invalidate } = entry;
    if (this.api.onPresentation && invalidate.presentation) {
      detach.push(
        this.api.onPresentation(() => {
          if (disposed) return;
          // Repaint held raw data in the same local hide/restore transition.
          // Neither seq nor the delta base changes, and late reads cannot
          // overwrite a newer local projection. Nothing is read again: a
          // change the core derives from the stack reaches the read through
          // its own declared pushes, and a re-read here would rebuild the
          // whole board once per subscriber on every card change.
          epoch += 1;
          if (hasValue) listener.onValue(this.api.present?.(readName, current) ?? current);
        }),
      );
    }
    if (invalidate.events) {
      const accepts = invalidate.events;
      detach.push(
        this.api.onEvent((event) => {
          if (accepts(event, args)) schedule();
        }),
      );
    }
    for (const channel of invalidate.pushes ?? []) {
      detach.push(this.api.onPush(channel, schedule));
    }
    if (invalidate.valueFromPush) {
      // The push is the value: deliver it as it lands, no window, no read.
      detach.push(
        this.api.onPush(invalidate.valueFromPush, (payload) => {
          if (disposed || (hasValue && sameValue?.(current, payload))) return;
          deliver(payload);
        }),
      );
    }
    if (invalidate.deltaFromPush) {
      // The push is a change to the value: folded onto what the subscriber
      // holds and delivered as one; when it cannot be (no value yet, a gap
      // in the sequence) the read runs again and the next delta lands on
      // that fresh value. An unchanged result is a stale delta: nothing.
      const { apply } = invalidate.deltaFromPush;
      detach.push(
        this.api.onPush(invalidate.deltaFromPush.channel, (payload) => {
          if (disposed) return;
          const next = hasValue ? apply(current, payload) : null;
          if (next === null) {
            schedule();
            return;
          }
          if (next !== current) deliver(next);
        }),
      );
    }
    if (invalidate.pollMs) {
      const poll = setInterval(schedule, invalidate.pollMs);
      detach.push(() => clearInterval(poll));
    }
    if (this.api.onResync) detach.push(this.api.onResync(schedule));

    run();
    return () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const stop of detach) stop();
    };
  }
}
