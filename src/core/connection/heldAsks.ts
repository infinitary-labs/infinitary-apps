import { WINDOW_ANSWER_WAIT_MS } from "@shared/windowAsks";

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
  return {
    hold(id: string, client: Client) {
      forget(id);
      const timer = setTimeout(() => forget(id), WINDOW_ANSWER_WAIT_MS);
      timer.unref?.();
      held.set(id, { client, timer });
    },
    /** Whether this answer is the asked window's own; the ask is then held no more. */
    answered(id: unknown, client: Client): boolean {
      if (typeof id !== "string" || held.get(id)?.client !== client) return false;
      forget(id);
      return true;
    },
    left(client: Client) {
      for (const [id, ask] of held) if (ask.client === client) forget(id);
    },
  };
}
