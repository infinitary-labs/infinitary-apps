import type { TaskView } from "@shared/tasks";
import { crewStatusOf } from "../../character/crew/crewSignal";
import type { StackEntry } from "../stack";

/**
 * Whether the author behind a stage entry is working now, which its thread
 * shows as the working row. A browser view has no author of its own: the
 * request docked beside its page is its task's crewmate's, so that
 * crewmate's work is what it shows (docs/task-browser.md, "The request
 * beside the page").
 */
export function entryWorking(
  entry: Pick<StackEntry, "author" | "taskId" | "browserTaskId" | "answeredBy">,
  firstmateBusy: boolean,
  crewActivity: Readonly<Record<string, TaskView["activity"]>>,
): boolean {
  if (entry.author === "firstmate") return firstmateBusy;
  const crewmate = entry.author === "crewmate" || entry.answeredBy === "crewmate";
  const taskId = crewmate ? entry.taskId : entry.browserTaskId;
  return taskId !== undefined && crewStatusOf(crewActivity[taskId] ?? null) === "working";
}
