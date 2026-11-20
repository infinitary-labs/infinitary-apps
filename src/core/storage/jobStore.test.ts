import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "./db";
import { JobStore } from "./jobStore";

describe("JobStore", () => {
  it("reports the jobs a quit interrupted once, and forgets the ones that exited", () => {
    const db = openInMemoryDatabase();
    const before = new JobStore(db);
    before.add({ id: "j1", ownerId: "t1", command: "pnpm test", startedAt: 1 });
    before.add({ id: "j2", ownerId: "t2", command: "sleep 600", startedAt: 2 });
    before.add({ id: "j3", ownerId: "t1", command: "pnpm build", startedAt: 3 });
    before.remove("j2");

    // The next process reads what the quit left.
    const after = new JobStore(db);
    const interrupted = after.takeInterrupted().map((job) => job.command);
    expect(interrupted.sort()).toEqual(["pnpm build", "pnpm test"]);
    expect(after.takeInterrupted()).toEqual([]);
  });
});
