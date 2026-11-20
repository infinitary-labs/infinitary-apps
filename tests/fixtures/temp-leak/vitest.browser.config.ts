import { resolve } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Real Vitest-owned Chromium, with the same teardown as the full browser project.
export default defineConfig({
  resolve: { alias: { "@shared": resolve(__dirname, "../../../src/shared") } },
  test: {
    root: __dirname,
    include: ["browser.fixture.ts"],
    globalSetup: ["../../helpers/vitestGlobalSetup.ts", "./browserProgramSetup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
