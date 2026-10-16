import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { stopWithWorker } from "./workerApps";

/** Real Chromium layout in a fresh, non-persistent browser partition per test. */
export const rendererTest = base.extend<{ page: Page }, { rendererApp: ElectronApplication }>({
  rendererApp: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
    async ({}, use) => {
      const root = scratchDir("infinitary-renderer-");
      const userData = join(root, "data");
      stopWithWorker(userData);
      const app = await electron.launch({
        artifactsDir: scratchDir("infinitary-pw-artifacts-"),
        // Chromium reads this before any script. renderer-main's setPath
        // runs after Playwright's loader has already called whenReady, so
        // without the switch this process shares the default Electron
        // profile with the desktop lane.
        args: [resolve("tests/e2e/renderer-main.cjs"), `--user-data-dir=${userData}`],
        env: {
          ...(process.env as Record<string, string>),
          HOME: root,
          INFINITARY_RENDERER_USER_DATA: userData,
        },
      });
      try {
        await app.firstWindow();
        await use(app);
      } finally {
        await app.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  page: async ({ rendererApp }, use) => {
    const opened = rendererApp.waitForEvent("window");
    await rendererApp.evaluate(async ({ BrowserWindow }, partition) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await window.loadURL("about:blank");
    }, `renderer-${randomUUID()}`);
    const page = await opened;
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});
