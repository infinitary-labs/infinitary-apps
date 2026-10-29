import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, closeApp, launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { MAC_ONLY_TAG } from "./tags";

/**
 * Which folder a run really opens (src/shared/userDataFolders.ts). A dev run
 * must never open the installed release's database, so the unpackaged app is
 * launched with NO isolated dir and asked where its userData is, with macOS's
 * home pinned to a throwaway directory - `CFFIXED_USER_HOME` is what
 * Electron's appData follows; HOME alone does not move it. The packaged
 * flavors are checked the same way against a built bundle by
 * scripts/check-user-data-dir.sh (the dev bundle in verify.yml, the signed
 * release in release.yml): Playwright cannot attach to a fused build.
 */

test.skip(process.platform !== "darwin", "CFFIXED_USER_HOME is macOS's");

test("an unpackaged run opens <appData>/infinitary-dev, never the release's folder", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const home = realpathSync(scratchDir("infinitary-flavor-home-"));
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

    const appSupport = join(home, "Library", "Application Support");
    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    expect(realpathSync(userData)).toBe(join(appSupport, "infinitary-dev"));
    expect(existsSync(join(appSupport, "infinitary-dev", "firstmate.db"))).toBe(true);
    expect(readdirSync(appSupport)).not.toContain("infinitary");
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    ).toBe(false);
  } finally {
    await closeApp(app);
  }
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
