import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { lintWriters } from "./lint/e2eWriters";

/**
 * One writer once the app runs (docs/e2e-contracts.md): a spec seeds the
 * saved data before it launches the app, and reads it afterwards without
 * opening the stores the core writes through.
 */

function lint(source: string): number[] {
  const dir = join(scratchDir("infinitary-e2e-writers-lint-"), "tests/e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "journey.spec.ts");
  writeFileSync(file, source);
  return lintWriters([file]).map((diagnostic) => diagnostic.line);
}

const seedThenLaunch = `
test("seeds, launches, reads", async () => {
  const db = openDatabase(dir);
  const tasks = new TaskService({ db });
  seedTask(tasks, {});
  const app = await launchApp({ userDataDir: dir });
  await expect.poll(() => tasks.get("a")?.status).toBe("idle");
  await app.close();
});
`;

describe("the e2e one-writer lint", () => {
  it("keeps seeding before the launch and reading through a store built before it", () => {
    expect(lint(seedThenLaunch)).toEqual([]);
  });

  it("refuses a service built per poll, which runs boot recovery against the live app", () => {
    const poll = `
test("observer", async () => {
  const db = openDatabase(dir);
  const read = () => new TaskService({ db });
  const app = await launchApp({ userDataDir: dir });
  await expect.poll(() => read().get("a")?.status).toBe("idle");
});
`;
    expect(lint(poll)).toEqual([4, 6]);
  });

  it("refuses a writer opened after the launch, and one in a poll's callback", () => {
    const after = `
test("late", async () => {
  const app = await launchApp({});
  const db = openDatabase(app.userDataDir);
  await expect.poll(() => new CardStore(db).forTask("a")).toEqual([]);
});
`;
    expect(lint(after)).toEqual([4, 5]);
  });

  it("refuses a same-file helper that opens a writer when it is called after the launch", () => {
    const helper = `
function ledger(dir) { return new TaskService({ db: openDatabase(dir) }).get("a"); }
test("helper", async () => {
  ledger(dir);
  const app = await launchApp({});
  ledger(dir);
});
`;
    expect(lint(helper)).toEqual([6]);
  });

  it("allows seeding while the app is stopped, and a launch argument built before it starts", () => {
    const restart = `
test("between runs", async () => {
  const first = await launchApp({ userDataDir: seeded() });
  await first.close();
  const db = openDatabase(dir);
  new TaskService({ db }).setActivity("a", "running");
  db.close();
  const second = await launchApp({ userDataDir: dir });
});
`;
    expect(lint(restart)).toEqual([]);
  });

  it("lets a journey about someone else's write say so, with a reason", () => {
    const waived = `
test("aged ledger", async () => {
  const db = openDatabase(dir);
  const app = await launchApp({});
  // e2e-writer-ok: the journey ages a reading the way a minute of waiting would
  new TaskService({ db }).recordDelivery("a", {});
  new TaskService({ db }).recordDelivery("b", {});
});
`;
    expect(lint(waived)).toEqual([7]);
  });
});
