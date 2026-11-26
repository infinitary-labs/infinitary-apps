import type { TaskRecord } from "../storage/taskRecords";
import { TaskGraph } from "../tasks/taskGraph";

/** One wait of a side-effect task as its brief names it, from the record alone. */
export type SideEffectWait = Pick<
  TaskRecord,
  "id" | "key" | "title" | "status" | "closedReason" | "delivery"
>;

/** How a wait closed, in the record's own words: a merge is a fact, never read from a report. */
function closedWords(wait: SideEffectWait): string {
  // i18n-exempt: a crewmate's brief, never shown to a person
  if (wait.status === "open" || wait.status === "active") return "still open";
  const reason = wait.closedReason ? ` (${wait.closedReason})` : "";
  // i18n-exempt: a crewmate's brief, never shown to a person
  if (wait.status === "dropped") return `dropped${reason}`;
  // A local land revokes its approval and an outside merge has none, so the
  // closed reason, not a consumed approval, is the record's merged-work fact.
  if (
    TaskGraph.mergedAt(wait) ||
    (wait.status === "done" && (wait.closedReason === "merged" || wait.closedReason === "landed"))
  ) {
    const release = wait.delivery?.firstRelease;
    // i18n-exempt: a crewmate's brief, never shown to a person
    return release
      ? `merged; first shipped in release ${release.version} (${release.url})`
      : "merged; in no release yet";
  }
  // i18n-exempt: a crewmate's brief, never shown to a person
  return `done${reason}, with no merge`;
}

/**
 * The brief section of a side-effect task (docs/task-graph.md, "A
 * side-effect task"): each task it waits on and how it closed, and how its
 * crewmate acts on that. Served only to such a task, so no other crewmate
 * reads the rule. Model-facing words stay English.
 */
export function renderSideEffectSection(waits: readonly SideEffectWait[]): string {
  const lines = waits.map(
    (wait) => `- ${wait.key || wait.id} "${wait.title}": ${closedWords(wait)}`,
  );
  // i18n-exempt: a crewmate's brief, never shown to a person
  return [
    "This is a side-effect task: its only job is the outside action its words name, such as closing a work item, sending a message or posting an update, once the work it waits on is done. Each task it waits on, and how the record says it closed:",
    ...(lines.length ? lines : ["- none"]),
    "Act only when every wait that ships a change merged; a wait done with no change, such as an answer, counts as done. When the words name a release as the moment and a merged wait is in no release yet, report with needs_firstmate naming those tasks, so the first mate holds you until the work ships in a release, and end your turn. Do the action through the integration for the item's tracker, or where the project lives, and say in your report what you did and where. When a wait was dropped, or its change closed with no merge, do nothing outside: report which wait and how it closed.",
  ].join("\n");
}
