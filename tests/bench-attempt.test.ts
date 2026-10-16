import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AttemptRow } from "../scripts/bench/attempt.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The headless attempt driver's exit check (benchmark plan S1): one full
 * attempt on the e2e mock provider yields a scored row with usage. The CLI
 * runs as its user runs it, in its own process: the whole core boots
 * against the attempt's own state directory, the mock Firstmate commissions
 * the fixture task's crewmate, the crewmate writes its one file, and the
 * stub verifier grades the patch the driver read out of the working copy.
 */

const PROJECT = fileURLToPath(new URL("../", import.meta.url));

describe("a dry-run attempt", () => {
  it("writes a scored row with the attempt's usage and routing from a spaced project path", () => {
    // Preserve the script's symlinked path so its fixture check lives under
    // this alias even on a CI checkout whose own path has no spaces.
    const alias = join(scratchDir("infinitary-bench-alias-"), "project's spaced path");
    symlinkSync(PROJECT, alias, "dir");
    const cli = join(alias, "scripts", "bench", "run-attempt.ts");
    const out = join(scratchDir("infinitary-bench-attempt-"), "attempt");
    const run = spawnSync(
      process.execPath,
      ["--preserve-symlinks-main", cli, "--dry-run", "--out", out],
      {
        encoding: "utf8",
      },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

    const row = JSON.parse(readFileSync(join(out, "row.json"), "utf8")) as AttemptRow;
    expect(row).toMatchObject({
      task_id: "mock-answer",
      arm: "auto",
      care: "default",
      rigor_asked: "standard",
      provider_kind: "mock",
      end: { reason: "idle" },
      graded: { source: "worktree", also_changed: [] },
      patch: { files: ["answer.txt"] },
      verifier: { kind: "stub", error: null },
      reward: { reward: 1, applied: true, check_exit: 0 },
    });
    expect(readFileSync(row.patch.path, "utf8")).toContain("+forty-two");
    // The graded task's own turns and the Firstmate's, each a usage row.
    const tasks = new Set(row.usage.rows.map((usage) => usage.task_id));
    expect(tasks).toContain("firstmate");
    expect(tasks).toContain(row.graded?.task_id);
    expect(row.usage.rows.every((usage) => usage.model === "mock-1")).toBe(true);
    expect(row.usage.totals.turns).toBe(row.usage.rows.length);
    expect(row.usage.totals.input).toBeGreaterThan(0);
    expect(row.usage.totals.output).toBeGreaterThan(0);
    expect(row.routing.map((decision) => decision.task_id)).toContain(row.graded?.task_id);
  }, 95_000);
});
