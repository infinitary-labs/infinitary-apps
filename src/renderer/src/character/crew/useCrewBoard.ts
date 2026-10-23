import { type TaskFacts, taskFactsOf } from "@shared/taskFacts";
import type { ProjectView, TaskBoard, TaskDetail, TaskView } from "@shared/tasks";
import { useEffect, useMemo, useState } from "react";
import { useModelNames } from "../../app/useModelNames";
import { appReadExecutor } from "../../plugins/reads/appExecutor";

/**
 * What a crewmate's summary projects (`taskFactsOf`): its board row, and the
 * one model-name lookup the orbit's names and the task record read too.
 */
export type CrewFacts = { task: TaskView; modelName: (model: string) => string };

/**
 * The project name a Tasks row would show for this id: the board's own
 * project list, and an empty string when that list has no such project.
 */
export function useProjectName(projectId: string | undefined): string {
  const [projects, setProjects] = useState<readonly ProjectView[]>([]);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "tasks.board",
        {},
        {
          onValue: (value) => setProjects((value as TaskBoard).projects),
          onError: () => {},
        },
      ),
    [],
  );
  if (!projectId) return "";
  return projects.find((project) => project.id === projectId)?.name ?? "";
}

/** The rows of the same sequenced board the Tasks panel paints. */
export function useBoardTasks(): readonly TaskView[] {
  const [tasks, setTasks] = useState<readonly TaskView[]>([]);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "tasks.board",
        {},
        {
          onValue: (value) => setTasks((value as TaskBoard).tasks),
          onError: () => {},
        },
      ),
    [],
  );
  return tasks;
}

/** Names and facts follow the same sequenced board as Tasks, including reroutes,
 * and the one model-name lookup (`useModelNames`), including by-name models.
 */
export function useCrewBoard(): {
  names: Readonly<Record<string, string>>;
  facts: Readonly<Record<string, CrewFacts>>;
} {
  const tasks = useBoardTasks();
  const modelName = useModelNames();
  return useMemo(
    () => ({ names: crewModelNames(tasks, modelName), facts: crewFacts(tasks, modelName) }),
    [tasks, modelName],
  );
}

/** The crew in orbit: active work. */
function inOrbit(task: Pick<TaskView, "kind" | "status">): boolean {
  return task.kind === "work" && task.status === "active";
}

/** A reroute or late catalog changes only the display projection. Before
 * assignment a crewmate has no entry, so its label stays empty. */
export function crewModelNames(
  tasks: readonly Pick<TaskView, "id" | "kind" | "status" | "model">[],
  modelName: (model: string) => string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    tasks.flatMap((task) =>
      inOrbit(task) && task.model ? [[task.id, modelName(task.model)]] : [],
    ),
  );
}

/**
 * One entry per mark the stage paints: each crewmate in orbit, and each
 * program with every one of its parts, since its root and a part's own node
 * are pointed at and summarised as a crewmate is (./marks.ts, INF-999).
 */
export function crewFacts(
  tasks: readonly TaskView[],
  modelName: (model: string) => string,
): Readonly<Record<string, CrewFacts>> {
  const programs = new Set(tasks.filter((task) => task.program).map((task) => task.id));
  const painted = (task: TaskView) =>
    inOrbit(task) ||
    programs.has(task.id) ||
    (task.parentId !== null && programs.has(task.parentId));
  return Object.fromEntries(
    tasks.flatMap((task) => (painted(task) ? [[task.id, { task, modelName }]] : [])),
  );
}

/**
 * The summary's facts while someone is looking at that crewmate: the board
 * row's at once, then the task record's own read (`tasks.detail`), live -
 * the same projection, from the same read, as the task record card. Now is
 * held open (undefined) until the read answers, and null when the record has
 * no row or cannot be read.
 */
export function useCrewRecord(taskId: string, facts: CrewFacts): TaskFacts {
  const [read, setRead] = useState<{ id: string; detail: TaskDetail | null }>();
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "tasks.detail",
        { id: taskId },
        {
          onValue: (value) => setRead({ id: taskId, detail: value as TaskDetail }),
          onError: () => setRead({ id: taskId, detail: null }),
        },
      ),
    [taskId],
  );
  const answered = read?.id === taskId ? read : undefined;
  return taskFactsOf(
    answered ? (answered.detail ?? { ...facts.task, activityLog: [] }) : facts.task,
    facts.modelName,
  );
}
