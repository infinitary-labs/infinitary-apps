import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// INF-1083's proof: tests/load-clock.test.ts starts this file's runs, freezes the
// whole run - runner, worker and writer - once a poll writes `waiting`, and lets
// it go once `done` appears, then reads each test's result from the real runner.
const signals = process.env.INFINITARY_LOAD_CLOCK_SIGNALS ?? "";
const budget = Number(process.env.INFINITARY_LOAD_CLOCK_BUDGET);

/** Polls for `file` within the budget, saying so from inside the poll, once its deadline is set. */
async function poll(file: string) {
  await expect
    .poll(
      () => {
        writeFileSync(join(signals, "waiting"), "");
        return existsSync(file);
      },
      // A short last interval, so the poll's own early stop lands at the budget.
      { timeout: budget, intervals: [50] },
    )
    .toBe(true);
}

test.afterEach(() => writeFileSync(join(signals, "done"), ""));

test("a frozen writer's file", async () => {
  const file = join(signals, "written");
  // The writer needs a second of its own time; the freeze around it is what delays the file.
  spawn(
    process.execPath,
    [
      "-e",
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(file)}, "written"), 1000)`,
    ],
    { stdio: "ignore" },
  );
  await poll(file);
});

test("a missing file", async () => {
  await poll(join(signals, "never"));
});
