import { join } from "node:path";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  REVERSE_MIGRATION_64,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { RepoRegistry } from "../workspace/repoRegistry";
import { openDatabase, openInMemoryDatabase } from "./db";
import { dropViews } from "./views";

// The project migrations: scope, standing rigor, workspace kind, where a project lives and where
// its tasks run.

it("INF-1117: upgrades existing projects with empty scope, saves it across reopen and reverses without losing rows", () => {
  const dir = tmpUserData();
  const legacy = openDatabase(dir, 91);
  const columns = columnNames(legacy, "repos");
  legacy
    .prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, kind, delivery) VALUES ('scope-project', '/fleet/observatory', 'observatory', 1, 'init', 'project', 'local-only')",
    )
    .run();
  legacy.close();
  const upgraded = openDatabase(dir);
  const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
  expect(registry.get("scope-project")?.scope).toBeNull();
  const scope = "Tools and dashboards for our astronomy club.";
  registry.configure("scope-project", { scope });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(new RepoRegistry(reopened, join(dir, "fleet")).get("scope-project")?.scope).toBe(scope);
  dropViews(reopened);
  reopened.exec("ALTER TABLE repos DROP COLUMN scope");
  expect(columnNames(reopened, "repos")).toEqual(columns);
  expect(reopened.prepare("SELECT id, name FROM repos").all()).toEqual([
    { id: "scope-project", name: "observatory" },
  ]);
  reopened.close();
});

describe("migration 36 (the repository's standing rigor, delivery rigor phase 3)", () => {
  it("adds the rigor column and migration 44 backfills legacy projects to standard", () => {
    const dir = tmpUserData();
    const atThirtyFive = openDatabase(dir, 35);
    const repoColumnsAt35 = columnNames(atThirtyFive, "repos");
    expect(repoColumnsAt35).not.toContain("rigor");
    atThirtyFive
      .prepare(
        "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 1)",
      )
      .run("r-old", "/fleet/meterlab", "meterlab", 1, "https://example.com/meterlab.git");
    atThirtyFive.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "repos")).toContain("rigor");
    // Existing projects receive the explicit standard standing value.
    expect(
      upgraded.prepare("SELECT id, delivery, autonomy, rigor FROM repos WHERE id = 'r-old'").get(),
    ).toEqual({ id: "r-old", delivery: "direct-pr", autonomy: 1, rigor: "standard" });
    // The registry reads the column as the view's `rigor`.
    const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
    expect(registry.get("r-old")?.rigor).toBe("standard");
    expect(registry.configure("r-old", { rigor: "reviewed" }).rigor).toBe("reviewed");

    // Reversible: dropping every added column restores the v35 shape with
    // the row (migration 37 adds `kind` and migration 40 the host on top of
    // this one).
    // Migration 42's views read these columns: undoing the head undoes it first.
    dropViews(upgraded);
    upgraded.exec(REVERSE_MIGRATION_64);
    upgraded.exec("ALTER TABLE repos DROP COLUMN rigor;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_host;");
    expect(columnNames(upgraded, "repos")).toEqual(repoColumnsAt35);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 1 });
    upgraded.close();
  });
});

describe("migration 37 (the workspace kind, crew-posture rationalization Task A)", () => {
  it("adds the kind column, maps a live repo to the personal kind on local-only, and reverses", () => {
    const dir = tmpUserData();
    const atThirtySix = openDatabase(dir, 36);
    const repoColumnsAt36 = columnNames(atThirtySix, "repos");
    expect(repoColumnsAt36).not.toContain("kind");
    const insert = atThirtySix.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("r-personal", "/data/fleet/personal", "personal", 1, "init", null, "live", 1);
    insert.run("r-project", "/fleet/meterlab", "meterlab", 2, "clone", null, "direct-pr", 0);
    insert.run("r-local", "/fleet/notes", "notes", 3, "init", null, "local-only", 0);
    atThirtySix.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "repos")).toContain("kind");
    // The one live row becomes the personal KIND; its delivery drops to the
    // local-only nobody reads, because delivery now says only where a
    // change lands and this workspace lands none.
    expect(
      upgraded.prepare("SELECT id, kind, delivery FROM repos ORDER BY added_at").all(),
    ).toEqual([
      { id: "r-personal", kind: "personal", delivery: "local-only" },
      { id: "r-project", kind: "project", delivery: "direct-pr" },
      { id: "r-local", kind: "project", delivery: "local-only" },
    ]);
    // The registry reads it as the view's `kind` and refuses the personal
    // row's whole policy patch.
    const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
    expect(registry.get("r-personal")?.kind).toBe("personal");
    expect(registry.get("r-project")?.kind).toBe("project");
    expect(() => registry.configure("r-personal", { autonomy: false })).toThrow(/builds in place/);
    expect(registry.configure("r-project", { delivery: "local-only" }).delivery).toBe("local-only");

    // Reversible: dropping the column restores the v36 shape with the rows
    // (migration 40 adds the host on top of this one, and migration 42's
    // views read the column, so undoing the head undoes them first).
    dropViews(upgraded);
    upgraded.exec(REVERSE_MIGRATION_64);
    upgraded.exec("ALTER TABLE repos DROP COLUMN kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_kind;");
    upgraded.exec("ALTER TABLE repos DROP COLUMN forge_host;");
    expect(columnNames(upgraded, "repos")).toEqual(repoColumnsAt36);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 3 });
    upgraded.close();
  });
});

describe("migration 40 (where each project lives, git integration PR 1.1)", () => {
  it("stamps every repo's host from its origin, logs each value, reads it on the view, and reverses", () => {
    const dir = tmpUserData();
    const atThirtyNine = openDatabase(dir, 39);
    const repoColumnsAt39 = columnNames(atThirtyNine, "repos");
    expect(repoColumnsAt39).not.toContain("forge_kind");
    const insert = atThirtyNine.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    );
    insert.run(
      "r-gh",
      "/fleet/meter",
      "meter",
      1,
      "clone",
      "git@github.com:o/meter.git",
      "direct-pr",
    );
    insert.run(
      "r-host",
      "/fleet/wiki",
      "wiki",
      2,
      "clone",
      "https://git.example.com/me/wiki.git",
      "direct-pr",
    );
    insert.run("r-local", "/fleet/notes", "notes", 3, "init", null, "local-only");
    atThirtyNine.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(
      upgraded.prepare("SELECT id, forge_kind, forge_host FROM repos ORDER BY added_at").all(),
    ).toEqual([
      { id: "r-gh", forge_kind: "github", forge_host: "github.com" },
      { id: "r-host", forge_kind: "git", forge_host: "git.example.com" },
      { id: "r-local", forge_kind: "none", forge_host: null },
    ]);
    // Every backfilled value is logged beside the origin it came from.
    expect(
      upgraded
        .prepare("SELECT repo_id, origin, forge_kind FROM forge_backfill ORDER BY repo_id")
        .all(),
    ).toEqual([
      { repo_id: "r-gh", origin: "git@github.com:o/meter.git", forge_kind: "github" },
      { repo_id: "r-host", origin: "https://git.example.com/me/wiki.git", forge_kind: "git" },
      { repo_id: "r-local", origin: null, forge_kind: "none" },
    ]);
    // The registry reads it as the view's `host`: null for a project kept on this Mac.
    const registry = new RepoRegistry(upgraded, join(dir, "fleet"));
    expect(registry.get("r-gh")?.host).toEqual({ kind: "github", name: "github.com" });
    expect(registry.get("r-host")?.host).toEqual({ kind: "git", name: "git.example.com" });
    expect(registry.get("r-local")?.host).toBeNull();

    // Reversible: dropping the two columns and the log restores the v39 shape.
    upgraded.exec(
      `${REVERSE_MIGRATION_64}ALTER TABLE repos DROP COLUMN forge_kind; ALTER TABLE repos DROP COLUMN forge_host; DROP TABLE forge_backfill;`,
    );
    expect(columnNames(upgraded, "repos")).toEqual(repoColumnsAt39);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 3 });
    upgraded.close();
  });

  it("reads a row written without the columns from its origin, the way the stamp would", () => {
    const db = openInMemoryDatabase();
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES ('r1', '/r', 'r', 1, 'clone', 'https://github.com/o/r.git', 'direct-pr', 0)",
    ).run();
    expect(new RepoRegistry(db, "/fleet").get("r1")?.host).toEqual({
      kind: "github",
      name: "github.com",
    });
  });
});

describe("migration 64 (where a project's tasks run, multi-machine piece 11)", () => {
  it("adds the nullable column, migrates eligible projects to Automatic, records a computer, and reverses", () => {
    const dir = tmpUserData();
    const at63 = openDatabase(dir, 63);
    const columnsAt63 = columnNames(at63, "repos");
    expect(columnsAt63).not.toContain("runs_on");
    at63
      .prepare(
        "INSERT INTO repos (id, path, name, setup_kind, origin, delivery, autonomy, added_at) VALUES ('r1', '/w/website', 'website', 'clone', 'https://github.com/o/website.git', 'direct-pr', 0, 1)",
      )
      .run();
    at63.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // Migration 84 moves an eligible project's original home default to Automatic.
    expect(upgraded.prepare("SELECT runs_on FROM repos WHERE id = 'r1'").get()).toEqual({
      runs_on: AUTOMATIC_COMPUTER,
    });
    upgraded.prepare("UPDATE repos SET runs_on = 'mini' WHERE id = 'r1'").run();
    upgraded.close();

    const reopened = openDatabase(dir);
    expect(reopened.prepare("SELECT runs_on FROM repos WHERE id = 'r1'").get()).toEqual({
      runs_on: "mini",
    });
    // Reversible: dropping the column restores the v63 shape with every row.
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_64);
    expect(columnNames(reopened, "repos")).toEqual(columnsAt63);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
