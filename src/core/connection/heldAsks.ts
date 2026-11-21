import { WINDOW_ANSWER_WAIT_MS } from "@shared/windowAsks";

/** `liveToView`'s arguments: a window's device, the channel, the payload, then `change` and `one`. */
export type LiveToViewArgs = [
  deviceId: string,
  channel: string,
  payload: unknown,
  change?: string,
  one?: boolean,
];

/**
 * Each ask sent to one window (`liveToView`'s `one`), by its id, held for
 * the connection it went to (docs/view.md, "What the first mate asks of a
 * window"). Only that connection answers it, and an ask stops being held one
 * way: its answer, its wait running out, or its window leaving.
 */
export function heldAsks<Client>() {
  const held = new Map<string, { client: Client; timer: ReturnType<typeof setTimeout> }>();
  const forget = (id: string) => {
    const ask = held.get(id);
    if (!ask) return;
    clearTimeout(ask.timer);
    held.delete(id);
  };
  const hold = (id: string, client: Client) => {
    forget(id);
    const timer = setTimeout(() => forget(id), WINDOW_ANSWER_WAIT_MS);
    timer.unref?.();
    held.set(id, { client, timer });
  };
  /** Whether this answer is the asked window's own; the ask is then held no more. */
  const answered = (id: unknown, client: Client): boolean => {
    if (typeof id !== "string" || held.get(id)?.client !== client) return false;
    forget(id);
    return true;
  };
  return {
    hold,
    answered,
    /**
     * The windows an ask goes to: with `one`, only the newest connection, so
     * its id reaches no other and it runs once, held for that connection.
     */
    sendTo<W extends Client>(eligible: W[], payload: unknown, one?: boolean): W[] {
      if (!one) return eligible;
      const windows = eligible.slice(-1);
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id === "string" && windows[0]) hold(id, windows[0]);
      return windows;
    },
    /**
     * Whether a frame is a window's answer (`inf:view:answer`) to an ask held
     * for another connection or none, which is then dropped: an answer comes
     * from the connection its ask was sent to, never another window.
     */
    stray(channel: string, args: unknown, client: Client): boolean {
      return (
        channel === "inf:view:answer" && !answered((args as unknown[] | undefined)?.[0], client)
      );
    },
    left(client: Client) {
      for (const [id, ask] of held) if (ask.client === client) forget(id);
    },
  };
}
