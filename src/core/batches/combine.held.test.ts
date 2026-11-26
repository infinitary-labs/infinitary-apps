import {
  type BatchChange,
  type BatchMember,
  type BatchRecord,
  EMPTY_BATCH_RECORD,
} from "@shared/batches";
import { describe, expect, it, vi } from "vitest";
import {
  AT,
  change,
  type Host,
  host,
  PARSER,
  run,
  write,
} from "../../../tests/helpers/combineHost";
import { combine, LEFT_OUT_WORDS, pushBatch } from "./combine";
import { carried, combined, declared, enqueue, heldVersions, release, withdraw } from "./line";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Integration budget (docs/test-cohorts.md): real git against a bare host, the slowest
// test took 1.64 s on the Mac at its fastest of five runs, five times that rounded up.
vi.setConfig({ testTimeout: 10_000 });

describe("a held batch's fix built on the version that held", () => {
  // Intent: the captain's approved plan to stop changes bouncing between batches, piece 3:
  // a declared fix can change lines a batch member added or changed, so a repair fixes a
  // collision forward instead of sending a correct change back. The collision is the one a
  // repair met: one change adds a column, another adds the generated page that lists the
  // columns, and the page is stale once both are combined.
  const COLUMN = {
    taskId: "task-column",
    title: "feat(report): add a time zone column",
    files: { "src/report.ts": "export const rows = ['date', 'total', 'zone'];\n" },
    approvedAt: 1_000,
  };
  const PAGE = {
    taskId: "task-page",
    title: "docs(report): generate the report's column page",
    files: { "docs/report.md": "| date | total |\n" },
    approvedAt: 2_000,
  };
  const BATCH = "infinitary-batch/5e1d";

  /** The two changes combined and pushed as a batch, as it holds: answers its version. */
  async function heldBatch(
    at: Host,
  ): Promise<{ column: BatchChange; page: BatchChange; held: string; record: BatchRecord }> {
    const column = change(at, COLUMN);
    const page = change(at, PAGE);
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, page],
      at: AT,
    });
    await pushBatch({ repoDir: at.home, branch: BATCH, head: result.head, expected: null });
    // The record as a batch saved before it kept the versions that held: its hold alone names it.
    const record: BatchRecord = {
      ...EMPTY_BATCH_RECORD,
      open: {
        branch: BATCH,
        head: result.head,
        base: result.base,
        members: result.members,
        since: AT,
        hold: { at: AT, head: result.head, reason: "checks", checks: ["unit-tests"] },
      },
    };
    return { column, page, held: result.head, record };
  }

  /** The default branch moves where the project lives, so the next combine re-makes every commit. */
  function mainMoves(at: Host): void {
    run(at.work, "fetch", "--quiet", "origin");
    run(at.work, "checkout", "--quiet", "-B", "main", "origin/main");
    write(at.work, "README.md", "# Meter\n");
    run(at.work, "add", "-A");
    run(at.work, "commit", "-m", "docs: add a readme");
    run(at.work, "push", "origin", "HEAD:refs/heads/main");
  }

  it("joins with only its own difference when it rewrites a file a member added", async () => {
    const at = host();
    const { column, page, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(docs): list the time zone column",
        files: { "docs/report.md": "| date | total | zone |\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    mainMoves(at);

    // Merged the ordinary way, the fix meets the re-made page as new work and clashes.
    const ordinary = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, page, fix],
      at: AT + 60_000,
    });
    expect(ordinary.leftOut.map((entry) => entry.change.taskId)).toEqual(["task-fix"]);

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, page, fix],
      at: AT + 60_000,
      held: [held],
    });

    expect(result.leftOut).toEqual([]);
    expect(result.members.map((member) => member.taskId)).toEqual([
      "task-column",
      "task-page",
      "task-fix",
    ]);
    const [, second, third] = result.members.map((member) => member.commit) as [
      string,
      string,
      string,
    ];
    expect(run(at.home, "rev-list", "--parents", "-n", "1", third)).toBe(`${third} ${second}`);
    expect(run(at.home, "diff", second, third)).toContain("+| date | total | zone |");
    expect(run(at.home, "diff", "--name-only", second, third)).toBe("docs/report.md");
    expect(run(at.home, "show", `${result.head}:docs/report.md`)).toBe("| date | total | zone |");
    expect(run(at.home, "show", `${result.head}:README.md`)).toBe("# Meter");
  });

  it("carries no work of a change sent back beside it, and changes a member's own line", async () => {
    const at = host();
    const { column, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };

    // The page went back; the column and the fix combine once.
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, fix],
      at: AT + 60_000,
      held: [held],
    });

    expect(result.leftOut).toEqual([]);
    expect(result.members.map((member) => member.taskId)).toEqual(["task-column", "task-fix"]);
    expect(run(at.home, "show", `${result.head}:src/report.ts`)).toBe(
      "export const rows = ['date', 'total', 'time_zone'];",
    );
    expect(run(at.home, "ls-tree", "-r", "--name-only", result.head)).not.toContain(
      "docs/report.md",
    );
  });

  it("is left out with its reason when its difference touches what a change sent back wrote", async () => {
    const at = host();
    const { column, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(docs): list the time zone column",
        files: { "docs/report.md": "| date | total | zone |\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, fix],
      at: AT + 60_000,
      held: [held],
    });

    expect(result.members.map((member) => member.taskId)).toEqual(["task-column"]);
    // The version it was verified on goes with it, left out as it is (`fixBases`).
    expect(result.leftOut).toEqual([
      { change: { ...fix, heldBase: held }, reason: LEFT_OUT_WORDS.fixClash(held) },
    ]);
  });

  it("keeps the version it was verified on, so a combine that no longer knows it carries the fix the same way", async () => {
    const at = host();
    const { column, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    // The page went back, and the fix joined the rest.
    const first = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, fix],
      at: AT + 60_000,
      held: [held],
    });
    const joined = first.members.find((member) => member.taskId === "task-fix");
    expect(joined?.heldBase).toBe(held);

    // The batch closed where the project lives and its changes went back in line.
    const { commit: _commit, ...requeued } = joined as BatchMember;
    mainMoves(at);
    const again = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, requeued],
      at: AT + 120_000,
    });
    expect(again.leftOut).toEqual([]);
    expect(run(at.home, "ls-tree", "-r", "--name-only", again.head)).not.toContain(
      "docs/report.md",
    );
    expect(run(at.home, "show", `${again.head}:src/report.ts`)).toBe(
      "export const rows = ['date', 'total', 'time_zone'];",
    );

    // A branch moved off that version is left out, never carried whole.
    const moved = change(at, {
      taskId: "task-fix",
      title: "fix(report): name the column as the export does",
      files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
      approvedAt: 3_000,
    });
    const lost = { ...moved, fix: true as const, heldBase: held };
    const refused = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, lost],
      at: AT + 180_000,
    });
    expect(refused.leftOut).toEqual([{ change: lost, reason: LEFT_OUT_WORDS.fixBaseLost(held) }]);
  });

  // Intent: the same piece, the independent review's second finding, a bug being fixed: a
  // new version of a fix that had joined was carried whole, with the members' work.
  it("carries a new version of a joined fix, approved in its place, from the same held version", async () => {
    const at = host();
    const { column, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    // The page went back beside the fix, and the fix joined the rest.
    await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, fix],
      at: AT + 60_000,
      held: [held],
    });

    // The repair pushes a new version on its own branch: in line, it carries no verified base.
    const replaced: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'tz'];\n" },
        from: fix.head,
        approvedAt: 4_000,
      }),
      fix: true,
    };
    mainMoves(at);
    const again = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, replaced],
      at: AT + 120_000,
      held: [held],
    });

    expect(again.leftOut).toEqual([]);
    expect(again.members.find((member) => member.taskId === "task-fix")?.heldBase).toBe(held);
    expect(run(at.home, "show", `${again.head}:src/report.ts`)).toBe(
      "export const rows = ['date', 'total', 'tz'];",
    );
    expect(run(at.home, "ls-tree", "-r", "--name-only", again.head)).not.toContain(
      "docs/report.md",
    );
  });

  // Intent: Try again must not clear the hold while leaving the branch at the failed
  // version. Keep the real Git clock input in the same second, even on a second retry.
  it("pushes a new version on each same-second retry without changing the approved work", async () => {
    const at = host();
    const { held, record } = await heldBatch(at);
    const excludeHeads = [held];
    const input = {
      repoDir: at.home,
      defaultBranch: "main",
      changes: carried(release(record), "line"),
      at: AT + 1,
      excludeHeads,
    };
    let expected = held;
    const commits = (head: string) =>
      run(at.home, "log", "--format=%T%n%an%n%ae%n%at%n%B", `main..${head}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await combine(input);
      await pushBatch({ repoDir: at.home, branch: BATCH, head: result.head, expected });
      const pushed = run(at.bare, "rev-parse", `refs/heads/${BATCH}`);
      expect(pushed).toBe(result.head);
      expect(excludeHeads).not.toContain(pushed);
      expect(result.base).toBe(record.open?.base);
      expect(result.members).toEqual(
        record.open?.members.map((member, index, members) => ({
          ...member,
          commit: index === members.length - 1 ? pushed : member.commit,
        })),
      );
      expect(commits(pushed)).toBe(commits(held));
      expected = pushed;
      excludeHeads.push(pushed);
    }
  });

  /** The batch record's own combine, as the app runs it, over real git. */
  async function recombined(at: Host, record: BatchRecord, when: number): Promise<BatchRecord> {
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: carried(record, "line"),
      at: when,
      held: heldVersions(record),
    });
    return {
      ...combined(release(record), result, { branch: BATCH, at: when }),
      leftOut: result.leftOut.map((entry) => ({
        taskId: entry.change.taskId,
        head: entry.change.head,
        reason: entry.reason,
        at: when,
      })),
    };
  }

  // Intent: the same piece, the independent review's third finding, a bug being fixed: a
  // hold saved before the record kept its versions was the fix's only base, and Try again
  // released it before the fix was approved, so the fix was carried whole.
  it("carries a fix declared on a saved hold from its version after Try again released it", async () => {
    const at = host();
    const { page, held, record: saved } = await heldBatch(at);
    let record = declared(withdraw(saved, page.taskId), "task-fix");
    record = await recombined(at, release(record), AT + 30_000);
    expect(record.open?.hold).toBeUndefined();

    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    record = enqueue(record, fix);
    mainMoves(at);
    record = await recombined(at, record, AT + 60_000);

    expect(record.leftOut).toEqual([]);
    expect(record.open?.members.map((member) => member.taskId)).toEqual([
      "task-column",
      "task-fix",
    ]);
    expect(record.fixBases).toEqual({ "task-fix": held });
    const head = record.open?.head as string;
    expect(run(at.home, "show", `${head}:src/report.ts`)).toBe(
      "export const rows = ['date', 'total', 'time_zone'];",
    );
    expect(run(at.home, "ls-tree", "-r", "--name-only", head)).not.toContain("docs/report.md");
  });

  // Intent: the same piece, the independent review's later finding, a bug being fixed: an
  // approval that measured the fix from the held version while the retried batch was still
  // checking kept nothing, so a version approved in its place before the first combine was
  // carried whole, with the work of the change sent back.
  it("keeps the version an approval measured a fix from, so a replacement before its first combine is left out", async () => {
    const at = host();
    const { page, held, record: saved } = await heldBatch(at);
    let record = declared(withdraw(saved, page.taskId), "task-fix");
    // Try again releases the hold, and the retried batch checks without the fix.
    record = await recombined(at, release(record), AT + 30_000);
    expect(record.open?.hold).toBeUndefined();

    // Approved while it checks: its approval measured the fix from the held version.
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
      heldBase: held,
    };
    record = enqueue(record, fix);
    expect(record.fixBases).toEqual({ "task-fix": held });

    // Replaced before any combine by a version that squashed the batch's commits into its own.
    const rewritten: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: {
          "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n",
          "docs/report.md": "| date | total |\n",
        },
        approvedAt: 4_000,
      }),
      fix: true,
    };
    record = await recombined(at, enqueue(record, rewritten), AT + 60_000);

    expect(record.open?.members.map((member) => member.taskId)).toEqual(["task-column"]);
    expect(record.leftOut).toEqual([
      expect.objectContaining({ taskId: "task-fix", reason: LEFT_OUT_WORDS.fixBaseLost(held) }),
    ]);
    expect(run(at.home, "ls-tree", "-r", "--name-only", record.open?.head as string)).not.toContain(
      "docs/report.md",
    );
  });

  // Intent: the same piece, the independent review's third finding, a bug being fixed: a
  // joined fix replaced by a version whose inherited history was rewritten matched no held
  // version and was carried whole, with the work of the change sent back.
  it("leaves out a joined fix replaced by a version whose inherited history was rewritten", async () => {
    const at = host();
    const { page, held, record: saved } = await heldBatch(at);
    let record = declared(withdraw(saved, page.taskId), "task-fix");
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: { "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    record = await recombined(at, enqueue(record, fix), AT + 60_000);
    expect(record.fixBases).toEqual({ "task-fix": held });

    // The repair squashes the batch's commits into its own and pushes that in its place:
    // the page sent back rides along, on no version that held.
    const rewritten: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(report): name the column as the export does",
        files: {
          "src/report.ts": "export const rows = ['date', 'total', 'time_zone'];\n",
          "docs/report.md": "| date | total |\n",
        },
        approvedAt: 4_000,
      }),
      fix: true,
    };
    record = await recombined(at, enqueue(record, rewritten), AT + 120_000);

    expect(record.open?.members.map((member) => member.taskId)).toEqual(["task-column"]);
    expect(record.leftOut).toEqual([
      expect.objectContaining({ taskId: "task-fix", reason: LEFT_OUT_WORDS.fixBaseLost(held) }),
    ]);
    expect(run(at.home, "ls-tree", "-r", "--name-only", record.open?.head as string)).not.toContain(
      "docs/report.md",
    );
  });

  // Intent: the same piece, the independent review's fourth finding, a bug being fixed: a fix
  // left out on its first combine lost the version it was verified on, so a replacement that
  // rewrote its inherited history was carried whole, with the work of the change sent back.
  it("keeps the version a fix was verified on when its first combine left it out", async () => {
    const at = host();
    const { page, held, record: saved } = await heldBatch(at);
    let record = declared(withdraw(saved, page.taskId), "task-fix");
    // Its difference touches the page sent back beside it, so it does not combine.
    const clashing: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(docs): list the time zone column",
        files: { "docs/report.md": "| date | total | zone |\n" },
        from: `origin/${BATCH}`,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    record = await recombined(at, enqueue(release(record), clashing), AT + 60_000);
    expect(record.leftOut).toEqual([
      expect.objectContaining({ taskId: "task-fix", reason: LEFT_OUT_WORDS.fixClash(held) }),
    ]);
    expect(record.fixBases).toEqual({ "task-fix": held });

    // The repair pushes its new version from the default branch with the page folded in.
    const rewritten: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(docs): list the time zone column",
        files: { "docs/report.md": "| date | total | zone |\n" },
        approvedAt: 4_000,
      }),
      fix: true,
    };
    record = await recombined(at, enqueue(record, rewritten), AT + 120_000);
    expect(record.leftOut).toEqual([
      expect.objectContaining({ taskId: "task-fix", reason: LEFT_OUT_WORDS.fixBaseLost(held) }),
    ]);
    expect(run(at.home, "ls-tree", "-r", "--name-only", record.open?.head as string)).not.toContain(
      "docs/report.md",
    );
  });

  // Intent: the same piece, the independent review's fourth finding, a bug being fixed: one
  // unreadable version in the batch's history left out every fix, even one it never touched.
  it("passes over a version it cannot read, and leaves out only a fix whose own verified version is unreadable", async () => {
    const at = host();
    const { column, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(parser): read dates with a time zone",
        files: PARSER.files,
        approvedAt: 3_000,
      }),
      fix: true,
    };
    const unread = "0123456789abcdef0123456789abcdef01234567";
    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, fix],
      at: AT + 60_000,
      held: [unread, held],
    });
    expect(result.leftOut).toEqual([]);
    expect(result.members.map((member) => member.taskId)).toEqual(["task-column", "task-fix"]);

    const pinned = { ...fix, heldBase: unread };
    const refused = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, pinned],
      at: AT + 120_000,
      held: [held],
    });
    expect(refused.leftOut).toEqual([
      { change: pinned, reason: LEFT_OUT_WORDS.fixBaseUnread(unread) },
    ]);
  });

  it("combines the ordinary way when it is built on the default branch", async () => {
    const at = host();
    const { column, page, held } = await heldBatch(at);
    const fix: BatchChange = {
      ...change(at, {
        taskId: "task-fix",
        title: "fix(parser): read dates with a time zone",
        files: PARSER.files,
        approvedAt: 3_000,
      }),
      fix: true,
    };

    const result = await combine({
      repoDir: at.home,
      defaultBranch: "main",
      changes: [column, page, fix],
      at: AT + 60_000,
      held: [held],
    });

    expect(result.leftOut).toEqual([]);
    const [, second, third] = result.members.map((member) => member.commit) as [
      string,
      string,
      string,
    ];
    expect(run(at.home, "diff", "--name-only", second, third)).toBe("src/parser.ts");
  });
});
