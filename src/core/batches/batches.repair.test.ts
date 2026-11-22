import type { BatchChange } from "@shared/batches";
import { describe, expect, it } from "vitest";
import { failed, passed, REPO, setup } from "../../../tests/helpers/batchesHarness";
import { BATCH_WORDS } from "./batches";

// Intent: the captain's ask that the Batches panel show a held batch's actual state
// without implying the captain must answer it: the task the first mate starts to repair
// the hold is recorded, and only while a batch is held. The project and its host are
// `batchesHarness.ts`.

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

describe("a held batch's repair", () => {
  it("records the task started to repair the hold, and refuses one while no batch is held", async () => {
    const home = setup();
    home.approve(PARSER);
    home.approve(EXPORT);
    await home.pass();
    expect(await home.batches.markRepair(REPO, "t-repair")).toBe(BATCH_WORDS.noRepairHeld);
    expect(home.open().repair).toBeUndefined();

    home.host.report([passed("build"), failed("unit-tests")]);
    await home.pass();
    expect(await home.batches.markRepair(REPO, "t-repair")).toBeUndefined();
    expect(home.open().repair).toBe("t-repair");
    // The hold itself is unchanged: recording its repair answers nothing.
    expect(home.open().hold).toMatchObject({ reason: "checks", checks: ["unit-tests"] });
  });
});
