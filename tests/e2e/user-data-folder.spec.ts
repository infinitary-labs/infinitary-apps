import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { SOURCE_RUN_COPY_DIR } from "../../src/core/storage/sourceRunCopy";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { DEV_USER_DATA_FOLDER, RELEASE_USER_DATA_FOLDER } from "../../src/shared/userDataFolders";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, closeApp, launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { readSavedData } from "./savedData";
import { MAC_ONLY_TAG } from "./tags";

/**
 * Which folder a run really opens (src/shared/userDataFolders.ts). A run from
 * source opens the person's own saved data, the installed release's folder
 * (the captain's ask on INF-5635's plan: pnpm dev as the daily app), so the
 * unpackaged app is launched with NO isolated dir over a record the installed
 * app left and asked where its userData is, with macOS's home pinned to a
 * throwaway directory - `CFFIXED_USER_HOME` is what Electron's appData
 * follows; HOME alone does not move it. The packaged
 * flavors are checked the same way against a built bundle by
 * scripts/check-user-data-dir.sh (the dev bundle in verify.yml, the signed
 * release in release.yml): Playwright cannot attach to a fused build.
 */

test.skip(process.platform !== "darwin", "CFFIXED_USER_HOME is macOS's");

test("an unpackaged run opens the installed app's <appData>/infinitary, keeping a copy of its record first", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const home = realpathSync(scratchDir("infinitary-flavor-home-"));
  const appSupport = join(home, "Library", "Application Support");
  const own = join(appSupport, RELEASE_USER_DATA_FOLDER);
  // The record the installed app left, with one task, and a development folder an earlier pnpm dev left.
  const installed = openDatabase(own);
  seedTask(new TaskService({ db: installed, strict: true }), {
    id: "installed-task",
    title: "Write the release notes",
    status: "completed",
  });
  installed.close();
  mkdirSync(join(appSupport, DEV_USER_DATA_FOLDER));
  // e2e-fixture: input -- the folder an earlier pnpm dev left, which this run must leave as it is.
  writeFileSync(join(appSupport, DEV_USER_DATA_FOLDER, "left-by-pnpm-dev"), "kept\n");
  const titles = (dir: string) =>
    readSavedData(dir, (saved) => saved.prepare("SELECT id, title FROM tasks").all());
  const inherited = { ...(process.env as Record<string, string>) };
  delete inherited.INFINITARY_USER_DATA_DIR;
  const app = await electron.launch({
    artifactsDir: scratchDir("infinitary-pw-artifacts-"),
    args: [builtAppDir(), "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    env: {
      ...inherited,
      ELECTRON_RENDERER_URL: "",
      HOME: home,
      CFFIXED_USER_HOME: home,
      INFINITARY_HIDE_WINDOW: "1",
      PI_OFFLINE: "1",
      INFINITARY_VOICE_MODEL_READY: "1",
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(home, "claude-stub")),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.app.healthcheck()))
      .toMatchObject({ ok: true });

    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    expect(realpathSync(userData)).toBe(own);
    // The copy it kept before opening the record holds the record as the installed app left it.
    expect(titles(join(own, SOURCE_RUN_COPY_DIR))).toEqual([
      { id: "installed-task", title: "Write the release notes" },
    ]);
    expect(readdirSync(join(appSupport, DEV_USER_DATA_FOLDER))).toEqual(["left-by-pnpm-dev"]);
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    ).toBe(false);
  } finally {
    await closeApp(app);
  }
  expect(titles(own)).toContainEqual({ id: "installed-task", title: "Write the release notes" });
});

test("INFINITARY_USER_DATA_DIR still wins on an unpackaged run", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const launched = await launchApp();
  try {
    const userData = await launched.app.evaluate(({ app }) => app.getPath("userData"));
    expect(realpathSync(userData)).toBe(realpathSync(launched.userDataDir));
    await expect.poll(() => existsSync(join(launched.userDataDir, "firstmate.db"))).toBe(true);
  } finally {
    await launched.close();
  }
});
