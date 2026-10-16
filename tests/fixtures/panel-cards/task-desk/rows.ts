import type { PanelTaskBoard, PanelTaskRow } from "@firstmate/contracts";

/** The open and underway work on the board, by key: the desk's one list. */
export function liveWork(board: PanelTaskBoard): PanelTaskRow[] {
  return board.tasks
    .filter((task) => task.kind === "work" && (task.status === "open" || task.status === "active"))
    .sort((a, b) => a.key.localeCompare(b.key));
}
