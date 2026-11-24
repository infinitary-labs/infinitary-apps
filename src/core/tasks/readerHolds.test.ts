import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

// The approved reader plan's rule 1A rests on this record: the first time an
// unsafe data reader holds something of the captain's, the host notes when
// and what, and that first note stands.
describe("an unsafe data reader's record of holding something of the captain's", () => {
  it("keeps the first mark across a reopen, and a later mark changes nothing", () => {
    let now = 50_000;
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => now });
    seedTask(tasks, { id: "r1", title: "Read the open issues", status: "running" });
    expect(tasks.get("r1")?.delivery?.readerHolds).toBeUndefined();

    now = 70_000;
    tasks.delivery.markReaderHolds("r1", "Mail");
    now = 80_000;
    tasks.delivery.markReaderHolds("r1", "Notes");

    expect(tasks.get("r1")?.delivery?.readerHolds).toEqual({ at: 70_000, what: "Mail" });
    const reopened = new TaskService({ db, strict: true, now: () => 90_000 });
    expect(reopened.get("r1")?.delivery?.readerHolds).toEqual({ at: 70_000, what: "Mail" });
  });
});
