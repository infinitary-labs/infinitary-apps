import { defineConfig } from "vitest/config";
import FixtureSequencer from "./sequencer";

export default defineConfig({
  test: {
    root: __dirname,
    include: ["*.fixture.ts"],
    isolate: false,
    sequence: { sequencer: FixtureSequencer },
    maxWorkers: 1,
    setupFiles: ["../../helpers/pureProject.ts"],
  },
});
