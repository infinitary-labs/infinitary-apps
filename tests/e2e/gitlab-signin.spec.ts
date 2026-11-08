import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { projectSignInWords } from "../../src/renderer/src/settings/addProjectWords";
import {
  FORGE_BROWSER_WORDS,
  FORGE_SECTION_WORDS,
  forgeKeyPage,
  forgeKeyProblemText,
  forgeStartProblemText,
  GITLAB,
} from "../../src/shared/forges";
import { scratchDir } from "../helpers/scratchDirs";
import {
  GITLAB_STUB_APPLICATION,
  GITLAB_STUB_APPLICATION_NO_DEVICE,
  GITLAB_STUB_KEY,
  GITLAB_STUB_LOGIN,
  GITLAB_STUB_PROJECT,
  GITLAB_STUB_USER_CODE,
  startGitLabStub,
} from "./gitlabStub";
import { redirectGitClone } from "./homeFixtures";
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
    redirectGitClone(home, `https://${host}/${GITLAB_STUB_PROJECT}.git`, source);
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
      if (host === "gitlab.com") {
        await pressKey(page.getByRole("tab", { name: "Projects", exact: true }), "Enter");
        const add = page.locator("[data-add-project]");
        await pressKey(add.getByRole("button", { name: "GitLab repo", exact: true }), "Enter");
        await pressKey(
          add.getByRole("button", { name: projectSignInWords(GITLAB.name), exact: true }),
          "Enter",
        );
      } else {
        await page.getByRole("tab", { name: "Integrations", exact: true }).click();
        await pressKey(
          page.getByRole("button", { name: `Sign in to ${GITLAB.name}`, exact: true }),
          "Enter",
        );
      }
      const section = page.locator("[data-integrations]");
      if (evidence && host === "gitlab.com")
        await regionShot(section, join(evidence, "projects-after.png"));
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
          await heroShot(launched.app, page, { region: section, name: "gitlab-sign-in" });
      }
      await pressKey(page.getByRole("tab", { name: "Projects", exact: true }), "Enter");
      await expect(
        page.locator("[data-forges] [data-forge-row], [data-forges] [data-forge-chip]"),
      ).toHaveCount(0);
      const add = page.locator("[data-add-project]");
      const name = host === "gitlab.com" ? "GitLab" : host;
      const choose = add.getByRole("button", { name: `${name} repo`, exact: true });
      if ((await choose.getAttribute("aria-expanded")) !== "true") await pressKey(choose, "Enter");
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

/**
 * The captain could not sign in to gitlab.com with browser sign-in and saw
 * one generic message (INF-1671): GitLab leaves Device authorization grant
 * off on a new application and refuses it as `access_denied`, and an ID it
 * does not know is a 404. Setup names the missing step, the form says which
 * reason GitLab gave, and an application set up that way gets its code.
 */
test("browser sign-in to gitlab.com names the setting GitLab refused and then shows a code", async () => {
  const home = scratchDir("fm-gitlab-browser-home-");
  const userDataDir = scratchDir("fm-gitlab-browser-data-");
  const stub = await startGitLabStub("gitlab.com");
  const launched = await launchApp({
    homeDir: home,
    userDataDir,
    withMockProvider: true,
    env: stub.env,
  });
  try {
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await pressKey(page.getByRole("tab", { name: "Projects", exact: true }), "Enter");
    const add = page.locator("[data-add-project]");
    await pressKey(add.getByRole("button", { name: "GitLab repo", exact: true }), "Enter");
    await pressKey(
      add.getByRole("button", { name: projectSignInWords(GITLAB.name), exact: true }),
      "Enter",
    );
    const form = page.locator("[data-forge-browser-form]");
    await expect(form.getByRole("listitem")).toContainText([FORGE_BROWSER_WORDS.deviceGrant]);
    const application = form.getByLabel(FORGE_BROWSER_WORDS.applicationId);
    const start = form.getByRole("button", { name: FORGE_BROWSER_WORDS.start });
    await application.fill(GITLAB_STUB_APPLICATION_NO_DEVICE);
    await pressKey(start, "Enter");
    await expect(form.getByRole("status")).toHaveText(
      forgeStartProblemText("not-allowed", "gitlab.com"),
    );
    await application.fill(`${GITLAB_STUB_APPLICATION}x`);
    await pressKey(start, "Enter");
    await expect(form.getByRole("status")).toHaveText(
      forgeStartProblemText("not-found", "gitlab.com"),
    );
    await application.fill(GITLAB_STUB_APPLICATION);
    await pressKey(start, "Enter");
    await expect(page.locator("[data-forge-code]")).toHaveText(GITLAB_STUB_USER_CODE);
    expect(
      stub.requests().filter((request) => request.endsWith("/oauth/authorize_device")),
    ).toHaveLength(3);
  } finally {
    await launched.close();
    await stub.close();
  }
});
