import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { writeStarterSession } from "../../src/core/update/devStarter";
import * as m from "../../src/shared/i18n/messages.generated";
import { UPDATE_STEP_WORDS, UPDATE_WORDS } from "../../src/shared/updateWords";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { regionShot } from "./pictures";
import { runFromSearch } from "./windowKeys";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();

// INF-5635's approved plan, piece 2: an app pnpm dev's starter started offers
// Update and restart when main has newer commits, reached by keys, and hands
// the update to the starter: it leaves its request naming both commits and ends.
// Fixture: a throwaway project where it lives (a bare repository) and a clone of
// it one commit behind, a starter folder the test writes as the starter does,
// and an isolated app. The starter itself is tests/dev-starter.test.ts's.
// Completion: the request in the starter folder and the app's own exit.
test("a copy run from source updates from the keyboard, handing the update to its starter", async () => {
  const base = scratchDir("infinitary-source-journey-");
  const seed = join(base, "seed");
  git(base, "init", "--quiet", "--initial-branch=main", seed);
  writeFileSync(join(seed, "README.md"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "first");
  const remote = join(base, "remote.git");
  git(base, "clone", "--quiet", "--bare", seed, remote);
  const copy = join(base, "copy");
  git(base, "clone", "--quiet", remote, copy);
  const from = git(copy, "rev-parse", "HEAD");
  writeFileSync(join(seed, "README.md"), "two\n");
  git(seed, "commit", "--quiet", "-am", "second");
  git(seed, "push", "--quiet", remote, "main");
  const to = git(seed, "rev-parse", "HEAD");

  const starter = scratchDir("infinitary-source-starter-");
  writeStarterSession(starter, { root: copy, commit: from, edited: false, lockDigest: "" });
  const launched = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_DEV_STARTER: starter },
  });
  const { app, page } = launched;
  try {
    await runFromSearch(app, page, "updates.show");
    const panel = page.locator("[data-update-channel]");
    await expect(panel.locator("[data-update-line]")).toContainText(
      m.updateSourceAvailable({ branch: "main", count: 1, commit: to.slice(0, 7) }),
    );
    await expect(panel.locator("[data-update-line]")).toContainText(UPDATE_STEP_WORDS.restarts);
    await expect(panel).toContainText(m.shellUpdateSource({ branch: "main" }));
    // Check for updates comes first, then the next step.
    await expect(panel.getByRole("button", { name: UPDATE_WORDS.check })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: UPDATE_WORDS.restart })).toBeFocused();
    await regionShot(panel, test.info().outputPath("source-update-offer-dark.png"));
    expect(existsSync(join(starter, "update.json"))).toBe(false);

    const child = app.process();
    const exited = once(child, "exit");
    await page.keyboard.press("Enter");
    await exited;
    expect(JSON.parse(readFileSync(join(starter, "update.json"), "utf8"))).toEqual({ from, to });
    // The app leaves moving the copy to its starter.
    expect(git(copy, "rev-parse", "HEAD")).toBe(from);
  } finally {
    await launched.close();
  }
});
