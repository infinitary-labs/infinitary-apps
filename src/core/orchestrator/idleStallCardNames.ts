/** The host's own card for a task the idle ladder could not move (rung 3). */
export function stallCardId(taskId: string): string {
  return `card-stall-${taskId}`;
}

/** That card's title: the task's own, and how long it has been stuck. */
export function stallCardTitle(title: string, stuckFor: string): string {
  return `${title} has been stuck for ${stuckFor}`;
}
