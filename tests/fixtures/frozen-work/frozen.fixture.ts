import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// INF-1083's proof for unit tests: tests/wait-window.test.ts starts this file's
// runs, freezes the whole run - vitest, its worker and the writer - once a
// wait writes `waiting`, and lets it go once `done` appears, then reads each
// test's result from vitest's own report. Neither wait names a window, so each
// lasts its test's budget, and the test's own limit is that budget.
const signals = process.env.INFINITARY_FROZEN_WORK_SIGNALS ?? "";
const budget = Number(process.env.INFINITARY_FROZEN_WORK_BUDGET);

/** Whether `file` is there, saying so from inside the wait, once its window is set. */
function arrived(file: string): boolean {
  writeFileSync(join(signals, "waiting"), "");
  return existsSync(file);
}

afterEach(() => writeFileSync(join(signals, "done"), ""));

it(
  "a frozen writer's file",
  async () => {
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
    await vi.waitFor(() => expect(arrived(file)).toBe(true));
  },
  budget,
);

it(
  "a missing file",
  async () => {
    await expect.poll(() => arrived(join(signals, "never"))).toBe(true);
  },
  budget,
);
