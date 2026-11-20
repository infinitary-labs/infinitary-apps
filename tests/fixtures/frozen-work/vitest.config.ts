import { defineConfig } from "vitest/config";

// Runs of their own for tests/wait-window.test.ts: the waits' setup the suite
// uses, over a file whose work a busy Mac freezes past its time limit.
export default defineConfig({
  test: {
    root: __dirname,
    include: ["frozen.fixture.ts"],
    setupFiles: ["./diskPressure.ts", "../../helpers/waitWindow.ts"],
    // In the order listed, so the clock waitWindow.ts finds started is the test's own.
    sequence: { setupFiles: "list" },
  },
});
