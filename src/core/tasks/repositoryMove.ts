import { said, saidLine } from "@shared/i18n/said";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { moveTargetRepository, type ProjectMoveContext, refuseRemoteless } from "./projectMove";
import { TaskGraphRefusal } from "./taskGraph";
import { keyOrId, withShapeKey } from "./taskWriter";

/** A repository of the task's own project, by its id and name. */
export type ProjectRepositoryRef = { id: string; name: string };

/**
 * The repository of the task's own project that `named` names, by name or
 * id (`moveTargetRepository`); refused, naming the project's repositories,
 * when it names none of them.
 */
export function repositoryInProject(
  { writer }: Pick<ProjectMoveContext, "writer">,
  record: TaskRecord,
  named: string,
): ProjectRepositoryRef {
  const project = writer.projects.get(record.projectId);
  if (!project) throw new Error(`Unknown project "${record.projectId}".`);
  const id = moveTargetRepository(project, writer.projects, record, named);
  const found = writer.projects.repositoriesOf(project.id).find((repo) => repo.id === id);
  // i18n-exempt: a tool answer served to the first mate, not shown to a person
  if (!id || !found) throw new TaskGraphRefusal(`Refused: ${project.name} holds no repository.`);
  return { id: found.id, name: found.name };
}

/** The name of a repository of a project's, when that project holds it. */
export function repositoryName(
  { writer }: Pick<ProjectMoveContext, "writer">,
  projectId: string,
  repoId: string | null,
): string | undefined {
  if (!repoId) return undefined;
  return writer.projects.repositoriesOf(projectId).find((repo) => repo.id === repoId)?.name;
}

/**
 * Open work that has not started moves to another repository of its own
 * project (inside the caller's transaction): it keeps its key, since its
 * project is the same, and its parts that had its repository follow it, as
 * a move to another project takes them. Started work moves through
 * `restartInRepository` instead, once its crewmate has stopped and its
 * empty working copy is gone. Answers whether anything moved.
 */
export function moveWithinProject(
  context: ProjectMoveContext,
  record: TaskRecord,
  target: ProjectRepositoryRef,
  actor: TaskEventActor,
  at: number,
): boolean {
  const { writer, graph, repos } = context;
  if (record.repoId === target.id) return false;
  // i18n-exempt: a tool answer served to the first mate, not shown to a person
  if (record.status !== "open" || record.worktreeDir || record.placement)
    throw new TaskGraphRefusal(
      `Refused: ${keyOrId(record)} has started, so it moves to the ${target.name} repository only while it has no commits of its own: its crewmate stops and it starts again there.`,
    );
  const descendants = graph.descendants(record.id);
  // i18n-exempt: a tool answer served to the first mate, not shown to a person
  for (const descendant of descendants)
    if (descendant.status !== "open" || descendant.worktreeDir || descendant.placement)
      throw new TaskGraphRefusal(
        `Refused: its part ${keyOrId(descendant)} has started, so ${keyOrId(record)} and its parts cannot move to the ${target.name} repository.`,
      );
  const after = new Map<string, string | null>([[record.id, target.id]]);
  const before = new Map([record, ...descendants].map((row) => [row.id, row.repoId]));
  const moves = [record, ...descendants].map((row) => {
    if (row.id === record.id) return { row, repoId: target.id as string | null };
    // A part that had its parent's repository, or none, follows it there.
    const follows =
      row.parentId && (row.repoId === null || row.repoId === before.get(row.parentId));
    const to = follows && row.parentId ? (after.get(row.parentId) ?? row.repoId) : row.repoId;
    after.set(row.id, to);
    return { row, repoId: to };
  });
  const projectName = writer.projects.get(record.projectId)?.name ?? target.name;
  refuseRepositoryMove({ writer, repos }, moves, projectName);
  for (const { row, repoId: to } of moves) {
    if (to === row.repoId) continue;
    writer.patch(row.id, { repoId: to, updatedAt: at });
    const line = saidLine(
      said("feedRepositoryMoved", {
        repository: repositoryName(context, row.projectId, to) ?? target.name,
      }),
    );
    writer.addEvent({
      taskId: row.id,
      at,
      actor,
      kind: "note",
      text: line.text,
      data: { said: line.said, fromRepoId: row.repoId, toRepoId: to },
      feed: false,
    });
  }
  return true;
}

/**
 * Refuses a move of `moves` within one project before anything is written:
 * a row that asks to ship as a pull request into a repository with no
 * remote (`refuseRemoteless`), and a row that would land apart from the
 * work it branches from, or from open work that branches from it, since a
 * task branches only from work in its own repository and that start would
 * be refused (`branchFromSource`).
 */
export function refuseRepositoryMove(
  context: Pick<ProjectMoveContext, "writer" | "repos">,
  moves: readonly { row: TaskRecord; repoId: string | null }[],
  projectName: string,
): void {
  const { writer, repos } = context;
  refuseRemoteless(repos, moves, projectName);
  const after = new Map(moves.map((move) => [move.row.id, move.repoId]));
  const landing = (row: TaskRecord) => (after.has(row.id) ? after.get(row.id) : row.repoId);
  const nameOf = (row: TaskRecord) =>
    repositoryName(context, row.projectId, landing(row) ?? null) ?? projectName;
  for (const { row, repoId: to } of moves) {
    if (to === row.repoId) continue;
    const handle = keyOrId(row);
    for (const reference of writer.references.list(row.id)) {
      if (reference.kind !== "branch-source") continue;
      const source = writer.resolve(reference.ref);
      if (!source || landing(source) === to) continue;
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      throw new TaskGraphRefusal(
        `Refused: ${handle} branches from ${keyOrId(source)}, which stays in the ${nameOf(source)} repository, so ${handle} cannot move to the ${nameOf(row)} repository; clear its branch_from first.`,
      );
    }
    for (const id of writer.references.taskIdsNaming("branch-source", row.id, row.key)) {
      const follower = writer.store.get(id);
      if (follower?.status !== "open" || landing(follower) === to) continue;
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      throw new TaskGraphRefusal(
        `Refused: ${keyOrId(follower)} branches from ${handle} and stays in the ${nameOf(follower)} repository, so ${handle} cannot move to the ${nameOf(row)} repository; clear or move ${keyOrId(follower)}'s branch_from first.`,
      );
    }
  }
}

/**
 * Started work with no commits of its own goes to another repository of its
 * project and starts again there (inside the caller's transaction, once its
 * crewmate stopped and its empty working copy was removed): it is open
 * and unstarted again, queued if it was running and in the backlog if it
 * waited there (started work there is active with `backlogSince`), with no
 * working copy, conversation or
 * computer, so its next start makes a working copy in `target` and opens a
 * new conversation from the same brief. Its key, record, the captain's
 * words and consents, its waits and its parts stay as they are.
 */
export function restartInRepository(
  context: Pick<ProjectMoveContext, "writer">,
  record: TaskRecord,
  target: ProjectRepositoryRef,
  actor: TaskEventActor,
  at: number,
): void {
  const { writer } = context;
  writer.patch(record.id, {
    status: "open",
    activity: null,
    assignee: null,
    model: null,
    startedAt: null,
    sessionFile: null,
    repoId: target.id,
    repoDir: "",
    worktreeDir: "",
    branch: "",
    workspaceState: "none",
    deviceId: null,
    placement: null,
    gate: null,
    // Running work goes back in line; work the backlog holds stays there.
    ...(record.status === "active"
      ? {
          startPolicy:
            record.backlogSince != null ? ("on-request" as const) : ("when-ready" as const),
        }
      : {}),
    backlogSince: null,
    // What this Mac brought home was the copy that is gone.
    shape: withShapeKey(record.shape, "home_copy", undefined),
    updatedAt: at,
  });
  const line = saidLine(said("feedRepositoryRestarted", { repository: target.name }));
  writer.addEvent({
    taskId: record.id,
    at,
    actor,
    kind: "note",
    text: line.text,
    data: {
      said: line.said,
      feedLine: true,
      news: true,
      fromRepoId: record.repoId,
      toRepoId: target.id,
      restarted: true,
    },
    feed: true,
  });
}
