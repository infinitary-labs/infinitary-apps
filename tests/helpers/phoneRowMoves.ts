import { seedTask } from "@core/tasks/seedTask";
import { dropConfirmLead } from "@shared/recordDrop";
import type { TaskService } from "../../src/core/tasks/taskService";
import { CLAUDE_CREW_PROMPT_MARKER } from "../e2e/crewScripts";

/** The board as the phone reads it: each row with the moves its record's rule allows. */
type BoardRead = {
  tasks: { id: string; moves?: Record<string, { ok: boolean; text?: string }> }[];
};

/**
 * INF-2928 piece 3's row for the talk-tasks part: a Backlog task that waits on the talk fixture's task, so the Mac's
 * row Start cannot run and says why, and a long press offers Queue it, that dim Start and Drop task. What the phone
 * must show is read from its owners: the row's moves as the board the phone reads carries them, and the record's
 * Drop task question. Beside it a finished task under Done, which the Mac's board offers no menu for and its Tasks
 * panel row still pins and unpins at rest, so its long press must too.
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
  const done = seedTask(tasks, {
    id: "row-moves-done",
    title: "Log the neap tides",
    status: "completed",
  });
  tasks.close(done.id, { status: "done", reason: "finished", actor: "host" });
  const read = (await board()).tasks.find((task) => task.id === row.id);
  const startReason = read?.moves?.["start-task"]?.text;
  if (!startReason) throw new Error("The row's Start must say why it cannot run");
  return { id: row.id, key: row.key, startReason, drop: dropConfirmLead(row.key), done: done.id };
}

/**
 * INF-64 piece 5's task for the talk parts, `phone-work`, in Backlog: the existing provider holds a real Pi turn on it
 * until the captain steers or interrupts it.
 */
export function seedTalkWork(tasks: TaskService) {
  return seedTask(tasks, {
    id: "phone-work",
    title: "Count the harbour lights",
    status: "queued",
    startPolicy: "on-request",
    prompt: `Count the harbour lights ${CLAUDE_CREW_PROMPT_MARKER}.`,
    intent: {
      goal: "Count the harbour lights",
      userWords: `Count the harbour lights ${CLAUDE_CREW_PROMPT_MARKER}.`,
      constraints: [{ kind: "read-only" }],
    },
  });
}

/**
 * INF-6620 piece 5: the talk task's project gets three tags and the task carries feature, so the phone's Tasks search
 * shows the tag row and its record the Tags row.
 */
export function seedTalkTags(tasks: TaskService, taskId: string) {
  const projectId = tasks.get(taskId)?.projectId ?? "";
  const tags: [name: string, description: string][] = [
    ["bug", "Something that used to work and is broken now."],
    ["feature", "Something new a person can do."],
    ["idea", "A thought to weigh before anyone builds it."],
  ];
  for (const [name, description] of tags)
    tasks.changeProjectTags({ op: "add", projectId, name, description });
  tasks.replaceTags(taskId, { names: ["feature"] }, "captain");
  return { tags: tasks.tagsOf(taskId) };
}
