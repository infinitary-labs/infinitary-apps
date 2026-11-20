import { join } from "node:path";
import { openDatabase } from "../../../src/core/storage/db";
import { ProjectStore } from "../../../src/core/storage/projectStore";
import { seedProject } from "../../../src/core/workspace/seedProject";
import type { HomeRead } from "../browserFreshHome";

/** What the projects-tab-added-focus test's story reads back. */
type Input = { project: { name: string; key: string }; added: string };

/** The window sends no read with arguments for this home. */
export const asked: HomeRead[] = [];

/**
 * A project kept on this computer once a second repository joined it: its
 * first repository, started with the project's task key, then `added`, a new
 * repository started inside the project, as Settings -> Projects' Add a
 * repository row saves it. The test reads the project as it was before
 * `added` joined from this reading, without `added`.
 */
export default function seed(userDataDir: string, { project, added }: Input): void {
  const db = openDatabase(userDataDir);
  try {
    const addedAt = Date.now();
    seedProject(db, {
      id: `repo-${project.name}`,
      name: project.name,
      path: join(userDataDir, project.name),
      setupKind: "init",
      runsOn: null,
      addedAt,
      key: project.key,
    });
    const joined = new ProjectStore(db).byKey(project.key);
    if (!joined) throw new Error(`The seed made no project with the key ${project.key}`);
    seedProject(db, {
      id: `repo-${added}`,
      name: added,
      path: join(userDataDir, added),
      setupKind: "init",
      runsOn: null,
      addedAt: addedAt + 1,
      project: joined.id,
    });
  } finally {
    db.close();
  }
}
