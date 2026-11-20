import { defineConfig } from "vitest/config";

// The setup-hook run of tests/wait-window.test.ts: a setup file listed before
// waitWindow.ts registers its hook before the load clock starts, as
// statementCheck.ts and scratchDirCleanup.ts do in vitest.config.ts; the
// test's own disk counter starts the clock after it, as waitWindow.ts would.
export default defineConfig({
  test: {
    root: __dirname,
    include: ["setupHook.fixture.ts"],
    setupFiles: ["./frozenSetupHook.ts", "./diskPressure.ts", "../../helpers/waitWindow.ts"],
    // In the order listed: vitest otherwise imports setup files side by side,
    // and the clock could start before the hook registers.
    sequence: { setupFiles: "list" },
  },
});
