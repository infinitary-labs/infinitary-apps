import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  FORGE_BROWSER_WORDS,
  FORGE_SECTION_WORDS,
  forgeKeyPage,
  forgeKeyProblemText,
  GITLAB,
} from "../../src/shared/forges";
import { scratchDir } from "../helpers/scratchDirs";
import {
  GITLAB_STUB_KEY,
  GITLAB_STUB_LOGIN,
  GITLAB_STUB_PROJECT,
  startGitLabStub,
} from "./gitlabStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { pressKey } from "./windowKeys";

/** The captain signs in and clones through real Settings, HTTP and git, using throwaway state. */
for (const host of ["gitlab.com", "gitlab.example.com"]) {
  test(`signs in to ${host} by keys, refuses an invalid key and clones a project in a subgroup`, async () => {
    const home = scratchDir("fm-gitlab-home-");
    const userDataDir = scratchDir("fm-gitlab-data-");
    const source = join(scratchDir("fm-gitlab-source-"), "field-notes");
    execFileSync("git", ["init", "-q", "-b", "main", source]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "test: initial project",
    ]);
    writeFileSync(
      join(home, ".gitconfig"),
      `[url "${source}"]\n\tinsteadOf = https://${host}/${GITLAB_STUB_PROJECT}.git\n`,
    );
    const stub = await startGitLabStub(host);
    const launched = await launchApp({
      homeDir: home,
      userDataDir,
      withMockProvider: true,
      env: { ...stub.env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
    });
    const evidence = process.env.INFINITARY_GITLAB_PICTURES;
    try {
      const { page } = launched;
      await resizeWindow(launched.app, page, { width: 1280, height: 800 });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Projects", exact: true }).click();
      const section = page.locator("[data-forges]");
      if (evidence && host === "gitlab.com")
        await regionShot(section, join(evidence, "projects-after.png"));
      await pressKey(
        section.getByRole("button", { name: `Sign in to ${GITLAB.name}`, exact: true }),
        "Enter",
      );
      await pressKey(section.getByRole("button", { name: FORGE_BROWSER_WORDS.useKey }), "Enter");
      const form = section.locator("[data-forge-key-form]");
      // The public chip starts on gitlab.com; its address also accepts a self-hosted server.
      const address = form.getByLabel(FORGE_SECTION_WORDS.address);
      const key = form.getByLabel(FORGE_SECTION_WORDS.key);
      await expect(key).toBeFocused();
      await address.fill(host);
      // Opening the key page is a recorded browser open, not a real sign-in.
      const opened: string[] = [];
      await launched.app.evaluate(({ shell }) => {
        shell.openExternal = async (url: string) => {
          (globalThis as unknown as { gitlabOpened: string[] }).gitlabOpened ??= [];
          (globalThis as unknown as { gitlabOpened: string[] }).gitlabOpened.push(url);
        };
      });
      await pressKey(form.getByRole("button", { name: `Make a key on ${host}` }), "Enter");
      opened.push(
        ...(await launched.app.evaluate(
          () => (globalThis as unknown as { gitlabOpened: string[] }).gitlabOpened,
        )),
      );
      expect(opened).toEqual([forgeKeyPage("gitlab", host)]);
      if (evidence) await regionShot(section, join(evidence, `${host}-key-form.png`));
      await key.fill("glpat-refused-key-12345");
      await pressKey(key, "Enter");
      await expect(form.getByRole("status")).toHaveText(
        forgeKeyProblemText("refused", host, GITLAB),
      );
      expect(existsSync(join(userDataDir, "forges", host))).toBe(false);
      if (evidence) await regionShot(section, join(evidence, `${host}-refused.png`));
      await key.fill(GITLAB_STUB_KEY);
      await pressKey(key, "Enter");
      await expect(form).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => window.infinitary.forges.list()))
        .toMatchObject({
          signIns: [{ host, login: GITLAB_STUB_LOGIN, state: "ok", server: GITLAB }],
        });
      expect(
        JSON.stringify(await page.evaluate(() => window.infinitary.forges.list())),
      ).not.toContain(GITLAB_STUB_KEY);
      expect(readFileSync(join(userDataDir, "forges", "health.log"), "utf8")).not.toContain(
        GITLAB_STUB_KEY,
      );
      if (evidence) {
        await regionShot(section, join(evidence, `${host}-signed-in.png`));
        if (host === "gitlab.com")
          await heroShot(page, { region: section, name: "gitlab-sign-in" });
      }
      const add = page.locator("[data-add-project]");
      const name = host === "gitlab.com" ? "GitLab" : host;
      await pressKey(add.getByRole("button", { name: `${name} repo`, exact: true }), "Enter");
      await expect(add.getByText(GITLAB_STUB_PROJECT, { exact: false })).toBeVisible();
      if (evidence) await regionShot(add, join(evidence, `${host}-projects.png`));
      await pressKey(add.getByRole("button", { name: "Add", exact: true }).first(), "Enter");
      await expect(add.getByRole("status")).toContainText("Added field-notes.");
      const repos = await page.evaluate(() => window.infinitary.repos.list());
      const project = repos.find((row) => row.name === "field-notes");
      expect(project).toMatchObject({
        setupKind: "clone",
        origin: `https://${host}/${GITLAB_STUB_PROJECT}.git`,
        host: { kind: "gitlab", name: host },
      });
      if (!project) throw new Error("The cloned project is missing");
      expect(
        execFileSync("git", ["-C", project.path, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      expect(stub.requests()).toContain("GET /api/v4/projects");
      expect(stub.requests()).toContain("GET /api/v4/user");
    } finally {
      await launched.close();
      await stub.close();
    }
  });
}
