import type { RepoDelivery, RepoKind, RepoSetupKind, RepoView } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import type { AppDatabase } from "../storage/db";
import { saveNewRepo } from "./repoRegistry";

/**
 * Test and script fixture seeding, the project row's twin of `seedTask`: a
 * project at a fixed id its tasks can name, saved through the registry's
 * one row writer (`saveNewRepo`) so a fixture's row has every column the
 * registry stamps when a person adds the same project. It never runs git
 * and never makes a folder: `path` is only what the row says. Never used by
 * the product.
 */

/** A project a fixture starts with, at a fixed id its tasks can name. */
export type ProjectSeed = {
  id: string;
  name: string;
  /** The project's working folder as the row names it; nothing is made there. */
  path: string;
  /** How a person added it; clone when absent. */
  setupKind?: RepoSetupKind;
  /** Where the project lives; absent or null for one kept on this computer. */
  origin?: string | null;
  /** Local-only when absent. */
  delivery?: RepoDelivery;
  kind?: RepoKind;
  /** The registry's default when absent: off. */
  autonomy?: boolean;
  /** The registry's default when absent: standard. */
  rigor?: Rigor | null;
  /**
   * The registry's stamp when absent: Automatic for a hosted project, else
   * this computer. A fixture whose tasks start on this computer passes null,
   * the row a person's "This computer" choice saves (`RepoRegistry.setRunsOn`).
   */
  runsOn?: string | null;
  /** When it was added; the list orders by it. Now when absent. */
  addedAt?: number;
  /** The project's task key; derived from the name when absent, as the registry derives it. */
  key?: string;
  /** An existing project it joins, by id, instead of one of its own (INF-4220); never with `key`. */
  project?: string;
};

export function seedProject(db: AppDatabase, seed: ProjectSeed): RepoView {
  return saveNewRepo(db, {
    id: seed.id,
    name: seed.name,
    path: seed.path,
    setupKind: seed.setupKind ?? "clone",
    kind: seed.kind,
    origin: seed.origin ?? null,
    delivery: seed.delivery ?? "local-only",
    autonomy: seed.autonomy,
    rigor: seed.rigor,
    runsOn: seed.runsOn,
    addedAt: seed.addedAt,
    projectKey: seed.key,
    project: seed.project,
  });
}
