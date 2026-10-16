import {
  deriveProjectKey,
  normalizeProjectKey,
  ProjectKeyRefusal,
  projectKeyInUseWords,
} from "../tasks/projectKey";
import type { AppDatabase } from "./db";

/**
 * Projects (task-system design section 8, captain decision D5): one per
 * managed repo plus Scratch. A project owns the per-project task sequence
 * that mints keys like `FM3K-12` (D6). Scratch is seeded by migration 17,
 * receives every task that is not about a repo, and is never archived.
 * Repo projects are created in the same transaction as the repo row and
 * archived - never deleted - when the repo is unregistered, so a closed
 * task's key still resolves.
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
  };
}

/** The id a repo's project carries; deterministic so migrations and runtime agree. */
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
  const owner = db
    .prepare("SELECT name, archived_at FROM projects WHERE UPPER(key) = ?")
    .get(normalized) as { name: string; archived_at: number | null } | undefined;
  if (owner)
    throw new ProjectKeyRefusal(
      projectKeyInUseWords(normalized, owner.name, owner.archived_at !== null),
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

export class ProjectStore {
  constructor(private readonly db: AppDatabase) {}

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

  forRepo(repoId: string): ProjectRecord | undefined {
    return this.get(repoProjectId(repoId));
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

  /** Rename the project without changing its key, sequence or task history. */
  renameForRepo(repoId: string, name: string): void {
    this.db.prepare("UPDATE projects SET name = ? WHERE repo_id = ?").run(name, repoId);
  }

  /** A row verbatim (the task export's reload); the caller checked for collisions. */
  insert(project: ProjectRecord): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, key, name, kind, repo_id, next_seq, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** A chosen key, normalized, or its refusal in words (`freeProjectKey`). */
  freeKey(key: string): string {
    return freeProjectKey(this.db, key);
  }

  /** The repo's project, created if missing (project-setup's half of D5). */
  ensureForRepo(repo: { id: string; name: string }, key?: string): ProjectRecord {
    const id = ensureRepoProject(this.db, repo, Date.now(), key);
    return this.get(id) as ProjectRecord;
  }

  /** unregister_repo archives; closed tasks under the project stay readable. */
  archiveForRepo(repoId: string): void {
    this.db
      .prepare("UPDATE projects SET archived_at = ? WHERE repo_id = ? AND archived_at IS NULL")
      .run(Date.now(), repoId);
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
