import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { compareWorkloads, median, type WorkloadRun } from "../scripts/test-workload";
import { scratchDir } from "./helpers/scratchDirs";

const run = (unitMs: number, desktopWithBuildMs: number): WorkloadRun => ({
  unitMs,
  desktopWithBuildMs,
  unitExit: 0,
  desktopExit: 0,
});

it("budgets the median complete workload, including replacement work and required build", () => {
  const before = [run(900, 100), run(100, 900), run(500, 500), run(990, 10), run(10, 990)];
  const after = Array.from({ length: 5 }, () => run(50, 150));
  expect(compareWorkloads(before, after)).toEqual({
    beforeMs: 1000,
    afterMs: 200,
    ratio: 0.2,
    withinTimeBudget: true,
  });
  expect(
    compareWorkloads(
      before,
      after.map(() => run(50, 151)),
    ).withinTimeBudget,
  ).toBe(false);
  expect(median([100, 1, 3, 2, 4])).toBe(3);
});

it("refuses incomplete or failed runs instead of treating early exits as speedups", () => {
  const before = Array.from({ length: 5 }, () => run(100, 900));
  expect(() => compareWorkloads(before.slice(1), before)).toThrow("Exactly five");
  for (const failure of [{ unitExit: 1 }, { desktopExit: 1 }, { unitExit: null }]) {
    expect(() =>
      compareWorkloads(before, [{ ...run(1, 1), ...failure }, ...before.slice(1)]),
    ).toThrow("Failed or interrupted");
  }
  expect(() => median([Number.NaN])).toThrow();
  expect(() => median([-1])).toThrow();
});

it("prints the comparison through the actual command-line interface", () => {
  const dir = scratchDir("fm-workload-");
  try {
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify({ runs: Array.from({ length: 5 }, () => run(100, 900)) }));
    writeFileSync(after, JSON.stringify({ runs: Array.from({ length: 5 }, () => run(50, 150)) }));
    const stdout = execFileSync(
      process.execPath,
      [resolve("scripts/test-workload.ts"), "compare", before, after],
      { encoding: "utf8" },
    );
    expect(stdout).toContain('"ratio": 0.2');
    expect(stdout).toContain('"withinTimeBudget": true');
    expect(stdout).toContain(
      "Timing only: also review assertion retention, skips, resource allowance and cold-start evidence.",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("stops the actual recorder after a failed unit command without starting desktop work", () => {
  const dir = scratchDir("fm-workload-stop-");
  try {
    const calls = join(dir, "calls.jsonl");
    const pnpm = join(dir, "pnpm");
    writeFileSync(
      pnpm,
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(process.argv[2] === "test" ? 7 : 0);
`,
    );
    chmodSync(pnpm, 0o700);
    const out = join(dir, "record");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/test-workload.ts"), "record", out],
      {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    const invoked = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invoked.map((args: string[]) => args[0])).toEqual(["test"]);
    const record = JSON.parse(readFileSync(join(out, "workload.json"), "utf8"));
    expect(record.runs).toHaveLength(1);
    expect(record.runs[0]).toMatchObject({ unitExit: 7, desktopExit: null, desktopWithBuildMs: 0 });
    expect(() => compareWorkloads(record.runs, record.runs)).toThrow("Exactly five");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("records one complete desktop workload with the same command in serial and configured modes", () => {
  const dir = scratchDir("fm-desktop-measure-");
  try {
    const pnpm = join(dir, "pnpm");
    writeFileSync(
      pnpm,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ args: process.argv.slice(2), stats: { expected: 3, skipped: 0, unexpected: 0 } }));
`,
    );
    chmodSync(pnpm, 0o700);
    for (const serial of [false, true]) {
      const out = join(dir, serial ? "serial" : "configured");
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/test-workload.ts"), "desktop", out, ...(serial ? ["--serial"] : [])],
        {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      const record = JSON.parse(readFileSync(join(out, "measurement.json"), "utf8"));
      const desktop = JSON.parse(readFileSync(join(out, "desktop.json"), "utf8"));
      expect(record.mode).toBe(serial ? "serial-control" : "configured");
      expect(record.exit).toBe(0);
      expect(record.desktopWithBuildMs).toBeGreaterThan(0);
      expect(desktop.args).toEqual([
        "test:e2e",
        "--reporter=json",
        ...(serial ? ["--workers=1"] : []),
      ]);
      expect(desktop.stats).toEqual({ expected: 3, skipped: 0, unexpected: 0 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
