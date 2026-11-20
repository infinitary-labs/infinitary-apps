import { expect, it } from "vitest";

// The file the setup-hook run of tests/wait-window.test.ts runs: its one test
// does no work of its own, so the frozen work is all in frozenSetupHook.ts's hook.
it("a file whose setup file's hook is frozen", () => {
  expect(process.env.INFINITARY_FROZEN_WORK_SIGNALS).toBeTruthy();
});
