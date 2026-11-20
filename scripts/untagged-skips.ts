import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAC_ONLY_TAG } from "../tests/e2e/tags.ts";

/**
 * Linux runs every test it can (docs/principles.md, 2026-10-28; docs/testing.md,
 * "Tests that need a Mac"), so a test that skips on Linux is one only the Mac
 * runs, and only a test tagged MAC_ONLY_TAG runs on a pull request's Mac job.
 * `node scripts/untagged-skips.ts <playwright json>` lists each test that
 * skipped in that run without the tag and exits 1 when there is one: it ran
 * nowhere a pull request looks. source-journeys.yml runs it after every Linux
 * journey run.
 */

type Result = { status: string };
export type Suite = {
  specs?: Array<{
    title: string;
    file: string;
    line: number;
    tags?: string[];
    tests: Array<{ projectName: string; results: Result[] }>;
  }>;
  suites?: Suite[];
};

export type UntaggedSkip = { file: string; line: number; title: string; lane: string };

/**
 * Each test the run started and then skipped, without the tag. A test the run
 * never started, after an interruption, has no result, and its run failed already.
 */
export function untaggedSkips(report: { suites?: Suite[] }): UntaggedSkip[] {
  // The JSON report writes a tag without its "@".
  const tag = MAC_ONLY_TAG.replace(/^@/, "");
  const found: UntaggedSkip[] = [];
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      if ((spec.tags ?? []).some((each) => each.replace(/^@/, "") === tag)) continue;
      for (const test of spec.tests)
        if (test.results.some((result) => result.status === "skipped"))
          found.push({ file: spec.file, line: spec.line, title: spec.title, lane: test.projectName });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return found;
}

function main(file: string | undefined): number {
  if (!file || !existsSync(file)) {
    console.log("No journey result: the run did not reach its end, and its own step says why.");
    return 0;
  }
  const skips = untaggedSkips(JSON.parse(readFileSync(file, "utf8")));
  if (skips.length === 0) {
    console.log(`No test skipped on Linux without ${MAC_ONLY_TAG}.`);
    return 0;
  }
  console.log(
    `${skips.length} skipped on Linux without ${MAC_ONLY_TAG}, so no pull request runs them anywhere. ` +
      "Tag each one that needs a Mac (tests/e2e/tags.ts), or let it run here:",
  );
  for (const skip of skips)
    console.log(`- tests/e2e/${skip.file}:${skip.line} ${skip.title} (${skip.lane})`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv[2]);
