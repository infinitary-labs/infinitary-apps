/** The host's own card for a task the idle ladder could not move (rung 3). */
export function stallCardId(taskId: string): string {
  return `card-stall-${taskId}`;
}

export function stallCardTitle(title: string, stuckFor: string): string {
  return `${title} has been stuck for ${stuckFor}`;
}
