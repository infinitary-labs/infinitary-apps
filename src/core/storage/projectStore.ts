import {
  deriveProjectKey,
  normalizeProjectKey,
  ProjectKeyRefusal,
  projectKeyInUseWords,
} from "../tasks/projectKey";
import type { AppDatabase } from "./db";

/**
 * Projects (task-system design section 8, captain decision D5, amended by
 * INF-4220): each managed repository belongs to one project, named by its
 * `repos.project_id`, and a project may hold several; plus Scratch. A
 * project owns the per-project task sequence that mints keys like
 * `FM3K-12` (D6). Scratch is seeded by migration 17, receives every task
 * that is not about a repo, and is never archived. A repository's own
 * project is created in the same transaction as the repo row, unless the
 * repository joins an existing one, and is archived - never deleted - when
 * its last repository is unregistered, so a closed task's key still
 * resolves. `projects.repo_id` stays the repository a project was made
 * with; nothing reads it for membership.
 */

export const SCRATCH_PROJECT_ID = "scratch";
export const SCRATCH_PROJECT_KEY = "SCR";
export const SCRATCH_PROJECT_NAME = "Scratch";

export type ProjectRecord = {
  id: string;
  key: string;
  name: string;
  kind: "scratch" | "repo";
  repoId: string | null;
  nextSeq: number;
  createdAt: number;
  archivedAt: number | null;
  /** The project a move combined this removed one into (INF-5005), when one did. */
  combinedInto?: string | null;
};

type Row = {
  id: string;
  key: string;
  name: string;
  kind: ProjectRecord["kind"];
  repo_id: string | null;
  next_seq: number;
  created_at: number;
  archived_at: number | null;
  combined_into?: string | null;
};

function fromRow(row: Row): ProjectRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    repoId: row.repo_id,
    nextSeq: row.next_seq,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    ...(row.combined_into ? { combinedInto: row.combined_into } : {}),
  };
}

export type ProjectRepository = { id: string; name: string; kind: "project" | "personal" };

/** The id a repo's own project carries; deterministic so migrations and runtime agree. */
export function repoProjectId(repoId: string): string {
  return `proj-${repoId}`;
}

/** Every key in use, for derivation. Shared with migration 17. */
export function takenProjectKeys(db: AppDatabase): string[] {
  return (db.prepare("SELECT key FROM projects").all() as { key: string }[]).map((row) => row.key);
}

/** Insert Scratch if it is missing (migration 17 and a defensive boot). */
export function ensureScratchProject(db: AppDatabase, now: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, key, name, kind, repo_id, next_seq, created_at, archived_at)
     VALUES (?, ?, ?, 'scratch', NULL, 1, ?, NULL)`,
  ).run(SCRATCH_PROJECT_ID, SCRATCH_PROJECT_KEY, SCRATCH_PROJECT_NAME, now);
}

/**
 * A key chosen for a new project (Settings' Add project, the setup card),
 * normalized. It is refused in words when it is not 2-4 letters or digits,
 * or when any project has it - Scratch and a removed project included, so
 * a closed task's key still names one project.
 */
export function freeProjectKey(db: AppDatabase, key: string): string {
  const normalized = normalizeProjectKey(key);
  // A removed project a move emptied was combined into another
  // (INF-5005), and its refusal names that one.
  const owner = db
    .prepare(
      `SELECT p.name, p.archived_at, q.name AS combined
       FROM projects p LEFT JOIN projects q ON q.id = p.combined_into
       WHERE UPPER(p.key) = ?`,
    )
    .get(normalized) as
    | { name: string; archived_at: number | null; combined: string | null }
    | undefined;
  if (owner)
    throw new ProjectKeyRefusal(
      projectKeyInUseWords(
        normalized,
        owner.name,
        owner.archived_at === null
          ? false
          : owner.combined
            ? { combinedInto: owner.combined }
            : true,
      ),
    );
  return normalized;
}

/**
 * Insert a repo's project if it is missing; returns its id. The key is the
 * caller's when given and free (`freeProjectKey`), else derived from the
 * name against every key in use.
 */
export function ensureRepoProject(
  db: AppDatabase,
  repo: { id: string; name: string },
  now: number,
  key?: string,
): string {
  const id = repoProjectId(repo.id);
  const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (existing) return id;
  const resolvedKey =
    key === undefined ? deriveProjectKey(repo.name, takenProjectKeys(db)) : freeProjectKey(db, key);
  db.prepare(
    `INSERT INTO projects (id, key, name, kind, repo_id, next_seq, created_at, archived_at)
     VALUES (?, ?, ?, 'repo', ?, 1, ?, NULL)`,
  ).run(id, resolvedKey, repo.name, repo.id, now);
  return id;
}

/**
 * The project a new repository joins instead of getting its own (INF-4220),
 * or its refusal: Scratch, the personal workspace's project and a removed
 * project take no repository.
 */
export function joinableProject(db: AppDatabase, projectId: string): string {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
  if (!row) throw new Error(`Unknown project "${projectId}".`);
  if (row.kind === "scratch") throw new Error(`${row.name} takes no repository.`);
  if (row.archived_at !== null) throw new Error(`${row.name} was removed, so nothing can join it.`);
  const personal = db
    .prepare("SELECT 1 FROM repos WHERE project_id = ? AND kind = 'personal'")
    .get(projectId);
  if (personal) throw new Error(`${row.name} is the personal workspace and takes no repository.`);
  return row.id;
}

export class ProjectStore {
  private membership: boolean | undefined;
  constructor(private readonly db: AppDatabase) {}

  /**
   * Whether the record names each repository's project (`repos.project_id`);
   * a record opened at an older version reads each repository as its own.
   */
  private hasMembership(): boolean {
    this.membership ??= (
      this.db.prepare("PRAGMA table_info(repos)").all() as { name: string }[]
    ).some((column) => column.name === "project_id");
    return this.membership;
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  byKey(key: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE key = ?").get(key.toUpperCase()) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * The project a repository belongs to; for one no longer registered, the
   * project it was made with, so its closed tasks still read theirs.
   */
  forRepo(repoId: string): ProjectRecord | undefined {
    if (!this.hasMembership()) return this.get(repoProjectId(repoId));
    const row = this.db
      .prepare("SELECT p.* FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.id = ?")
      .get(repoId) as Row | undefined;
    return row ? fromRow(row) : this.get(repoProjectId(repoId));
  }

  /** A project's registered repositories, oldest first; none for Scratch or a removed project. */
  repositoriesOf(projectId: string): ProjectRepository[] {
    if (!this.hasMembership())
      return this.db
        .prepare(
          "SELECT r.id, r.name, r.kind FROM projects p JOIN repos r ON r.id = p.repo_id WHERE p.id = ?",
        )
        .all(projectId) as ProjectRepository[];
    return this.db
      .prepare("SELECT id, name, kind FROM repos WHERE project_id = ? ORDER BY added_at, id")
      .all(projectId) as ProjectRepository[];
  }

  scratch(): ProjectRecord {
    const project = this.get(SCRATCH_PROJECT_ID);
    if (project) return project;
    ensureScratchProject(this.db, Date.now());
    return this.get(SCRATCH_PROJECT_ID) as ProjectRecord;
  }

  list(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as Row[];
    return rows.map(fromRow);
  }

  /**
   * Rename a repository's project with it, without changing its key,
   * sequence or task history - only while it is the project's one
   * repository: a project of several keeps a name of its own.
   */
  renameForRepo(repoId: string, name: string): void {
    this.db
      .prepare(
        `UPDATE projects SET name = ? WHERE id = (SELECT project_id FROM repos WHERE id = ?)
         AND (SELECT COUNT(*) FROM repos WHERE project_id = projects.id) = 1`,
      )
      .run(name, repoId);
  }

  /**
   * Name a project of its own, keeping its key, sequence and task history
   * (INF-4220): Settings' Name for a project of several repositories.
   */
  rename(projectId: string, name: string): void {
    this.db
      .prepare(
        "UPDATE projects SET name = ? WHERE id = ? AND kind = 'repo' AND archived_at IS NULL",
      )
      .run(name, projectId);
  }

  /** A row verbatim (the task export's reload); the caller checked for collisions. */
  insert(project: ProjectRecord): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, key, name, kind, repo_id, next_seq, created_at, archived_at, combined_into)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.key,
        project.name,
        project.kind,
        project.repoId,
        project.nextSeq,
        project.createdAt,
        project.archivedAt,
        project.combinedInto ?? null,
      );
  }

  /** A project's sequence never runs backwards; an import raises it to what its rows used. */
  raiseNextSeq(projectId: string, nextSeq: number): void {
    this.db
      .prepare("UPDATE projects SET next_seq = ? WHERE id = ? AND next_seq < ?")
      .run(nextSeq, projectId, nextSeq);
  }

  /**
   * An import meeting a project that already exists here (Scratch, always;
   * a repo's project when the repo is registered): the row stays, its
   * sequence rises to what the imported rows used, and its birth is the
   * earlier of the two - a project cannot be younger than its oldest task.
   */
  adopt(project: ProjectRecord): void {
    this.db
      .prepare(
        "UPDATE projects SET next_seq = MAX(next_seq, ?), created_at = MIN(created_at, ?) WHERE id = ?",
      )
      .run(project.nextSeq, project.createdAt, project.id);
  }

  freeKey(key: string): string {
    return freeProjectKey(this.db, key);
  }

  /**
   * The repo's own project, created if missing (project-setup's half of D5),
   * and named as the project of a registered repository that names none, so
   * `forRepo` and `repositoriesOf` read the same membership.
   */
  ensureForRepo(repo: { id: string; name: string }, key?: string): ProjectRecord {
    const id = ensureRepoProject(this.db, repo, Date.now(), key);
    if (this.hasMembership())
      this.db
        .prepare("UPDATE repos SET project_id = ? WHERE id = ? AND project_id IS NULL")
        .run(id, repo.id);
    return this.get(id) as ProjectRecord;
  }

  /**
   * unregister_repo archives the project its last repository left; closed
   * tasks under it stay readable. One that still holds a repository stays.
   */
  archiveIfEmpty(projectId: string, combinedInto: string | null = null): void {
    this.db
      .prepare(
        `UPDATE projects SET archived_at = ?, combined_into = ? WHERE id = ? AND kind = 'repo' AND archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM repos WHERE project_id = ?)`,
      )
      .run(Date.now(), combinedInto, projectId, projectId);
  }

  /**
   * Repositories join another project (INF-5005, `project-move`): only each
   * row's project changes, so its id, name, folder, settings and cost limit
   * stay. The caller archives an emptied project and runs this inside the
   * move's one transaction.
   */
  moveRepositories(repoIds: readonly string[], projectId: string): void {
    const move = this.db.prepare("UPDATE repos SET project_id = ? WHERE id = ?");
    for (const id of repoIds) move.run(projectId, id);
  }

  /**
   * A removed project back on the list with its key, numbering and task
   * history (INF-5005): the project a repository was made with, when that
   * repository moves to a project of its own again. It takes the
   * repository's name, as a project of one does.
   */
  revive(projectId: string, name: string): void {
    this.db
      .prepare(
        "UPDATE projects SET archived_at = NULL, combined_into = NULL, name = ? WHERE id = ? AND kind = 'repo' AND archived_at IS NOT NULL",
      )
      .run(name, projectId);
  }

  /**
   * Take the next sequence number for a project. Callers run this inside
   * the task insert's transaction so a key is never minted without its row.
   */
  allocateSeq(projectId: string): { seq: number; key: string } {
    const row = this.db.prepare("SELECT key, next_seq FROM projects WHERE id = ?").get(projectId) as
      | { key: string; next_seq: number }
      | undefined;
    if (!row) throw new Error(`Unknown project "${projectId}".`);
    this.db.prepare("UPDATE projects SET next_seq = next_seq + 1 WHERE id = ?").run(projectId);
    return { seq: row.next_seq, key: `${row.key}-${row.next_seq}` };
  }
}
