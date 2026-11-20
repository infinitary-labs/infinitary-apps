import type { CorePushChannel, PushPayload } from "@shared/ipc";

/**
 * The core's outbound side (daemon study D1). Core services never know who
 * is listening: they hand a typed push payload to a sink and are done. The
 * Electron shell subscribes one sink that fans out to its windows; a second
 * transport would subscribe another, and neither is visible from in here.
 */
export type CoreEventSink = <C extends CorePushChannel>(
  channel: C,
  payload: PushPayload<C>,
) => void;

export class CoreEventBus {
  private readonly sinks = new Set<CoreEventSink>();

  /** Attach a listener; the returned function detaches it. */
  subscribe(sink: CoreEventSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /**
   * Broadcast-shaped by design: today one window listens, tomorrow N
   * clients do, and the core's call site is identical either way.
   */
  readonly emit: CoreEventSink = (channel, payload) => {
    for (const sink of this.sinks) {
      sink(channel, payload);
    }
  };
}
