import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskFloorError, isTransientPullError } from "../scripts/bench/containers.ts";
import { withLock } from "../scripts/bench/lock.ts";
import type { BenchTask } from "../scripts/bench/pool.ts";
import { mirrorName } from "../scripts/bench/repos.ts";
import {
  pendingTasks,
  readRows,
  type SweepDeps,
  type SweepRow,
  summarize,
  sweepEmptyPatches,
} from "../scripts/bench/sweep.ts";
import type { VerifierResult } from "../scripts/bench/verifierRunner.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The benchmark tooling's in-memory logic (scripts/bench): the empty-patch
 * sweep over a fake machine (which tasks a resumed sweep runs, the one
 * retry an infrastructure failure gets, the free-disk floor that stops a
 * sweep, the image waves, and the table S1 reads), the pull retry, the
 * cross-process lock and the mirror's name. The real machine (Apple
 * container, the task images) is what `bench.ts sweep` drives; only it
 * stands in here.
 */

function task(id: string, image = `img-${id}`): BenchTask {
  return {
    id,
    dir: `/pool/${id}`,
    image,
    baseCommit: "0".repeat(40),
    repositoryUrl: `https://example.com/${id}.git`,
    language: "python",
    category: "feature_request",
    verifier: { timeoutSec: 1800, cpus: 2, memoryMb: 8192 },
  };
}

function graded(id: string, reward = 0, wallSeconds = 10): VerifierResult {
  return {
    task: id,
    reward,
    scores: { reward, partial: 0.5, f2p_total: 4, f2p_passed: 0, p2p_total: 8, p2p_passed: 8 },
    patchBytes: 0,
    exitCode: 0,
    timedOut: false,
    wallSeconds,
    logsDir: `/logs/${id}`,
  };
}

function timedOut(id: string): VerifierResult {
  return { ...graded(id), reward: -1, scores: null, timedOut: true, wallSeconds: 1800 };
}

function machine(opts: {
  rowsPath: string;
  script: Record<string, (VerifierResult | Error)[]>;
  cached?: string[];
  pullError?: Record<string, Error>;
}) {
  const calls = { pulled: [] as string[], graded: [] as string[], deleted: [] as string[] };
  const deps: SweepDeps = {
    cachedImages: () => new Set(opts.cached ?? []),
    pull: async (t) => {
      calls.pulled.push(t.id);
      const error = opts.pullError?.[t.id];
      if (error) throw error;
      return { seconds: 12.4 };
    },
    grade: async (t) => {
      calls.graded.push(t.id);
      const next = opts.script[t.id]?.shift();
      if (!next) throw new Error(`no scripted result for ${t.id}`);
      if (next instanceof Error) throw next;
      return next;
    },
    deleteImage: (t) => {
      calls.deleted.push(t.image);
    },
    freeDiskGb: () => 250,
    append: (path, line) => writeFileSync(path, line, { flag: "a" }),
    readRows,
  };
  return { deps, calls };
}

const quiet = () => {};

describe("the empty-patch sweep", () => {
  it("runs every task once, deletes each image it pulled, and keeps one cached before", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const { deps, calls } = machine({
      rowsPath,
      script: { a: [graded("a")], b: [graded("b", 0, 42)] },
      cached: ["img-b"],
    });
    const rows = await sweepEmptyPatches({
      tasks: [task("a"), task("b")],
      rowsPath,
      concurrency: 2,
      keepImages: false,
      log: quiet,
      deps,
    });
    expect(rows.map((row) => [row.task, row.reward, row.attempts, row.failure])).toEqual(
      expect.arrayContaining([
        ["a", 0, 1, null],
        ["b", 0, 1, null],
      ]),
    );
    expect(calls.pulled).toEqual(["a"]);
    expect(calls.deleted).toEqual(["img-a"]);
    const b = rows.find((row) => row.task === "b") as SweepRow;
    expect(b).toMatchObject({ pullSeconds: null, verifierSeconds: 42, partial: 0.5, f2pTotal: 4 });
  });

  it("resumes: a task with a row is never run again", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const first = machine({ rowsPath, script: { a: [graded("a")] } });
    await sweepEmptyPatches({
      tasks: [task("a")],
      rowsPath,
      concurrency: 1,
      keepImages: false,
      log: quiet,
      deps: first.deps,
    });
    const second = machine({ rowsPath, script: { b: [graded("b")] } });
    const rows = await sweepEmptyPatches({
      tasks: [task("a"), task("b")],
      rowsPath,
      concurrency: 1,
      keepImages: false,
      log: quiet,
      deps: second.deps,
    });
    expect(second.calls.graded).toEqual(["b"]);
    expect(rows.map((row) => row.task)).toEqual(["a", "b"]);
    expect(pendingTasks([task("a"), task("b"), task("c")], rows).map((t) => t.id)).toEqual(["c"]);
  });

  it("retries an infrastructure failure once, on the same image, and flags it", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const { deps, calls } = machine({
      rowsPath,
      script: {
        flaky: [timedOut("flaky"), graded("flaky")],
        broken: [new Error("container run failed"), timedOut("broken")],
      },
    });
    const rows = await sweepEmptyPatches({
      tasks: [task("flaky"), task("broken")],
      rowsPath,
      concurrency: 1,
      keepImages: false,
      log: quiet,
      deps,
    });
    const byId = Object.fromEntries(rows.map((row) => [row.task, row]));
    expect(byId.flaky).toMatchObject({
      reward: 0,
      failure: null,
      attempts: 2,
      firstFailure: "timeout after 1800 s",
    });
    expect(byId.broken).toMatchObject({
      reward: -1,
      failure: "timeout after 1800 s",
      attempts: 2,
      firstFailure: "error: container run failed",
      timedOut: true,
    });
    expect(calls.graded).toEqual(["flaky", "flaky", "broken", "broken"]);
    expect(calls.pulled).toEqual(["flaky", "broken"]);
    expect(calls.deleted).toEqual(["img-flaky", "img-broken"]);
  });

  it("counts a verifier that wrote no reward, or its own -1, as an infrastructure failure", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const noReward = { ...graded("n"), reward: -1, scores: null, exitCode: 127 };
    const minusOne = { ...graded("m"), reward: -1, scores: { reward: -1 }, exitCode: 6 };
    const { deps } = machine({
      rowsPath,
      script: { n: [noReward, noReward], m: [minusOne, minusOne] },
    });
    const rows = await sweepEmptyPatches({
      tasks: [task("n"), task("m")],
      rowsPath,
      concurrency: 1,
      keepImages: false,
      log: quiet,
      deps,
    });
    expect(rows.map((row) => [row.task, row.failure])).toEqual([
      ["n", "no reward.json (exit 127)"],
      ["m", "the verifier wrote reward -1 (exit 6)"],
    ]);
  });

  it("stops at the free-disk floor without recording the task", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const { deps, calls } = machine({
      rowsPath,
      script: { a: [graded("a")], c: [graded("c")] },
      pullError: { b: new DiskFloorError("refusing to pull b: 104 GB free, floor 100 GB") },
    });
    await expect(
      sweepEmptyPatches({
        tasks: [task("a"), task("b"), task("c")],
        rowsPath,
        concurrency: 1,
        keepImages: false,
        log: quiet,
        deps,
      }),
    ).rejects.toThrow(/floor 100 GB/);
    expect(readRows(rowsPath).map((row) => row.task)).toEqual(["a"]);
    expect(calls.graded).toEqual(["a"]);
    expect(calls.deleted).toEqual(["img-a"]);
  });

  it("keeps pulled images when asked", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const { deps, calls } = machine({ rowsPath, script: { a: [graded("a")] } });
    await sweepEmptyPatches({
      tasks: [task("a")],
      rowsPath,
      concurrency: 1,
      keepImages: true,
      log: quiet,
      deps,
    });
    expect(calls.deleted).toEqual([]);
  });

  it("refuses more workers than the task-container limit", async () => {
    const rowsPath = join(scratchDir("infinitary-bench-sweep-"), "rows.jsonl");
    const { deps } = machine({ rowsPath, script: {} });
    await expect(
      sweepEmptyPatches({
        tasks: [],
        rowsPath,
        concurrency: 4,
        keepImages: false,
        log: quiet,
        deps,
      }),
    ).rejects.toThrow("concurrency must be 1 to 3");
  });
});

describe("the sweep's table", () => {
  const row = (over: Partial<SweepRow>): SweepRow => ({
    task: "t",
    language: "go",
    reward: 0,
    partial: 0.5,
    f2pTotal: 1,
    f2pPassed: 0,
    p2pTotal: 1,
    p2pPassed: 1,
    verifierSeconds: 10,
    budgetSeconds: 1800,
    pullSeconds: 20,
    timedOut: false,
    exitCode: 0,
    failure: null,
    attempts: 1,
    firstFailure: null,
    logsDir: "/logs",
    at: "2026-09-27T00:00:00.000Z",
    ...over,
  });

  it("names failures, retries, empty-patch passes, suites that never ran and slow verifiers", () => {
    const table = summarize(
      [
        row({ task: "slow", verifierSeconds: 1000 }),
        row({ task: "a", verifierSeconds: 20 }),
        row({
          task: "gone",
          reward: -1,
          timedOut: true,
          verifierSeconds: 1800,
          failure: "timeout after 1800 s",
          attempts: 2,
          firstFailure: "timeout after 1800 s",
        }),
        row({ task: "solved", reward: 1 }),
        row({ task: "flaky", attempts: 2, firstFailure: "error: pull failed" }),
        row({ task: "crashed", partial: 0, p2pPassed: 0 }),
        row({ task: "no-p2p", p2pTotal: 0, p2pPassed: 0 }),
      ],
      "test host",
    );
    expect(table.rows.map((r) => r.task)).toEqual([
      "a",
      "crashed",
      "flaky",
      "gone",
      "no-p2p",
      "slow",
      "solved",
    ]);
    expect(table.graded).toBe(6);
    expect(table.infrastructureFailures).toEqual([
      { task: "gone", failure: "timeout after 1800 s", firstFailure: "timeout after 1800 s" },
    ]);
    expect(table.retried.map((r) => [r.task, r.final])).toEqual([
      ["flaky", "graded"],
      ["gone", "timeout after 1800 s"],
    ]);
    expect(table.passingOnEmptyPatch).toEqual(["solved"]);
    expect(table.suiteDidNotRun).toEqual(["crashed"]);
    expect(table.slowUnderRosetta.map((r) => r.task)).toEqual(["gone", "slow"]);
    expect(table.verifierSeconds).toEqual({ total: 1060, median: 10, p90: 1000, max: 1000 });
    expect(table.rows[0]).not.toHaveProperty("logsDir");
    expect(table.rows[0]).not.toHaveProperty("at");
  });
});

describe("pull retries", () => {
  it("waits out the registry's rate limit and 5xx answers, and fails fast on anything else", () => {
    expect(
      isTransientPullError(
        'failed with response: 429 Too Many Requests. Reason: {"errors":[{"code":"TOOMANYREQUESTS"}]}',
      ),
    ).toBe(true);
    expect(isTransientPullError("failed with response: 503 Service Unavailable")).toBe(true);
    expect(isTransientPullError("failed with response: 404 Not Found")).toBe(false);
    expect(isTransientPullError("manifest unknown")).toBe(false);
  });
});

describe("the cross-process lock", () => {
  it("runs one holder at a time and removes the lock after, even when the work throws", async () => {
    const path = join(scratchDir("infinitary-bench-lock-"), "locks", "start");
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withLock(path, async () => {
      order.push("first in");
      await held;
      order.push("first out");
    });
    const second = withLock(path, () => {
      order.push("second in");
    });
    await Promise.resolve();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
    expect(existsSync(path)).toBe(false);

    await expect(
      withLock(path, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });

  it("takes over a lock whose owner is gone or unreadable", async () => {
    const dir = scratchDir("infinitary-bench-lock-");
    for (const stale of [String(2 ** 30), "not a pid"]) {
      const path = join(dir, `lock-${stale.length}`);
      writeFileSync(path, stale);
      await expect(withLock(path, () => "taken")).resolves.toBe("taken");
      expect(existsSync(path)).toBe(false);
    }
  });
});

describe("the mirror's name", () => {
  it("is the upstream repository's name and a hash, never the benchmark's or the task's", () => {
    const tomlkit = {
      ...task("tomlkit-toml-table-converters"),
      repositoryUrl: "https://github.com/python-poetry/tomlkit.git/",
    };
    const name = mirrorName(tomlkit);
    expect(name).toMatch(/^tomlkit-[0-9a-f]{6}$/);
    expect(name).not.toMatch(/bench|converters/);
    expect(mirrorName({ ...tomlkit, id: "tomlkit-other-task" })).not.toBe(name);
    expect(mirrorName(tomlkit)).toBe(name);
  });
});
