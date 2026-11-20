import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// A run of its own for tests/run-temp-root.test.ts: the real global setup
// and cleanup the suite uses, over one file that leaks when asked to.
export default defineConfig({
  // The shared cleanup wires the attachments folder, which imports @shared.
  resolve: { alias: { "@shared": resolve(__dirname, "../../../src/shared") } },
  test: {
    root: __dirname,
    include: ["leaks.fixture.ts"],
    globalSetup: ["../../helpers/vitestGlobalSetup.ts"],
    setupFiles: ["../../helpers/scratchDirCleanup.ts"],
  },
});
