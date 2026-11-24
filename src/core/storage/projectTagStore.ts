import { randomUUID } from "node:crypto";
import { byTagName, type ProjectTagView, sameTagName } from "@shared/tags";
import type { AppDatabase } from "./db";

/**
 * A project's tags (docs/task-tags.md): the one writer of `project_tags`,
 * reached through `ProjectStore.tags`. Which tasks carry a tag is
 * `task_tags`, written only by `TaskService`; this store reads it only to
 * count them.
 */

export type ProjectTag = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  revision: number;
};

type Row = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  revision: number;
};

function fromRow(row: Row): ProjectTag {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    revision: row.revision,
  };
}

/** A tag change the store refuses, in words the first mate and Settings both show. */
export class ProjectTagRefusal extends Error {}

export class ProjectTagStore {
  private present: boolean | undefined;
  constructor(private readonly db: AppDatabase) {}

  /** A record opened at an older version has no tags table and reads none. */
  private exists(): boolean {
    this.present ??=
      this.db
        // i18n-exempt: SQL, never shown to a person
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_tags'")
        .get() !== undefined;
    return this.present;
  }

  get(id: string): ProjectTag | undefined {
    if (!this.exists()) return undefined;
    // i18n-exempt: SQL, never shown to a person
    const row = this.db.prepare("SELECT * FROM project_tags WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** A project's tags, alphabetical. */
  of(projectId: string): ProjectTag[] {
    if (!this.exists()) return [];
    const rows = this.db
      // i18n-exempt: SQL, never shown to a person
      .prepare("SELECT * FROM project_tags WHERE project_id = ?")
      .all(projectId) as Row[];
    return rows.map(fromRow).sort(byTagName);
  }

  /** Every project's tags as its view carries them, by project id, with how many tasks carry each. */
  views(): Map<string, ProjectTagView[]> {
    const byProject = new Map<string, ProjectTagView[]>();
    if (!this.exists()) return byProject;
    const rows = this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `SELECT t.*, (SELECT COUNT(*) FROM task_tags x WHERE x.tag_id = t.id AND x.state = 'on') AS carried
         FROM project_tags t`,
      )
      .all() as (Row & { carried: number })[];
    for (const row of rows) {
      const list = byProject.get(row.project_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        description: row.description,
        revision: row.revision,
        tasks: row.carried,
      });
      byProject.set(row.project_id, list);
    }
    for (const list of byProject.values()) list.sort(byTagName);
    return byProject;
  }

  private refuseTaken(projectId: string, name: string, except?: string): void {
    const taken = this.of(projectId).find(
      (tag) => tag.id !== except && sameTagName(tag.name, name),
    );
    if (taken)
      throw new ProjectTagRefusal(
        // i18n-exempt: a refusal served to the first mate; Settings checks a tag in its own words first
        `This project already has a tag named ${taken.name}. Choose another name.`,
      );
  }

  add(projectId: string, name: string, description: string, now: number): ProjectTag {
    const trimmed = name.trim();
    this.refuseTaken(projectId, trimmed);
    const id = `tag-${randomUUID()}`;
    this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        `INSERT INTO project_tags (id, project_id, name, description, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, projectId, trimmed, description.trim(), now, now);
    return this.get(id) as ProjectTag;
  }

  /** A rename keeps the tag on its tasks; a new description raises its revision. */
  edit(
    tag: ProjectTag,
    change: { name?: string | undefined; description?: string | undefined },
    now: number,
  ): ProjectTag {
    const name = change.name?.trim() ?? tag.name;
    const description = change.description?.trim() ?? tag.description;
    if (name !== tag.name) this.refuseTaken(tag.projectId, name, tag.id);
    const described = description !== tag.description;
    this.db
      .prepare(
        // i18n-exempt: SQL, never shown to a person
        "UPDATE project_tags SET name = ?, description = ?, revision = revision + ?, updated_at = ? WHERE id = ?",
      )
      .run(name, description, described ? 1 : 0, now, tag.id);
    return this.get(tag.id) as ProjectTag;
  }

  /** The caller took it off every task first (`TaskService.clearTag`), in the same write. */
  remove(tagId: string): void {
    // i18n-exempt: SQL, never shown to a person
    this.db.prepare("DELETE FROM project_tags WHERE id = ?").run(tagId);
  }
}
