import { expect, it } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { RepoRegistry } from "./repoRegistry";

// INF-2186: placement, policy and move facts read the same project's row for every task.
it("shares project facts for one read and refreshes them after a placement change", () => {
  const db = freshDatabase();
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 1)",
  ).run("nimbus", "/fleet/nimbus-api", "nimbus-api", 1, "https://github.com/example/nimbus-api");
  const repos = new RepoRegistry(db, "/fleet");
  try {
    repos.readProjection(() => {
      const reads = rowsRead(db, () => {
        for (let row = 0; row < 40; row += 1) expect(repos.get("nimbus")?.name).toBe("nimbus-api");
      });
      expect(reads).toBe(1);
      const moved = repos.setRunsOn("nimbus", "work-computer");
      expect(moved.runsOn).toBe("work-computer");
      expect(repos.get("nimbus")).toBe(moved);
    });
    repos.setRunsOn("nimbus", null);
    repos.readProjection(() => expect(repos.get("nimbus")?.runsOn).toBeNull());
  } finally {
    db.close();
  }
});
