import { describe, expect, it } from "vitest";
import type { WorkShape } from "../../shared/routingPolicy";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { DATABASE_VERSION, openInMemoryDatabase } from "./db";
import { migrateOngoingWork } from "./migrateOngoingWork";

// Intent: INF-1177 piece 2 preserves existing subjects while replacing teach with declared facts.
describe("ongoing work compatibility", () => {
  it("preserves a saved subject and unrelated work through the upgrade", () => {
    const db = openInMemoryDatabase(DATABASE_VERSION - 1);
    try {
      const before = new TaskService({ db });
      seedTask(before, {
        id: "subject",
        status: "idle",
        title: "Teach chess",
        shape: { kind: "teach", deliverable: "change" } as unknown as WorkShape,
      });
      seedTask(before, {
        id: "panel",
        status: "idle",
        title: "Tokyo clock",
        shape: { kind: "implement" },
      });
      migrateOngoingWork(db);
      const after = new TaskService({ db });
      expect(after.get("subject")?.shape).toMatchObject({
        kind: "unclear",
        ongoing: true,
        intelligence: "high",
        deliverable: "change",
      });
      expect(after.get("panel")?.shape).toEqual({ kind: "implement" });
      migrateOngoingWork(db);
      expect(after.get("subject")?.shape?.ongoing).toBe(true);
    } finally {
      db.close();
    }
  });
});
