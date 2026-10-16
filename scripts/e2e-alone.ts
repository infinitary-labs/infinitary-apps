import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { RUNS_DIR, runName } from "../tests/e2e/runEvidence.ts";

/**
 * The run-alone pass (docs/testing.md, "Each test owns its prerequisites"):
 * a named test passes when it is selected alone, from fresh state. A spec
 * file that shares one app across its tests (`test.beforeAll`) is where a
 * test can lean on what an earlier one made and still pass in the full run,
 * so each of its later tests runs here by itself, by file:line, in a
 * Playwright run of its own.
 *
 * `node scripts/e2e-alone.ts tests/e2e/<file>.spec.ts ...` runs the pass over
 * the named files; with none it covers every spec file, which, like a full
 * e2e run, only CI does (verify.yml's mac lane). It runs against the current
 * build (`pnpm build` first), prints one line per test, writes
 * `ALONE_RESULTS` and each test's output, trace and picture to its
 * directory (`--out <dir>`, else this pass's own run directory under
 * test-results/runs/), and exits 1 when any test failed alone.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const E2E_DIR = "tests/e2e";

/** The pass's result, in its directory: every test it ran, how each ended, and the first error. */
export const ALONE_RESULTS = "alone-results.json";

/** The lanes whose tests overlap in the full run (tests/e2e/lanes.ts); desktop stays serial. */
const PARALLEL_LANES = new Set(["renderer", "application"]);

/** One test the pass runs by itself. */
export type AloneTest = { file: string; line: number; lane: string; title: string };

export type AloneResult = AloneTest & {
  status: "passed" | "failed";
  /** The first error Playwright reported, or the end of the run's output when it reported none. */
  error?: string;
  seconds: number;
};

/** What `playwright test --list --reporter=json` prints, as far as the pass reads it. */
type ListReport = { suites?: ListSuite[] };
type ListSuite = {
  title: string;
  specs?: Array<{
    title: string;
    file: string;
    line: number;
    tests: Array<{ projectName: string }>;
  }>;
  suites?: ListSuite[];
};

/** A spec file that shares one app across its tests, from its own source. */
export function sharesOneApp(source: string): boolean {
  return /\bbeforeAll\(/.test(source);
}

/**
 * Every test after the first in its file, once per file:line and lane: a
 * `for` loop's tests share their line and run together, as `file:line`
 * selects them.
 */
export function laterTests(report: ListReport): AloneTest[] {
  const byFile = new Map<string, AloneTest[]>();
  const visit = (suite: ListSuite, titles: string[]) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests) {
        const tests = byFile.get(spec.file) ?? [];
        const title = [...titles, spec.title].join(" › ");
        tests.push({ file: spec.file, line: spec.line, lane: test.projectName, title });
        byFile.set(spec.file, tests);
      }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  };
  // The top suites are the files; their titles are the file names.
  for (const suite of report.suites ?? []) visit(suite, []);
  const later: AloneTest[] = [];
  for (const tests of byFile.values()) {
    const first = Math.min(...tests.map((test) => test.line));
    const seen = new Set<string>();
    for (const test of tests) {
      const key = `${test.line}:${test.lane}`;
      if (test.line === first || seen.has(key)) continue;
      seen.add(key);
      later.push(test);
    }
  }
  return later.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The files the pass covers: the named ones, or every spec file on CI. */
function specFiles(named: string[]): string[] {
  if (named.length > 0) return named.map((file) => relative(REPO_ROOT, resolve(file)));
  if (!process.env.CI) {
    throw new Error(
      "The run-alone pass over every spec file is CI-only, like a full end-to-end run " +
        "(verify.yml). Locally, name the affected files: " +
        "node scripts/e2e-alone.ts tests/e2e/<file>.spec.ts",
    );
  }
  return readdirSync(join(REPO_ROOT, E2E_DIR))
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => join(E2E_DIR, name));
}

/** A child's environment: never the JSON path a calling step set for its own run. */
function childEnv(json?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  if (json) env.PLAYWRIGHT_JSON_OUTPUT_FILE = json;
  return env;
}

function listLater(files: string[]): AloneTest[] {
  if (files.length === 0) return [];
  const listed = spawnSync(
    "pnpm",
    // --no-deps: a teardown lane ignores the file filter (tests/e2e/lanes.ts).
    ["exec", "playwright", "test", "--list", "--no-deps", "--reporter=json", ...files],
    { cwd: REPO_ROOT, env: childEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.status !== 0) {
    throw new Error(`Listing the tests failed:\n${listed.stderr || listed.stdout}`);
  }
  return laterTests(JSON.parse(listed.stdout) as ListReport);
}

/** The first error a run's JSON result names, whether a test's or the run's own. */
function firstError(json: string): string | undefined {
  type Result = { errors?: Array<{ message?: string }> };
  type Suite = { specs?: Array<{ tests: Array<{ results: Result[] }> }>; suites?: Suite[] };
  let report: { suites?: Suite[]; errors?: Array<{ message?: string }> };
  try {
    report = JSON.parse(readFileSync(json, "utf8"));
  } catch {
    return undefined;
  }
  const visit = (suite: Suite): string | undefined => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests)
        for (const result of test.results)
          for (const error of result.errors ?? []) if (error.message) return error.message;
    for (const child of suite.suites ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  for (const suite of report.suites ?? []) {
    const found = visit(suite);
    if (found) return found;
  }
  return report.errors?.find((error) => error.message)?.message;
}

function runAlone(test: AloneTest, out: string): Promise<AloneResult> {
  const dir = join(out, `${basename(test.file, ".spec.ts")}-${test.line}-${test.lane}`);
  const json = join(dir, "e2e-results.json");
  const args = ["exec", "playwright", "test", `${E2E_DIR}/${test.file}:${test.line}`];
  args.push(`--project=${test.lane}`, `--output=${dir}`);
  // The desktop lane is the other lanes' teardown; --no-deps keeps it out.
  if (test.lane !== "desktop") args.push("--no-deps");
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("pnpm", args, { cwd: REPO_ROOT, env: childEnv(json) });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "output.log"), output);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (code === 0) {
        done({ ...test, status: "passed", seconds });
        return;
      }
      const error = firstError(json) ?? output.trim().split("\n").slice(-20).join("\n");
      done({ ...test, status: "failed", error: stripVTControlCharacters(error), seconds });
    });
  });
}

/** Runs `tests` at most `width` at a time, in order, reporting each as it ends. */
async function pool(
  tests: AloneTest[],
  width: number,
  run: (test: AloneTest) => Promise<AloneResult>,
): Promise<AloneResult[]> {
  const results: AloneResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tests.length) {
      const test = tests[next++] as AloneTest;
      const result = await run(test);
      const mark = result.status === "passed" ? "passed" : "FAILED";
      console.log(`${mark} ${test.file}:${test.line} (${test.lane}, ${result.seconds}s)`);
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, tests.length) }, worker));
  return results;
}

async function main(args: string[]): Promise<number> {
  const named: string[] = [];
  // A run directory named for this process reads as a live run while the pass
  // goes, so `pnpm build` waits for it and no Playwright run's tidying removes it.
  let out = join(REPO_ROOT, RUNS_DIR, runName(new Date(), process.pid));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--out") out = resolve(args[++index] ?? ".");
    else named.push(arg);
  }
  const files = specFiles(named).filter((file) =>
    sharesOneApp(readFileSync(join(REPO_ROOT, file), "utf8")),
  );
  // Every test would fail the same way at launch (tests/e2e/launch.ts); say so once.
  if (!existsSync(join(REPO_ROOT, "out", "main", "index.js"))) {
    throw new Error(
      "The run-alone pass runs the current build, and there is none: pnpm build first.",
    );
  }
  mkdirSync(out, { recursive: true });
  const tests = listLater(files);
  console.log(
    `The run-alone pass: ${tests.length} later tests of ${files.length} files that share one app; ` +
      `evidence in ${relative(process.cwd(), out)}/`,
  );
  const parallel = tests.filter((test) => PARALLEL_LANES.has(test.lane));
  const serial = tests.filter((test) => !PARALLEL_LANES.has(test.lane));
  const results = [
    ...(await pool(parallel, Math.min(4, availableParallelism()), (test) => runAlone(test, out))),
    ...(await pool(serial, 1, (test) => runAlone(test, out))),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const failed = results.filter((result) => result.status === "failed");
  writeFileSync(join(out, ALONE_RESULTS), `${JSON.stringify({ results }, null, 2)}\n`);
  console.log(`\nRun alone: ${results.length - failed.length} passed, ${failed.length} failed.`);
  for (const result of failed) {
    console.log(`\n${result.file}:${result.line} ${result.title} (${result.lane})`);
    console.log((result.error ?? "").split("\n").slice(0, 12).join("\n"));
  }
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
