import type { BatchChange } from "@shared/batches";
import { describe, expect, it } from "vitest";
import { failed, passed, running, setup } from "../../../tests/helpers/batchesHarness";

// The project and its host are `batchesHarness.ts`.

const PARSER: BatchChange = {
  taskId: "t-parser",
  branch: "fm/task-parser",
  head: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
  title: "fix(parser): read dates with a time zone",
  body: "- Dates with a time zone are read as written.",
  at: 1_000,
};
const EXPORT: BatchChange = {
  taskId: "t-export",
  branch: "fm/task-export",
  head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  title: "feat(export): add a CSV export",
  body: "- A report exports as CSV.",
  at: 2_000,
};

/** Two approved changes combined and opened as pull request #31. */
async function batchOfTwo() {
  const home = setup();
  home.approve(PARSER);
  home.approve(EXPORT);
  await home.pass();
  return home;
}

// Intent: the captain's pick in the daily velocity review, "Have each batch regenerate the
// phone's generated files itself, as its own commit, before its checks run ... every check
// still runs on it": a commit of generated files the project's checks pushed on the batch
// stands as its version once the app pushes it again, its checks decide the batch, and it
// merges with a receipt for each change; any other commit on the branch is combined over.
describe("a commit of generated files the project's checks pushed on the batch", () => {
  const GENERATED = "chore(phone): regenerate the phone's generated files in the batch";
  const BRANCH = "infinitary-batch/3fa9c1d2";

  /** The checks push one commit on `parent`, which git reads as generated files on it. */
  function checksPush(home: Awaited<ReturnType<typeof batchOfTwo>>, parent: string): string {
    const pushed = `9e${parent.slice(2)}`;
    home.host.branches.set(BRANCH, pushed);
    home.host.generated.set(pushed, { parent, title: GENERATED });
    return pushed;
  }

  it("stands as the batch's version, its own checks decide the batch, and it merges with a receipt for each change", async () => {
    const home = await batchOfTwo();
    const combined = home.open().head;
    // The checks on the combined version still run, waiting for the app to take the commit.
    home.host.checks.set(combined, [running("Merge batch · Push the regenerated phone files")]);
    const pushed = checksPush(home, combined);

    await home.pass();

    const written = home.open().head;
    expect(written).not.toBe(combined);
    expect(written).not.toBe(pushed);
    expect(home.open()).toMatchObject({ generated: written, number: 31 });
    expect(home.members()).toEqual(["t-parser", "t-export"]);
    expect(home.heard.pushes.at(-1)).toEqual({ branch: BRANCH, head: written, expected: pushed });
    expect(home.open().hold).toBeUndefined();
    expect(home.heard.held).toEqual([]);

    // Its checks run: while they run nothing merges, and once they pass it merges.
    home.host.report([running("unit-tests")]);
    home.host.ready("clean");
    await home.pass();
    expect(home.host.merges).toEqual([]);
    home.host.report([passed("unit-tests")]);
    await home.pass();

    expect(home.host.merges).toEqual([
      expect.objectContaining({ number: 31, head: written, way: "rebase" }),
    ]);
    expect(home.host.main.map((commit) => commit.title)).toEqual([
      PARSER.title,
      EXPORT.title,
      GENERATED,
    ]);
    expect(home.place(PARSER)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[0]?.sha },
    });
    expect(home.place(EXPORT)).toMatchObject({
      state: "merged",
      receipt: { sha: home.host.main[1]?.sha },
    });
  });

  it("holds on the generated version's own failed checks, as on any version", async () => {
    const home = await batchOfTwo();
    checksPush(home, home.open().head);
    await home.pass();
    const written = home.open().head;

    home.host.report([failed("unit-tests")]);
    await home.pass();

    expect(home.open().hold).toMatchObject({
      head: written,
      reason: "checks",
      checks: ["unit-tests"],
    });
    expect(home.host.merges).toEqual([]);
  });

  it("combines over a commit that does not build on the batch's version, and takes only one generated commit per combine", async () => {
    const home = await batchOfTwo();
    const combined = home.open().head;
    checksPush(home, "1d0e2f3a4b5c6d7e8f9012345678901234567890");
    await home.pass();
    const again = home.open().head;
    expect(again).not.toBe(combined);
    expect(home.open().generated).toBeUndefined();
    expect(home.members()).toEqual(["t-parser", "t-export"]);

    checksPush(home, again);
    await home.pass();
    const written = home.open().head;
    expect(home.open().generated).toBe(written);

    // A second generated commit on top of the first is not taken: the batch is combined again.
    checksPush(home, written);
    await home.pass();
    expect(home.open().head).not.toBe(written);
    expect(home.open().generated).toBeUndefined();
  });
});
