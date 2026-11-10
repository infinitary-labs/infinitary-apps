import { defineConfig } from "vitest/config";

// The setup-hook run of tests/wait-window.test.ts: a setup file listed before
// waitWindow.ts registers its hook before the load clock starts, as
// statementCheck.ts and scratchDirCleanup.ts do in vitest.config.ts.
export default defineConfig({
  test: {
    root: __dirname,
    include: ["setupHook.fixture.ts"],
    setupFiles: ["./frozenSetupHook.ts", "../../helpers/waitWindow.ts"],
  },
});
