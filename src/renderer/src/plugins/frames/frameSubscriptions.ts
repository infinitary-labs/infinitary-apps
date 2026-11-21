import {
  FRAME_BRIDGE_VERSION,
  FRAME_MAX_SUBSCRIPTIONS,
  type FrameError,
  type FrameRequest,
  type HostMessage,
} from "@shared/plugins/bridge";
import { transferReadValue } from "@shared/plugins/readTransfer";
import type { ReadGrant } from "@shared/reads";
import { type ReadExecutor, ReadSubscriptionError } from "../reads/executor";

/** What a frame may read: the names it declared and the grant the host adds (`frameReads`). */
export type FrameReadDeclaration = {
  pluginId: string;
  reads: readonly string[];
  grant?: ReadGrant;
};

/** A refused subscribe or unsubscribe, which the asker's response carries. */
export type FrameReadRefusal = { code: FrameError["code"]; message: string };

/**
 * One frame's live read subscriptions (bridge v2's `subscribe` and
 * `unsubscribe`; docs/ui-plugins.md): the one owner every frame host answers
 * them through, the desktop's `FrameController` and the phone's card page
 * alike (docs/ios.md, "Cards on the phone"). A read must be one the frame
 * declared; each runs on the shared `ReadExecutor` under the declaration's
 * grant, and its values reach the frame as `data` messages. A declaration
 * that drops a read, or changes the views a `sql` read runs under, ends
 * that subscription at once and tells the frame why.
 */
export class FrameSubscriptions {
  private readonly live = new Map<number, () => void>();
  /** The read each live subscription names, so a declaration that drops it ends it. */
  private readonly named = new Map<number, string>();
  /** Subscriptions the host ended because their read is no longer declared. */
  private readonly revoked = new Set<number>();

  constructor(
    private readonly executor: ReadExecutor,
    private readonly post: (message: HostMessage) => void,
    /** Whether the current document reuses its last value (`ready`'s `reuseReads`). */
    private readonly reuseReads: () => boolean,
    /** Each value delivered, for a host that counts its own updates. */
    private readonly delivered: () => void = () => {},
  ) {}

  get size(): number {
    return this.live.size;
  }

  /** Starts one subscription, or says why not. */
  subscribe(
    declaration: FrameReadDeclaration,
    request: Extract<FrameRequest, { verb: "subscribe" }>,
  ): FrameReadRefusal | undefined {
    if (!declaration.reads.includes(request.read)) {
      return {
        code: "read_not_declared",
        // i18n-exempt: not shown (a console line, or an error for the panel's code)
        message: `plugin "${declaration.pluginId}" does not declare the read "${request.read}"`,
      };
    }
    if (this.live.has(request.sub)) {
      // i18n-exempt: not shown (a console line, or an error for the panel's code)
      return { code: "bad_request", message: `subscription ${request.sub} already exists` };
    }
    if (this.live.size >= FRAME_MAX_SUBSCRIPTIONS) {
      return {
        code: "too_many_subscriptions",
        // i18n-exempt: not shown (a console line, or an error for the panel's code)
        message: `a frame may hold ${FRAME_MAX_SUBSCRIPTIONS} subscriptions`,
      };
    }
    const sub = request.sub;
    let previous: unknown;
    let stop: () => void;
    try {
      stop = this.executor.subscribe(
        request.read,
        request.args,
        {
          onValue: (value) => {
            if (!this.live.has(sub)) return;
            const transfer = this.reuseReads() ? transferReadValue(previous, value) : { value };
            previous = value;
            this.post({ fm: FRAME_BRIDGE_VERSION, type: "data", sub, ...transfer });
            this.delivered();
          },
          onError: (error) => {
            if (this.live.has(sub))
              this.post({ fm: FRAME_BRIDGE_VERSION, type: "data", sub, error });
          },
        },
        declaration.grant,
      );
    } catch (caught) {
      if (caught instanceof ReadSubscriptionError)
        return { code: caught.code, message: caught.message };
      return {
        code: "read_failed",
        message: caught instanceof Error ? caught.message : String(caught),
      };
    }
    this.live.set(sub, stop);
    this.named.set(sub, request.read);
    return undefined;
  }

  /** Ends one subscription the frame asked to stop, or says why not. */
  unsubscribe(sub: number): FrameReadRefusal | undefined {
    // One the host ended already: the frame's own stop is answered as done.
    if (this.revoked.delete(sub)) return undefined;
    const stop = this.live.get(sub);
    // i18n-exempt: not shown (a console line, or an error for the panel's code)
    if (!stop) return { code: "subscription_unknown", message: `no subscription ${sub}` };
    this.live.delete(sub);
    this.named.delete(sub);
    stop();
    return undefined;
  }

  /**
   * The frame's declaration changed from `before` to `after`: each
   * subscription whose read it no longer names, or a `sql` read whose views
   * changed, ends at once, and the frame's `onError` hears why while it
   * keeps what it drew.
   */
  redeclared(before: FrameReadDeclaration, after: FrameReadDeclaration): void {
    const viewsMoved = viewsOf(after.grant) !== viewsOf(before.grant);
    for (const [sub, read] of this.named) {
      if (after.reads.includes(read) && !(read === "sql" && viewsMoved)) continue;
      this.live.get(sub)?.();
      this.live.delete(sub);
      this.named.delete(sub);
      this.revoked.add(sub);
      this.post({
        fm: FRAME_BRIDGE_VERSION,
        type: "data",
        sub,
        error: {
          code: "read_not_declared",
          // i18n-exempt: not shown (a console line, or an error for the panel's code)
          message: `"${read}" is no longer a read this frame may use`,
        },
      });
    }
  }

  /** Ends every subscription: the frame's document was replaced or stopped. */
  drop(): void {
    for (const stop of this.live.values()) stop();
    this.live.clear();
    this.named.clear();
    this.revoked.clear();
  }
}

/** A grant's views as one comparable key. */
function viewsOf(grant: ReadGrant | undefined): string {
  return (grant?.sql ?? []).join(",");
}
