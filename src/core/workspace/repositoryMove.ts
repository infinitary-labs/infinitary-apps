import { createHash, randomUUID } from "node:crypto";
import { type Said, type SaidPart, said, saidPart } from "@shared/i18n/said";
import type { RepoMoveTarget, RepoView } from "@shared/repos";
import type { AppDatabase } from "../storage/db";
import {
  ensureRepoProject,
  joinableProject,
  type ProjectRecord,
  type ProjectStore,
  repoProjectId,
  takenProjectKeys,
} from "../storage/projectStore";
import { deriveProjectKey } from "../tasks/projectKey";

export type MoveSource = { id: string; key: string; name: string; empties: boolean };

/**
 * A checked move of repositories into one project (INF-5005), read before
 * anything is written: the repositories, the projects they leave, and the
 * project they join - an existing one, the removed project a repository
 * was made with brought back, or a new one.
 */
export type RepositoryMove = {
  repos: { id: string; name: string; from: string }[];
  sources: MoveSource[];
  target:
    | { kind: "existing"; id: string; key: string; name: string }
    | { kind: "revive"; id: string; key: string; name: string }
    | { kind: "new"; id: string; key: string; name: string; repoId: string; chosen: boolean };
};

type Reach = {
  db: AppDatabase;
  projects: ProjectStore;
  get: (id: string) => RepoView | undefined;
};

/**
 * Check a move and say what it would do, or refuse it in words: every
 * repository is registered and not the personal workspace; an existing
 * target is one a repository may join (`joinableProject`) and holds none of
 * them yet; a project of its own takes one repository at a time.
 */
export function planRepositoryMove(
  { db, projects, get }: Reach,
  repoIds: readonly string[],
  target: RepoMoveTarget,
): RepositoryMove {
  const ids = [...new Set(repoIds)];
  if (ids.length === 0) throw new Error("Name the repositories to move.");
  const repos = ids.map((id) => {
    const repo = get(id);
    if (!repo) throw new Error(`No repository "${id}" is on the list.`);
    if (repo.kind === "personal")
      throw new Error("The personal workspace keeps a project of its own.");
    const from = projects.forRepo(id);
    if (!from) throw new Error(`${repo.name} has no project.`);
    return { id, name: repo.name, from };
  });
  const sources = [...new Map(repos.map((repo) => [repo.from.id, repo.from])).values()].map(
    (project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      empties: projects.repositoriesOf(project.id).every((held) => ids.includes(held.id)),
    }),
  );
  const planned = (resolved: RepositoryMove["target"]): RepositoryMove => ({
    repos: repos.map(({ id, name, from }) => ({ id, name, from: from.id })),
    sources,
    target: resolved,
  });
  if (typeof target === "string") {
    const project = projects.byKey(target.trim());
    if (!project) throw new Error(`No project has the task key ${target.trim().toUpperCase()}.`);
    joinableProject(db, project.id);
    const there = repos.filter((repo) => repo.from.id === project.id).map((repo) => repo.name);
    if (there.length)
      throw new Error(
        `${there.join(" and ")} ${there.length > 1 ? "are" : "is"} already in ${project.name}.`,
      );
    return planned({ kind: "existing", id: project.id, key: project.key, name: project.name });
  }
  const [repo] = repos;
  if (!repo || repos.length > 1)
    throw new Error("One repository at a time moves to a project of its own.");
  const madeWith = projects.get(repoProjectId(repo.id));
  const chosen = target.key === undefined ? undefined : projects.freeKey(target.key);
  if (madeWith && madeWith.archivedAt !== null) {
    if (target.key !== undefined)
      throw new Error(
        `${repo.name}'s own project ${madeWith.name} comes back with its task key ${madeWith.key}.`,
      );
    return planned({ kind: "revive", id: madeWith.id, key: madeWith.key, name: repo.name });
  }
  if (projects.repositoriesOf(repo.from.id).length === 1)
    throw new Error(`${repo.name} is already in a project of its own, ${repo.from.name}.`);
  // The project the repository was made with still lives, holding others
  // (whether or not the repository is still among them), so a new project
  // takes it under an id of its own and no origin link.
  const id = madeWith
    ? `${repoProjectId(repo.id)}-${randomUUID().slice(0, 8)}`
    : repoProjectId(repo.id);
  return planned({
    kind: "new",
    id,
    key: chosen ?? deriveProjectKey(repo.name, takenProjectKeys(db)),
    name: repo.name,
    repoId: repo.id,
    chosen: chosen !== undefined,
  });
}

/**
 * Write a checked move's rows, inside the caller's transaction, and answer
 * the project the repositories joined: the target made or brought back,
 * each repository's project, each emptied project archived with its key
 * kept, and a project left with one repository named with it again.
 */
export function applyRepositoryMove(
  { db, projects }: Omit<Reach, "get">,
  move: RepositoryMove,
): ProjectRecord {
  const { target } = move;
  if (target.kind === "revive") projects.revive(target.id, target.name);
  if (target.kind === "new") {
    if (target.id === repoProjectId(target.repoId))
      ensureRepoProject(
        db,
        { id: target.repoId, name: target.name },
        Date.now(),
        target.chosen ? target.key : undefined,
      );
    // The project the repository was made with still holds others and
    // keeps the origin link (`projects.repo_id`, unique), so the new one
    // takes none.
    else
      projects.insert({
        id: target.id,
        key: target.key,
        name: target.name,
        kind: "repo",
        repoId: null,
        nextSeq: 1,
        createdAt: Date.now(),
        archivedAt: null,
      });
  }
  projects.moveRepositories(
    move.repos.map((repo) => repo.id),
    target.id,
  );
  for (const source of move.sources) {
    projects.archiveIfEmpty(source.id, target.id);
    const left = projects.repositoriesOf(source.id);
    if (left.length === 1 && left[0]) projects.renameForRepo(left[0].id, left[0].name);
  }
  const joined = projects.get(target.id);
  if (!joined) throw new Error(`Unknown project "${target.id}".`);
  return joined;
}

/** What a move takes along, as its card shows it: the tasks that join and the automations that move. */
export type MoveImpact = {
  tasks: readonly { key: string; title: string; status: string }[];
  automations: number;
};

/**
 * What a move of repositories takes along (INF-5005), read before anything
 * is written: the tasks that join (`TaskService.tasksJoining`) and how many
 * automations are about a project it empties.
 */
export function moveImpact(
  move: RepositoryMove,
  reach: {
    tasksJoining: (joining: {
      sources: { projectId: string; whole: boolean }[];
      repos: RepositoryMove["repos"];
    }) => readonly { key: string; title: string; status: string }[];
    automationsAbout: (projectId: string) => number;
  },
): MoveImpact {
  return {
    tasks: reach.tasksJoining({
      sources: move.sources.map((source) => ({ projectId: source.id, whole: source.empties })),
      repos: move.repos,
    }),
    automations: move.sources
      .filter((source) => source.empties)
      .reduce((sum, source) => sum + reach.automationsAbout(source.id), 0),
  };
}

export const STALE_MOVE_CARD =
  "The projects changed since this card was written. Ask for a new card.";

/**
 * One digest of everything a move card promises (INF-5005): the
 * repositories, the projects they leave and join (less the id a new
 * project would take), and the tasks and automations that go with them.
 * `inf:repos:move` compares it in the same synchronous run as its write, so
 * a click never applies a move other than the one its card showed.
 */
export function moveFingerprint(move: RepositoryMove, impact: MoveImpact): string {
  const { id: _made, ...made } = move.target;
  return createHash("sha256")
    .update(
      JSON.stringify({
        repos: move.repos,
        sources: move.sources,
        target: move.target.kind === "new" ? made : move.target,
        tasks: impact.tasks.map(({ key, title, status }) => ({ key, title, status })),
        automations: impact.automations,
      }),
    )
    .digest("hex");
}

/**
 * The move card's words a person reads (the design skill's ChangeCard), as
 * saved facts: the card keeps their English and carries the facts
 * (`cardWordsMark`), so each view words its title and buttons in its own
 * language. The title is asked once per project the repositories join.
 */
export const MOVE_CARD_SAID = {
  title: (move: RepositoryMove): Said => {
    const repositories = namesSaid(move.repos.map((repo) => repo.name));
    return move.target.kind === "existing"
      ? said("projectsMoveTitleInto", { repositories, project: move.target.name })
      : said("projectsMoveTitleOwn", { repositories });
  },
  apply: said("projectsMoveApply"),
  notNow: said("projectsMoveNotNow"),
};

/**
 * Names joined as a fill a fact can carry, in the words of whoever draws
 * it: one name as it is, two joined ("a and b"), more as the first and how
 * many more, which the card's table lists whole.
 */
export function namesSaid(names: readonly string[]): string | SaidPart {
  const [first = "", second] = names;
  if (second === undefined) return first;
  return names.length === 2
    ? saidPart("projectsMoveListTwo", { first, second })
    : saidPart("projectsMoveListMore", { first, count: names.length - 1 });
}
