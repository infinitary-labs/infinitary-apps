import { expect, it } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { RepoRegistry } from "./repoRegistry";
import { seedProject } from "./seedProject";

// INF-2186: placement, policy and move facts read the same project's row for every task.
it("shares project facts for one read and refreshes them after a placement change", () => {
  const db = freshDatabase();
  seedProject(db, {
    id: "nimbus",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    origin: "https://github.com/example/nimbus-api",
    delivery: "direct-pr",
    autonomy: true,
    addedAt: 1,
  });
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
