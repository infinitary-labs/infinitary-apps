import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { scratchDir } from "../helpers/scratchDirs";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";

import { addFromSetupCard, projectLine } from "./projects";
import { ADOPT_REPO_PROMPT_MARKER, projectSetup } from "./scenarios/projectSetup";

// Each journey owns a disposable folder and app. The real agent setup tool,
// registry, history and Settings result are exercised without a real account.
for (const initialized of [true, false]) {
  test(
    initialized
      ? "adding a folder with staged files creates only empty initial history"
      : "adding a plain folder leaves its files untracked",
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
    async ({}, testInfo) => {
      const launched = await launchApp({ scenarios: [projectSetup], withMockProvider: true });
      try {
        const { page, homeDir } = launched;
        const dir = scratchDir("infinitary-project-safety-");
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", dir, ...args], {
            encoding: "utf8",
            env: hostEnv({
              HOME: homeDir,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_PARAMETERS: "'commit.gpgsign=false' 'core.hooksPath=/dev/null'",
            }),
          });
        writeFileSync(join(dir, "partial.txt"), "staged version\n");
        writeFileSync(join(dir, "untracked.txt"), "untracked content\n");
        if (initialized) {
          git("init", "-q", "-b", "main");
          writeFileSync(join(dir, "removed.txt"), "staged then removed\n");
          git("add", "partial.txt", "removed.txt");
          writeFileSync(join(dir, "partial.txt"), "unstaged version\n");
          unlinkSync(join(dir, "removed.txt"));
        }
        const before = {
          staged: initialized ? git("ls-files", "--stage") : "",
          status: initialized ? git("status", "--short") : null,
          partial: readFileSync(join(dir, "partial.txt"), "utf8"),
          untracked: readFileSync(join(dir, "untracked.txt"), "utf8"),
        };

        await askFirstmate(page, `${ADOPT_REPO_PROMPT_MARKER}${dir}`);
        await addFromSetupCard(page, basename(dir));
        await expect
          .poll(
            () =>
              page.evaluate(async (path) => {
                return (await window.infinitary.repos.list()).find((repo) => repo.path === path);
              }, dir),
            { timeout: 30_000 },
          )
          .toBeTruthy();
        const repos = await page.evaluate(() => window.infinitary.repos.list());
        const repo = repos.find((row) => row.path === dir);
        if (!repo) throw new Error("The added project must be registered");
        expect(repo).toMatchObject({ setupKind: "adopt", delivery: "local-only", autonomy: false });
        const after = {
          commitCount: git("rev-list", "--count", "HEAD").trim(),
          committedFiles: git("ls-tree", "-r", "--name-only", "HEAD"),
          staged: git("ls-files", "--stage"),
          status: git("status", "--short"),
          partial: readFileSync(join(dir, "partial.txt"), "utf8"),
          untracked: readFileSync(join(dir, "untracked.txt"), "utf8"),
        };
        expect(after.commitCount).toBe("1");
        expect(after.committedFiles).toBe("");
        expect(after.staged).toBe(before.staged);
        expect(after.partial).toBe(before.partial);
        expect(after.untracked).toBe(before.untracked);
        expect(after.status).toBe(before.status ?? "?? partial.txt\n?? untracked.txt\n");

        // A repeated add must not consume the index or create more history.
        const head = git("rev-parse", "HEAD");
        await askFirstmate(page, `${ADOPT_REPO_PROMPT_MARKER}${dir}`);
        expect(git("rev-parse", "HEAD")).toBe(head);
        expect(git("ls-files", "--stage")).toBe(before.staged);
        expect(
          (await page.evaluate(() => window.infinitary.repos.list())).filter(
            (row) => row.path === dir,
          ),
        ).toHaveLength(1);

        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("tab", { name: "Projects" }).click();
        await expect(projectLine(page, repo.id)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("project-settings.png") });
        const evidence = testInfo.outputPath("project-state.json");
        writeFileSync(
          evidence,
          JSON.stringify({ repo, before, after, repeatHeadUnchanged: true }, null, 2),
        );
        await testInfo.attach("Project folder and history", {
          path: evidence,
          contentType: "application/json",
        });
      } finally {
        await launched.close();
      }
    },
  );
}
