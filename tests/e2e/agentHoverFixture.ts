import { seedTask } from "../../src/core/tasks/seedTask";
import type { PlanItem } from "../../src/shared/taskPlan";
import { clusterFixture } from "./clusterFixture";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";

export const HOVER_COUNTS = [10, 8, 8];
export const HOVER_NOTE = "The result selection stays in the task record during a refresh.";
export const HOVER_PLAN: PlanItem[] = [
  { label: "Reproduce the refresh interruption", short: "Reproduce", state: "done" },
  { label: "Preserve the selected result", short: "Fix", state: "current" },
  { label: "Check both input routes", short: "Verify", state: "next" },
];

const DEPENDENCIES = [
  "Collect the search-field logs",
  "Reproduce the refresh interruption",
  "Record the focused result",
  "Check the keyboard route",
  "Check the pointer route",
  "Inspect the persisted selection",
  "Check the task-board update",
  "Check the result ordering",
  "Check the empty-result state",
  "Check the loading state",
  "Check the filtered result",
  "Check the completed refresh",
];

/** Real paired work-computer identities and real task placement, owned by
 * clusterFixture. Taller summaries use ordinary dependency facts, not a
 * changed card size or an intercepted bridge response.
 * @journey-area src/renderer/src/character/crew/
 * @journey-area src/renderer/src/app/HomeMate.tsx
 */
export function agentHoverFixture(
  title: string,
  options: { tall?: boolean; createSlot?: boolean } = {},
) {
  const userDataDir = clusterFixture(
    HOVER_COUNTS,
    undefined,
    (tasks) => {
      if (options.createSlot) {
        for (const [index, finished] of DEPENDENCIES.slice(0, 3).entries()) {
          const id = `finished-${index}`;
          seedTask(tasks, { id, title: finished, status: "completed" });
          tasks.close(id, { status: "done", reason: "merged", actor: "captain" });
        }
      }
      if (options.tall) {
        const crew = tasks.list().filter((task) => task.status === "active");
        for (const task of crew) tasks.noteProgress(task.id, HOVER_NOTE, "crewmate", HOVER_PLAN);
        for (const [index, dependency] of DEPENDENCIES.entries()) {
          const id = `dependency-${index}`;
          seedTask(tasks, { id, title: dependency, status: "queued", startPolicy: "on-request" });
          for (const task of crew) tasks.graph.link(id, task.id, "blocks", "host");
        }
      }
    },
    () => ({
      title,
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
      outcome: HOVER_NOTE,
    }),
  );
  return { userDataDir };
}
