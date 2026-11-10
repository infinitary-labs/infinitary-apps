import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

// A setup file's hook, registered before waitWindow.ts starts the load clock,
// as scratchDirCleanup.ts's directory cleanup is: on a loaded runner that
// cleanup timed out at the wall clock's 10 s while every test had passed.
// tests/wait-window.test.ts freezes the run once this writes `waiting` and
// lets it go once `done` appears; the hook's own work is a second, and its
// limit is the budget.
const signals = process.env.INFINITARY_FROZEN_WORK_SIGNALS ?? "";
const budget = Number(process.env.INFINITARY_FROZEN_WORK_BUDGET);

afterAll(async () => {
  writeFileSync(join(signals, "waiting"), "");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  writeFileSync(join(signals, "done"), "");
}, budget);
