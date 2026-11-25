import { deliveryForRecord, opensPullRequest } from "@shared/repos";
import type { ProjectRecord, ProjectStore } from "../storage/projectStore";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { type TaskGraph, TaskGraphRefusal } from "./taskGraph";
import type { TaskServiceOptions } from "./taskService";
import { carryProjectTags } from "./taskTags";
import { keyOrId, type TaskWriter } from "./taskWriter";

/**
 * The repository a task moved into another project works in (INF-4220): the
 * one the move names, else its own when the project holds it, else the
 * project's only one. A project with none (Scratch) gives none, and the task
 * keeps its own. A project of several that the move cannot place the task
 * in is refused, naming its repositories, so nothing is guessed.
 */
export function moveTargetRepository(
  project: Pick<ProjectRecord, "id" | "name">,
  projects: Pick<ProjectStore, "repositoriesOf">,
  task: { id: string; key: string; repoId: string | null },
  named?: string,
): string | null {
  const repositories = projects.repositoriesOf(project.id);
  const names = repositories.map((repository) => repository.name).join(", ");
  if (named !== undefined) {
    const wanted = named.trim().toLowerCase();
    const found = repositories.find(
      (repository) => repository.id === named.trim() || repository.name.toLowerCase() === wanted,
    );
    if (found) return found.id;
    throw new TaskGraphRefusal(
      repositories.length
        ? `Refused: ${project.name} holds no repository "${named}"; its repositories are ${names}.`
        : `Refused: ${project.name} holds no repository, so ${keyOrId(task)} keeps its own.`,
    );
  }
  if (repositories.length === 0) return null;
  if (task.repoId && repositories.some((repository) => repository.id === task.repoId))
    return task.repoId;
  if (repositories.length === 1) return repositories[0]?.id ?? null;
  throw new TaskGraphRefusal(
    `Refused: ${project.name} holds several repositories (${names}), so ${keyOrId(task)} cannot move there without one: name its repository.`,
  );
}

export type ProjectMoveContext = {
  writer: TaskWriter;
  graph: Pick<TaskGraph, "descendants">;
  repos: TaskServiceOptions["repos"];
};

/**
 * Re-key a task into another project (inside the caller's transaction).
 * Only an open row with no workspace may move: a worktree is bound to a
 * repo, and a crewmate's brief already names the project it works in.
 * The subtree follows, so children never end up in a foreign project.
 * The moved task takes `repoId`, so its working copy, pull request and
 * checks are where it lands (INF-8): the new parent's on a re-parent, as
 * `create` gives a child, else `moveTargetRepository`'s; where that is none
 * (Scratch, or a parent with none) it keeps its own. Each part takes what
 * its parent takes, as `create` gives a child, unless it is bound to a
 * repository of its own, which it keeps. A removed project takes no task,
 * and a repository with no remote takes no row the captain asked to ship
 * as a pull request.
 */
export function moveIntoProject(
  { writer, graph, repos }: ProjectMoveContext,
  record: TaskRecord,
  projectId: string,
  actor: TaskEventActor,
  at: number,
  repoId?: string | null,
  repository?: string,
): void {
  const project = writer.projects.get(projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  if (project.archivedAt !== null) {
    throw new TaskGraphRefusal(
      `Refused: ${project.name} was removed, so ${keyOrId(record)} cannot move there.`,
    );
  }
  if (record.status !== "open" || record.worktreeDir || record.placement) {
    throw new TaskGraphRefusal(
      `Refused: ${keyOrId(record)} is ${record.placement ? "committed to a computer" : record.status === "open" ? "bound to a workspace" : record.status} and cannot move to another project; only open work that has not started can.`,
    );
  }
  const descendants = graph.descendants(record.id);
  for (const descendant of descendants) {
    if (descendant.status !== "open" || descendant.worktreeDir || descendant.placement) {
      throw new TaskGraphRefusal(
        `Refused: its child ${keyOrId(descendant)} is ${descendant.placement ? "committed to a computer" : descendant.status === "open" ? "bound to a workspace" : descendant.status}, so the subtree cannot move to another project.`,
      );
    }
  }
  const target =
    repoId === undefined
      ? moveTargetRepository(project, writer.projects, record, repository)
      : repoId;
  const rows = [record, ...descendants];
  const before = new Map(rows.map((row) => [row.id, row.repoId]));
  const after = new Map<string, string | null>();
  const moves = rows.map((row) => {
    let to = row.repoId;
    if (row.id === record.id) to = target ?? row.repoId;
    // A part that had its parent's repository, or none, followed it there.
    else if (row.parentId && (row.repoId === null || row.repoId === before.get(row.parentId)))
      to = after.get(row.parentId) ?? null;
    after.set(row.id, to);
    return { row, repoId: to };
  });
  refuseRemoteless(repos, moves, project.name);
  for (const { row, repoId: to } of moves) {
    const { seq, key } = writer.projects.allocateSeq(project.id);
    writer.patch(row.id, { projectId: project.id, key, seq, repoId: to, updatedAt: at });
    // A tag belongs to its project, so a task leaves its tags behind (docs/task-tags.md).
    writer.store.tags.deleteFor(row.id);
    writer.addEvent({
      taskId: row.id,
      at,
      actor,
      kind: "moved",
      text: `moved to ${project.name} as ${key} (was ${keyOrId(row)})`,
      data: {
        fromProjectId: row.projectId,
        toProjectId: project.id,
        fromKey: row.key,
        toKey: key,
        ...(to !== row.repoId ? { fromRepoId: row.repoId, toRepoId: to } : {}),
      },
      feed: false,
    });
  }
}

/**
 * As a plan is refused a direct-pr ask with no remote to open it on
 * (CrewSupervisor.resolveSpawnDelivery), a move is refused before anything
 * is written when a row it takes asks to ship as a pull request and the
 * repository it lands in has none.
 */
export function refuseRemoteless(
  repos: ProjectMoveContext["repos"],
  moves: readonly { row: TaskRecord; repoId: string | null }[],
  projectName: string,
): void {
  for (const { row, repoId: to } of moves) {
    if (!to || to === row.repoId || !repos) continue;
    const repo = repos.get(to);
    if (repo?.kind === "personal" || repo?.origin) continue;
    if (!opensPullRequest(deliveryForRecord(row, "local-only"))) continue;
    const name = repo?.name ?? projectName;
    const handle = keyOrId(row);
    throw new TaskGraphRefusal(
      `Refused: ${handle} asks to ship as a pull request (direct-pr), and ${name} has no remote to open one on, so ${handle} cannot move there. Configure a remote for ${name}, or set ${handle}'s delivery to local-only first.`,
    );
  }
}

/** Which tasks of one project follow its repositories: all of them when it empties. */
export type RepositoryTaskSource = { projectId: string; whole: boolean };

/**
 * The tasks a move of repositories takes along (INF-5005), by id: every
 * task of a project that empties, else those working in a moved repository.
 */
export function tasksJoining(
  store: Pick<TaskWriter["store"], "listInProject">,
  move: { sources: readonly RepositoryTaskSource[]; repos: readonly { id: string }[] },
): Map<string, TaskRecord> {
  const repos = new Set(move.repos.map((repo) => repo.id));
  const moving = new Map<string, TaskRecord>();
  for (const source of move.sources)
    for (const record of store.listInProject(source.projectId))
      if (source.whole || (record.repoId !== null && repos.has(record.repoId)))
        moving.set(record.id, record);
  return moving;
}

const live = (record: TaskRecord): boolean =>
  record.status === "open" || record.status === "active";

/**
 * Tasks join another project with their repositories (INF-5005, inside the
 * caller's transaction, after the repositories moved). Each keeps its key
 * and number, whatever its status, and only its project changes, so
 * nothing written about it names it differently. A project that empties
 * gives every task it has; one that keeps other repositories gives the
 * tasks working in the moved ones, and an open task and its open part
 * that would end up in different projects refuse the move, naming both.
 * Each moved task gets one `moved` event. Answers how many moved.
 */
export function joinWithRepositories(
  writer: TaskWriter,
  move: {
    to: Pick<ProjectRecord, "id" | "name">;
    sources: readonly RepositoryTaskSource[];
    repos: readonly { id: string; name: string }[];
  },
  actor: TaskEventActor,
  at: number,
): number {
  const movedRepos = new Map(move.repos.map((repo) => [repo.id, repo.name]));
  const moving = tasksJoining(writer.store, move);
  const emptying = new Set(
    move.sources
      .filter((source) => source.whole && source.projectId !== move.to.id)
      .map((source) => source.projectId),
  );
  const staying = (record: TaskRecord | undefined): record is TaskRecord =>
    record !== undefined &&
    !moving.has(record.id) &&
    move.sources.some((source) => !source.whole && source.projectId === record.projectId);
  for (const record of moving.values()) {
    const parent = record.parentId ? writer.store.get(record.parentId) : undefined;
    const pairs = [
      ...(staying(parent) ? [[parent, record] as const] : []),
      ...writer.store
        .listChildren(record.id)
        .filter(staying)
        .map((child) => [record, child] as const),
    ];
    for (const [above, part] of pairs) {
      // Only an open task and its open part hold a move: a closed one of the
      // pair goes its own way.
      if (!live(above) || !live(part)) continue;
      throw new TaskGraphRefusal(
        `Refused: ${keyOrId(above)} and its part ${keyOrId(part)} would end up in different projects. Move their repositories together, or close or re-parent one first.`,
      );
    }
  }
  for (const record of moving.values()) {
    const repository = record.repoId ? movedRepos.get(record.repoId) : undefined;
    writer.patch(record.id, { projectId: move.to.id });
    // A task leaving a project that keeps other repositories leaves its
    // tags behind; a project that empties brings them (carryProjectTags).
    if (!emptying.has(record.projectId)) writer.store.tags.deleteFor(record.id);
    writer.addEvent({
      taskId: record.id,
      at,
      actor,
      kind: "moved",
      text: `joined ${move.to.name}${repository ? ` with ${repository}` : ""}, keeping ${keyOrId(record)}`,
      data: {
        fromProjectId: record.projectId,
        toProjectId: move.to.id,
        withRepositories: [...movedRepos.keys()],
      },
      feed: false,
    });
  }
  for (const fromProjectId of emptying)
    carryProjectTags(
      writer,
      {
        fromProjectId,
        toProjectId: move.to.id,
        taskIds: [...moving.values()]
          .filter((record) => record.projectId === fromProjectId)
          .map((record) => record.id),
      },
      at,
    );
  return moving.size;
}
