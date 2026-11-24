import { seedTask } from "@core/tasks/seedTask";
import type { TaskService } from "../../src/core/tasks/taskService";
import { CLAUDE_CREW_PROMPT_MARKER } from "../e2e/crewScripts";

/** Real task-service fixtures for issue #46 update regressions.
 * @journey-area src/core/tasks/
 */
/** Each native regression owns its board sizes; this owner writes the real task store. */
export function seedTaskList(tasks: TaskService, body: string) {
  const seed = JSON.parse(body) as {
    prefix: string;
    working?: number;
    backlog?: number;
    done?: number;
    startable?: boolean;
    family?: number;
    familyRunning?: boolean;
  };
  for (let i = 0; i < (seed.working ?? 0); i++)
    seedTask(tasks, {
      id: `task-list-${seed.prefix}-w-${i}`,
      title: `Working task ${i} checks the harbour charts`,
      status: "running",
    });
  for (let i = 0; i < (seed.done ?? 0); i++) {
    const done = seedTask(tasks, {
      id: `task-list-${seed.prefix}-d-${i}`,
      title: `Done task ${i} logged the neap tides`,
      status: "completed",
    });
    tasks.close(done.id, {
      status: "done",
      reason: "finished",
      actor: "host",
    });
  }
  for (let i = 0; i < (seed.backlog ?? 0); i++) {
    const title = `Backlog task ${i} maps the channel markers near the old pier`;
    const prompt = `${title} ${CLAUDE_CREW_PROMPT_MARKER}.`;
    seedTask(tasks, {
      id: `task-list-${seed.prefix}-b-${i}`,
      title,
      status: "queued",
      startPolicy: "on-request",
      ...(seed.startable
        ? {
            prompt,
            intent: {
              goal: title,
              userWords: prompt,
              constraints: [{ kind: "read-only" as const }],
            },
          }
        : {}),
    });
  }
  if (seed.family) {
    const parent = seedTask(tasks, {
      id: `task-list-${seed.prefix}-p`,
      title: `Program ${seed.prefix} charts the whole coast`,
      status: "queued",
      startPolicy: "on-request",
    });
    for (let i = 0; i < seed.family; i++) {
      const title = `Part ${i} surveys one stretch of the coast`;
      const prompt = `${title} ${CLAUDE_CREW_PROMPT_MARKER}.`;
      seedTask(tasks, {
        id: `task-list-${seed.prefix}-c-${i}`,
        title,
        parentId: parent.id,
        status: i === 0 && seed.familyRunning ? "running" : "queued",
        ...(i === 0 && seed.familyRunning ? {} : { startPolicy: "on-request" as const }),
        ...(seed.startable
          ? {
              prompt,
              intent: {
                goal: title,
                userWords: prompt,
                constraints: [{ kind: "read-only" as const }],
              },
            }
          : {}),
      });
    }
  }
  return { ok: true };
}

export function updateTaskList(tasks: TaskService, body: string) {
  const { ids, op } = JSON.parse(body) as {
    ids: string[];
    op: "start" | "done";
  };
  for (const id of ids) {
    if (op === "start") {
      tasks.starts.dispatch(id, {
        workspace: { repoDir: "", worktreeDir: "", branch: "" },
        accountId: null,
        assignee: "crewmate",
      });
      tasks.turns.setActivity(id, "running");
    } else tasks.close(id, { status: "done", reason: "finished", actor: "host" });
  }
  return { ok: true };
}
