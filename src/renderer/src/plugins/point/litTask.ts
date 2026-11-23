import { useSyncExternalStore } from "react";

/**
 * Who lit the task: a task the pointer or the keyboard rests on in a
 * panel, a card body or a key the window draws (`peek`, written by
 * `taskPeek`), or the crewmate the stage inspects (`stage`).
 */
export type LitSource = "peek" | "stage";

export type LitTask = { taskId: string; by: LitSource };

/**
 * The lit task (INF-237): the one task the pointer or the keyboard rests
 * on, on any surface that shows tasks, so every other surface that shows
 * it lights it too. One at a time, and the last rest wins; a source lets
 * go only of what it lit, so a rest elsewhere stays. Lit the instant a rest
 * begins and cleared the instant it ends. Host-owned window view state: the
 * core never knows it, nothing saves it. A plain external store, like
 * `taskPeek`, which feeds it for every place but the stage.
 */
let lit: LitTask | null = null;
const listeners = new Set<() => void>();

export const litTask = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get(): LitTask | null {
    return lit;
  },
  set(taskId: string, by: LitSource): void {
    if (lit?.taskId === taskId && lit.by === by) return;
    lit = { taskId, by };
    for (const listener of listeners) listener();
  },
  release(by: LitSource): void {
    if (lit?.by !== by) return;
    lit = null;
    for (const listener of listeners) listener();
  },
};

export function useLitTaskId(): string | null {
  return useSyncExternalStore(
    litTask.subscribe,
    () => lit?.taskId ?? null,
    () => lit?.taskId ?? null,
  );
}
