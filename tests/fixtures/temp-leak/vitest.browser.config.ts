import { resolve } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { chromiumLaunchOptions } from "../../helpers/browserChromiumTemp";
import { leaveInRunRoot } from "./leaveInRunRoot";

// Real Vitest-owned Chromium, with the full browser project's temp folder and teardown.
export default defineConfig({
  resolve: { alias: { "@shared": resolve(__dirname, "../../../src/shared") } },
  test: {
    root: __dirname,
    include: ["browser.fixture.ts"],
    globalSetup: ["../../helpers/vitestGlobalSetup.ts", "./browserProgramSetup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: chromiumLaunchOptions({}) }),
      instances: [{ browser: "chromium" }],
      commands: { leaveInRunRoot },
    },
  },
});
