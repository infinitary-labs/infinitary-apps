/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/workspace/
 */
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { hostEnv } from "../../src/core/hostEnv";
import type { AppDatabase } from "../../src/core/storage/db";
import { ensureRepoProject } from "../../src/core/storage/projectStore";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { forgeOf } from "../../src/shared/forge";
import { AUTOMATIC_COMPUTER } from "../../src/shared/placement";
import type { RepoDelivery, RepoKind, RepoSetupKind, RepoView } from "../../src/shared/repos";
import type { Rigor } from "../../src/shared/rigor";

/** A project a journey starts with, at a fixed id its tasks can name. */
export type ProjectSeed = {
  id: string;
  name: string;
  /** The project's real working folder. */
  path: string;
  setupKind: RepoSetupKind;
  /** Where the project lives; absent or null for one kept on this computer. */
  origin?: string | null;
  delivery: RepoDelivery;
  kind?: RepoKind;
  /** The registry's default when absent: off. */
  autonomy?: boolean;
  /** The registry's default when absent: standard. */
  rigor?: Rigor | null;
  /**
   * The registry's stamp when absent: Automatic for a hosted project, else
   * this computer. A journey whose tasks start on this computer passes null,
   * the row a person's "This computer" choice saves (`RepoRegistry.setRunsOn`);
   * Automatic adds a comparison of computers before a start.
   */
  runsOn?: string | null;
  /** When it was added; the list orders by it. Now when absent. */
  addedAt?: number;
  /** The project's task key; derived from the name when absent, as the registry derives it. */
  key?: string;
};

/**
 * Save a project row the way `RepoRegistry` saves one when a person adds a
 * project (INF-2417's "project row by raw SQL" repair): the same columns,
 * where it lives stamped from its address, Runs on stamped for a hosted
 * project, and its task project born with it. The registry draws a random
 * id and clones or links a folder, so a journey whose tasks name a fixed
 * project id seeds it here instead; `projectSeed.test.ts` holds this row
 * equal to the registry's own for the same project. Read back through the
 * registry.
 */
export function seedProject(db: AppDatabase, seed: ProjectSeed): RepoView {
  const origin = seed.origin ?? null;
  const kind = seed.kind ?? "project";
  const where = forgeOf(origin);
  const addedAt = seed.addedAt ?? Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO repos (id, path, name, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, added_at, runs_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.path,
      seed.name,
      seed.setupKind,
      kind,
      origin,
      where.kind,
      where.host,
      seed.delivery,
      seed.autonomy ? 1 : 0,
      seed.rigor === undefined ? "standard" : seed.rigor,
      addedAt,
      seed.runsOn === undefined
        ? origin && kind !== "personal"
          ? AUTOMATIC_COMPUTER
          : null
        : seed.runsOn,
    );
    ensureRepoProject(db, { id: seed.id, name: seed.name }, addedAt, seed.key);
  })();
  return new RepoRegistry(db, seed.path).get(seed.id) as RepoView;
}

/**
 * Complete a seeded hosted project: its saved address also exists in its
 * scratch git folder, and the folder knows origin's default branch the way a
 * clone does. Without that, every merge's folder refresh is refused and
 * files a "Bring the folder up to date" task the journey never asked for
 * (INF-549, docs/task-record.md "A folder a merge left behind").
 */
export function seedHostedOrigins(db: AppDatabase, userDataDir: string): void {
  const rows = db.prepare("SELECT path, origin FROM repos WHERE origin IS NOT NULL").all() as {
    path: string;
    origin: string;
  }[];
  for (const row of rows) {
    const inside = relative(resolve(userDataDir), resolve(row.path));
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`))
      throw new Error("A hosted project fixture must own a folder inside its scratch data.");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", row.path, ...args], { env: hostEnv(), stdio: "pipe" })
        .toString()
        .trim();
    if (!git("remote").split("\n").includes("origin")) {
      git("remote", "add", "origin", row.origin);
      // Dispatch fetches the real default branch through a scratch-local mirror.
      git("config", `url.${row.path}.insteadOf`, row.origin);
      // The mirror is the folder itself, so its default branch is the one checked out.
      git("fetch", "--quiet", "origin");
      git("remote", "set-head", "origin", "--auto");
    } else if (git("config", "--get", "remote.origin.url") !== row.origin)
      throw new Error("The hosted project fixture's saved address and git address disagree.");
  }
}
