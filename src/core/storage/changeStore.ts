import { randomUUID } from "node:crypto";
import type {
  ChangeChecks,
  ChangeConsent,
  ChangeReceipt,
  ChangeRecord,
  ChangeStory,
  ChangeVersion,
} from "@shared/change";
import { type ForgeKind, forgeOf, sameRequestLink } from "@shared/forge";
import type { RepoKind } from "@shared/repos";
import {
  type ChangeRepo,
  carriesChange,
  otherChangeNumbers,
  otherChangeRepoId,
  type ProjectedChange,
  projectChange,
  projectOtherChange,
} from "./changeProjection";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";
import type { TaskRecord } from "./taskRecords";

export { carriesChange, isHostRaisedShape, projectChange } from "./changeProjection";

/**
 * The change tables (INF-1868 piece 1): one `changes` row per change, and
 * one `change_versions` row per version pushed, in the order the host saw
 * them. A project's row is not referenced, because removing a project keeps
 * what its changes recorded.
 */
export const CHANGE_TABLES = `
  CREATE TABLE changes (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    base TEXT,
    head_branch TEXT NOT NULL,
    handle_kind TEXT,
    handle_number INTEGER,
    handle_url TEXT,
    handle_label TEXT,
    raised_by_json TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    override_json TEXT,
    receipt_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX changes_task ON changes(task_id);
  CREATE INDEX changes_handle ON changes(repo_id, handle_number);
  CREATE TABLE change_versions (
    change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    head TEXT NOT NULL,
    at INTEGER,
    checks_json TEXT,
    review_json TEXT,
    story_json TEXT,
    consent_json TEXT,
    PRIMARY KEY (change_id, seq),
    UNIQUE (change_id, head)
  );
`;

type ChangeRow = {
  id: string;
  repo_id: string;
  base: string | null;
  head_branch: string;
  handle_kind: "pr" | "mr" | null;
  handle_number: number | null;
  handle_url: string | null;
  handle_label: string | null;
  raised_by_json: string;
  task_id: string | null;
  override_json: string | null;
  receipt_json: string | null;
  created_at: number;
  updated_at: number;
};

type VersionRow = {
  change_id: string;
  seq: number;
  head: string;
  at: number | null;
  checks_json: string | null;
  review_json: string | null;
  story_json: string | null;
  consent_json: string | null;
};

function tableExists(db: AppDatabase, name: string): boolean {
  return Boolean(
    prepared(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parsed<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

/** The earlier of a version's recorded date and a newly supplied one: when the host first saw it. */
function earliest(stored: number | null, fresh: number | null): number | null {
  if (stored === null || fresh === null) return fresh ?? stored;
  return Math.min(stored, fresh);
}

/**
 * A version's facts after a later write: a component the slot still names
 * is replaced by its newest reading, and one it no longer names - the
 * publication the next story moved past, the click a later approval
 * superseded - is kept.
 */
function kept<T extends object>(stored: T | null, fresh: T | null): T | null {
  if (stored === null || fresh === null) return fresh ?? stored;
  return { ...stored, ...fresh };
}

/**
 * A change's receipt after a later write (INF-2490): a merge is final, so a
 * merged receipt stays when the slot stops naming what showed it - a later
 * reading of another pull request, a cleared approval - and a later merged
 * reading adds to it; a close or a discard follows the slot. A different
 * pull request on the branch starts without it.
 */
function keptReceipt(
  stored: ChangeReceipt | null,
  fresh: ChangeReceipt | null,
  samePull: boolean,
): ChangeReceipt | null {
  if (stored?.outcome !== "merged" || !samePull) return fresh;
  if (fresh?.outcome !== "merged") return stored;
  return { ...stored, ...fresh, at: fresh.at ?? stored.at };
}

/**
 * A version's checks after a later write: a reading - its state, snapshot
 * and times - is one fact, so the newest reading at this head replaces the
 * last whole and a time it no longer names goes with it; the lines against
 * the base are read apart from it and kept until read again; a head the
 * slot no longer reads keeps its last reading.
 */
function keptChecks(stored: ChangeChecks | null, fresh: ChangeChecks | null): ChangeChecks | null {
  if (stored === null || fresh === null) return fresh ?? stored;
  const { lines: storedLines, ...storedReading } = stored;
  const { lines: freshLines, ...freshReading } = fresh;
  const reading = Object.keys(freshReading).length > 0 ? freshReading : storedReading;
  const lines = freshLines ?? storedLines;
  return { ...reading, ...(lines ? { lines } : {}) };
}

/** The story's revisions accumulate, because the slot keeps only the newest and the published one. */
function keptStory(stored: ChangeStory | null, fresh: ChangeStory | null): ChangeStory | null {
  const merged = kept(stored, fresh);
  if (!stored || !fresh || !merged) return merged;
  const revisions = new Map(stored.revisions.map((revision) => [revision.revision, revision]));
  for (const revision of fresh.revisions) revisions.set(revision.revision, revision);
  return {
    ...merged,
    revisions: [...revisions.values()].sort((a, b) => a.revision - b.revision),
  };
}

function version(row: VersionRow): ChangeVersion {
  return {
    seq: row.seq,
    head: row.head,
    at: row.at,
    checks: parsed(row.checks_json),
    review: parsed(row.review_json),
    story: parsed(row.story_json),
    consent: parsed(row.consent_json),
  };
}

function record(row: ChangeRow, versions: VersionRow[]): ChangeRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    base: row.base,
    head: { branch: row.head_branch },
    handle:
      row.handle_kind && row.handle_number !== null
        ? {
            kind: row.handle_kind,
            number: row.handle_number,
            ...(row.handle_url ? { url: row.handle_url } : {}),
            ...(row.handle_label ? { label: row.handle_label } : {}),
          }
        : null,
    raisedBy: JSON.parse(row.raised_by_json),
    taskId: row.task_id,
    override: parsed(row.override_json),
    receipt: parsed(row.receipt_json),
    versions: versions.map(version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The host's change record (INF-1868 piece 1, `docs/task-record.md` "A
 * task's change"): the change a task carries on its own branch, and one
 * change for every other pull request it names (INF-2490), projected from
 * the task's delivery facts on every write that can move them, so the
 * record is current while those facts keep their writers. A version once
 * recorded stays, with the facts last read at it; a fact the task no
 * longer names is kept, never erased. Only TaskStore writes these tables,
 * beneath TaskService.
 */
export class ChangeStore {
  private present = false;

  constructor(private readonly db: AppDatabase) {}

  /** Whether this database has the tables yet; migration tests read an older schema. */
  exists(): boolean {
    this.present ||= tableExists(this.db, "changes");
    return this.present;
  }

  get(id: string): ChangeRecord | undefined {
    if (!this.exists()) return undefined;
    const row = prepared(this.db, "SELECT * FROM changes WHERE id = ?").get(id) as
      | ChangeRow
      | undefined;
    return row ? record(row, this.versionsOf(row.id)) : undefined;
  }

  /** The change a task carries on its own branch, when it carries one. */
  forTask(taskId: string): ChangeRecord | undefined {
    const row = this.rowForTask(taskId);
    return row ? record(row, this.versionsOf(row.id)) : undefined;
  }

  /** Every change a task names, oldest first: its own and each other pull request. */
  allForTask(taskId: string): ChangeRecord[] {
    if (!this.exists()) return [];
    const rows = prepared(
      this.db,
      "SELECT * FROM changes WHERE task_id = ? ORDER BY created_at, id",
    ).all(taskId) as ChangeRow[];
    return rows.map((row) => record(row, this.versionsOf(row.id)));
  }

  /** Every change, oldest first. */
  list(): ChangeRecord[] {
    if (!this.exists()) return [];
    const rows = prepared(
      this.db,
      "SELECT * FROM changes ORDER BY created_at, id",
    ).all() as ChangeRow[];
    const versions = new Map<string, VersionRow[]>();
    for (const row of prepared(
      this.db,
      "SELECT * FROM change_versions ORDER BY change_id, seq",
    ).all() as VersionRow[]) {
      const own = versions.get(row.change_id) ?? [];
      own.push(row);
      versions.set(row.change_id, own);
    }
    return rows.map((row) => record(row, versions.get(row.id) ?? []));
  }

  /**
   * Reads this task's change out of its record and writes it: a task that
   * carries a change gets one, and a change a task already has follows its
   * facts. The task's own clock dates the write.
   */
  project(task: TaskRecord): void {
    if (!this.exists()) return;
    const existing = this.rowForTask(task.id);
    const repo = this.repo(task.repoId);
    if (!repo || (!existing && !carriesChange(task, repo))) return;
    this.write(existing, task.updatedAt, (recorded) => projectChange(task, repo, recorded));
    for (const number of otherChangeNumbers(task)) {
      // A request number is assigned by its forge repository, not by the managed project.
      const elsewhere = otherChangeRepoId(task, number);
      const where = elsewhere ? this.repo(elsewhere) : repo;
      if (!where) continue;
      const project = (recorded: readonly string[]) =>
        projectOtherChange(task, where, number, recorded);
      const fresh = project([]);
      const rows = prepared(
        this.db,
        "SELECT * FROM changes WHERE task_id = ? AND handle_number = ? AND id IS NOT ?",
      ).all(task.id, number, existing?.id ?? this.rowForTask(task.id)?.id) as ChangeRow[];
      const other = rows.find(
        (row) =>
          row.repo_id === fresh.repoId &&
          (sameRequestLink(row.handle_url, fresh.handle?.url) ||
            row.handle_url === (fresh.handle?.url ?? null)),
      );
      this.write(other, task.updatedAt, project);
    }
  }

  /** Write one projected change over its row, or as a new one. */
  private write(
    existing: ChangeRow | undefined,
    at: number,
    project: (recorded: readonly string[]) => ProjectedChange,
  ): void {
    const id = existing?.id ?? this.freshId();
    const known = new Map(
      (
        prepared(this.db, "SELECT * FROM change_versions WHERE change_id = ?").all(
          id,
        ) as VersionRow[]
      ).map((row) => [row.head, row]),
    );
    const change = project([...known.keys()]);
    const requestReplaced =
      !!existing?.handle_number &&
      !!change.handle?.url &&
      existing.handle_url !== change.handle.url &&
      !sameRequestLink(existing.handle_url, change.handle.url);
    if (existing)
      prepared(
        this.db,
        `UPDATE changes SET repo_id = ?, base = COALESCE(?, base), head_branch = ?,
           handle_kind = COALESCE(?, handle_kind), handle_number = COALESCE(?, handle_number),
           handle_url = COALESCE(?, handle_url), handle_label = COALESCE(?, handle_label),
           override_json = COALESCE(?, override_json), receipt_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        change.repoId,
        change.base,
        change.head.branch,
        change.handle?.kind ?? null,
        change.handle?.number ?? null,
        change.handle?.url ?? null,
        change.handle?.label ?? null,
        json(change.override),
        json(
          keptReceipt(
            parsed(existing.receipt_json),
            change.receipt,
            (change.handle?.number ?? existing.handle_number) === existing.handle_number,
          ),
        ),
        at,
        id,
      );
    else
      prepared(
        this.db,
        `INSERT INTO changes (id, repo_id, base, head_branch, handle_kind, handle_number, handle_url,
           handle_label, raised_by_json, task_id, override_json, receipt_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        change.repoId,
        change.base,
        change.head.branch,
        change.handle?.kind ?? null,
        change.handle?.number ?? null,
        change.handle?.url ?? null,
        change.handle?.label ?? null,
        JSON.stringify(change.raisedBy),
        change.taskId,
        json(change.override),
        json(change.receipt),
        at,
        at,
      );
    let next = Math.max(0, ...[...known.values()].map((row) => row.seq)) + 1;
    for (const entry of change.versions) {
      const stored = known.get(entry.head);
      if (stored === undefined) {
        const row: VersionRow = {
          change_id: id,
          seq: next,
          head: entry.head,
          at: entry.at,
          checks_json: json(entry.checks),
          review_json: json(entry.review),
          story_json: json(entry.story),
          consent_json: json(entry.consent),
        };
        prepared(
          this.db,
          `INSERT INTO change_versions (change_id, seq, head, at, checks_json, review_json, story_json, consent_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.change_id,
          row.seq,
          row.head,
          row.at,
          row.checks_json,
          row.review_json,
          row.story_json,
          row.consent_json,
        );
        known.set(entry.head, row);
        next += 1;
      } else {
        const consent = parsed<ChangeConsent>(stored.consent_json);
        if (requestReplaced && consent) delete consent.override;
        prepared(
          this.db,
          `UPDATE change_versions SET at = ?, checks_json = ?, review_json = ?, story_json = ?,
             consent_json = ?
           WHERE change_id = ? AND seq = ?`,
        ).run(
          earliest(stored.at, entry.at),
          json(keptChecks(parsed(stored.checks_json), entry.checks)),
          json(entry.review ?? parsed(stored.review_json)),
          json(keptStory(parsed(stored.story_json), entry.story)),
          json(kept(consent, entry.consent)),
          id,
          stored.seq,
        );
      }
    }
  }

  deleteFor(taskId: string): void {
    if (!this.exists()) return;
    prepared(
      this.db,
      "DELETE FROM change_versions WHERE change_id IN (SELECT id FROM changes WHERE task_id = ?)",
    ).run(taskId);
    prepared(this.db, "DELETE FROM changes WHERE task_id = ?").run(taskId);
  }

  deleteAll(): void {
    if (!this.exists()) return;
    this.db.prepare("DELETE FROM change_versions").run();
    this.db.prepare("DELETE FROM changes").run();
  }

  /** The task's own change is inserted first; equal clocks never select a fork on that branch. */
  private rowForTask(taskId: string): ChangeRow | undefined {
    if (!this.exists()) return undefined;
    return prepared(
      this.db,
      `SELECT changes.* FROM changes JOIN tasks ON tasks.id = changes.task_id
       WHERE changes.task_id = ? AND changes.head_branch IS tasks.branch
       ORDER BY changes.rowid LIMIT 1`,
    ).get(taskId) as ChangeRow | undefined;
  }

  private versionsOf(changeId: string): VersionRow[] {
    return prepared(this.db, "SELECT * FROM change_versions WHERE change_id = ? ORDER BY seq").all(
      changeId,
    ) as VersionRow[];
  }

  /** The project facts a change reads; none when the task names no project the app has. */
  private repo(repoId: string | null): ChangeRepo | undefined {
    if (!repoId) return undefined;
    const row = prepared(this.db, "SELECT kind, forge_kind, origin FROM repos WHERE id = ?").get(
      repoId,
    ) as { kind: RepoKind; forge_kind: ForgeKind | null; origin: string | null } | undefined;
    if (!row) return undefined;
    return { kind: row.kind, forge: row.forge_kind ?? forgeOf(row.origin).kind };
  }

  private freshId(): string {
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!prepared(this.db, "SELECT 1 FROM changes WHERE id = ?").get(id)) return id;
    }
  }
}
