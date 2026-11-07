import { seedTask } from "@core/tasks/seedTask";
import { dropConfirmLead } from "@shared/recordDrop";
import type { TaskService } from "../../src/core/tasks/taskService";

/** The board as the phone reads it: each row with the moves its record's rule allows. */
type BoardRead = {
  tasks: { id: string; moves?: Record<string, { ok: boolean; text?: string }> }[];
};

/**
 * INF-2928 piece 3's row for the talk-tasks part: a Backlog task that waits on the talk fixture's task, so the Mac's
 * row Start cannot run and says why, and a long press offers Queue it, a dim Start now and Drop task. What the phone
 * must show is read from its owners: the row's moves as the board the phone reads carries them, and the record's
 * Drop task question.
 */
export async function seedRowMoves(
  tasks: TaskService,
  waitsOn: string,
  board: () => Promise<BoardRead>,
) {
  const row = seedTask(tasks, {
    id: "row-moves",
    title: "Mark the channel buoys",
    status: "queued",
    startPolicy: "on-request",
    blockedBy: [waitsOn],
  });
  const read = (await board()).tasks.find((task) => task.id === row.id);
  const startReason = read?.moves?.["start-task"]?.text;
  if (!startReason) throw new Error("The row's Start must say why it cannot run");
  return { id: row.id, key: row.key, startReason, drop: dropConfirmLead(row.key) };
}
