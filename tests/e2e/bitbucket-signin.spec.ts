import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ADD_PROJECT_WORDS,
  notAllListedWords,
  projectSignInWords,
} from "../../src/renderer/src/settings/addProjectWords";
import {
  BITBUCKET,
  FORGE_SECTION_WORDS,
  forgeKeyIntro,
  forgeKeyPage,
  forgeKeyPlace,
  forgeKeyProblemText,
  forgeKeyScopesText,
  forgeRefusedText,
  forgeSignInTitle,
} from "../../src/shared/forges";
import { scratchDir } from "../helpers/scratchDirs";
import {
  BITBUCKET_STUB_KEY,
  BITBUCKET_STUB_LOGIN,
  BITBUCKET_STUB_NEW_KEY,
  BITBUCKET_STUB_PROJECT,
  BITBUCKET_STUB_UNLISTED,
  startBitbucketStub,
} from "./bitbucketStub";
import { cardBody } from "./frames";
import { redirectGitClones } from "./homeFixtures";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { expectNoCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * INF-5192, the captain's "adding bitbucket as another forge integration
 * just like github and gitlab": the captain signs in to Bitbucket Cloud
 * with an API token through real Settings and HTTP, sees a refused token
 * kept nowhere, lists the projects of its workspaces and clones one with
 * real git, adds a project the listing could not reach by its link, then
 * signs in again with a new token once Bitbucket refuses the first, all with
 * throwaway state against a local stand-in.
 */
test("signs in to Bitbucket with an API token, refuses a bad one, clones a listed project and an unlisted one by its link, and signs in again once the token is revoked", async () => {
  const home = scratchDir("fm-bitbucket-home-");
  const userDataDir = scratchDir("fm-bitbucket-data-");
  const sources = scratchDir("fm-bitbucket-source-");
  const gitProject = (name: string) => {
    const path = join(sources, name);
    execFileSync("git", ["init", "-q", "-b", "main", path]);
    execFileSync("git", [
      "-C",
      path,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--allow-empty",
      "-m",
      `test: initial ${name}`,
    ]);
    return path;
  };
  const source = gitProject("field-notes");
  const origin = `https://bitbucket.org/${BITBUCKET_STUB_PROJECT}.git`;
  // The archive's oldest project, which the listing never reaches, clones by its link.
  const unlistedSource = gitProject("old-12");
  const unlistedLink = `https://bitbucket.org/${BITBUCKET_STUB_UNLISTED}`;
  redirectGitClones(home, [
    { origin, local: source },
    { origin: `${unlistedLink}.git`, local: unlistedSource },
    { origin: unlistedLink, local: unlistedSource },
  ]);
  const stub = await startBitbucketStub();
  const launched = await launchApp({
    homeDir: home,
    userDataDir,
    withMockProvider: true,
    env: { ...stub.env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  const evidence = process.env.INFINITARY_BITBUCKET_PICTURES;
  try {
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await pressKey(page.getByRole("tab", { name: "Projects", exact: true }), "Enter");
    const add = page.locator("[data-add-project]");
    const choose = add.getByRole("button", { name: "Bitbucket repo", exact: true });
    if (evidence) await regionShot(add, join(evidence, "add-project-after.png"));
    await pressKey(choose, "Enter");
    await pressKey(
      add.getByRole("button", { name: projectSignInWords(BITBUCKET.name), exact: true }),
      "Enter",
    );
    const section = page.locator("[data-integrations]");
    const form = section.locator("[data-forge-key-form]");
    const address = form.getByLabel(FORGE_SECTION_WORDS.address);
    const key = form.getByLabel(FORGE_SECTION_WORDS.key);
    // The form starts at bitbucket.org and names the scopes Atlassian's page cannot tick.
    await expect(key).toBeFocused();
    await expect(address).toHaveValue("bitbucket.org");
    await expect(form.locator("[data-forge-key-scopes]")).toHaveText(
      forgeKeyScopesText("bitbucket") ?? "",
    );
    // Opening the token page is a recorded browser open, not a real sign-in.
    await launched.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    // The form sends the person to their Atlassian account, where Bitbucket's tokens are made.
    // Its first clause; the rest names this computer as the window says it.
    await expect(form).toContainText(forgeKeyIntro("bitbucket.org", BITBUCKET).split(",")[0] ?? "");
    expect(forgeKeyPlace("bitbucket", "bitbucket.org")).toBe("id.atlassian.com");
    await pressKey(
      form.getByRole("button", {
        name: `Make a key on ${forgeKeyPlace("bitbucket", "bitbucket.org")}`,
      }),
      "Enter",
    );
    await expect
      .poll(() =>
        launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []),
      )
      .toEqual([forgeKeyPage("bitbucket", "bitbucket.org")]);
    if (evidence) await regionShot(form, join(evidence, "key-form-after.png"));
    if (evidence) {
      // The release note's pair: the form under the chip that opened it, at a narrower window.
      await resizeWindow(launched.app, page, { width: 1000, height: 800 });
      await heroShot(launched.app, page, {
        region: form,
        anchors: [section.locator('[data-connect-chips="foot"]')],
        name: "bitbucket-sign-in",
      });
      await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    }
    await key.fill("ATATT3xFfGF0refused_token-0000=FFFF0000");
    await pressKey(key, "Enter");
    await expect(form.getByRole("status")).toHaveText(
      forgeKeyProblemText("refused", "bitbucket.org", BITBUCKET),
    );
    expect(existsSync(join(userDataDir, "forges", "bitbucket.org"))).toBe(false);
    await key.fill(BITBUCKET_STUB_KEY);
    await pressKey(key, "Enter");
    await expect(form).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.forges.list()))
      .toMatchObject({
        signIns: [
          { host: "bitbucket.org", login: BITBUCKET_STUB_LOGIN, state: "ok", server: BITBUCKET },
        ],
      });
    const bitbucketRow = section.locator('[data-integration-row="bitbucket"]');
    await expect(bitbucketRow).toContainText(BITBUCKET_STUB_LOGIN);
    expect(
      JSON.stringify(await page.evaluate(() => window.infinitary.forges.list())),
    ).not.toContain(BITBUCKET_STUB_KEY);
    expect(
      JSON.stringify(await page.evaluate(() => window.infinitary.integrations.list())),
    ).not.toContain(BITBUCKET_STUB_KEY);
    expect(readFileSync(join(userDataDir, "forges", "health.log"), "utf8")).not.toContain(
      BITBUCKET_STUB_KEY,
    );
    if (evidence) await regionShot(bitbucketRow, join(evidence, "integration-row-after.png"));

    // Each workspace's newest projects are listed, newest first, and one clones with git.
    await pressKey(page.getByRole("tab", { name: "Projects", exact: true }), "Enter");
    const listing = add.getByRole("button", { name: "Bitbucket repo", exact: true });
    if ((await listing.getAttribute("aria-expanded")) !== "true") await pressKey(listing, "Enter");
    for (const project of ["field-team/survey-app", "octo/dotfiles", BITBUCKET_STUB_PROJECT])
      await expect(add.getByText(project, { exact: false })).toBeVisible();
    // An old workspace has more pages than the listing reads: Add project
    // says not every project was checked, and its oldest is not listed.
    await expect(add.locator("[data-add-project-not-all-listed]")).toHaveText(
      notAllListedWords(BITBUCKET.name),
    );
    await expect(add.getByText(BITBUCKET_STUB_UNLISTED, { exact: false })).toHaveCount(0);
    if (evidence) await regionShot(add, join(evidence, "projects-after.png"));
    const row = add
      .locator("div", { has: page.getByText(BITBUCKET_STUB_PROJECT, { exact: false }) })
      .last();
    await pressKey(row.getByRole("button", { name: "Add", exact: true }), "Enter");
    await expect(page.locator("[data-repository-notice]")).toContainText("Added field-notes.");
    const repos = await page.evaluate(() => window.infinitary.repos.list());
    const project = repos.find((entry) => entry.name === "field-notes");
    expect(project).toMatchObject({
      setupKind: "clone",
      origin,
      host: { kind: "bitbucket", name: "bitbucket.org" },
    });
    if (!project) throw new Error("The cloned project is missing");
    expect(
      execFileSync("git", ["-C", project.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    // The project the listing left out is added by pasting its link, from
    // Add project on the projects list the added project's page leads back to.
    await pressKey(page.getByRole("button", { name: "Projects", exact: true }), "Enter");
    const listingAgain = add.getByRole("button", { name: "Bitbucket repo", exact: true });
    if ((await listingAgain.getAttribute("aria-expanded")) !== "true")
      await pressKey(listingAgain, "Enter");
    const link = add.getByLabel(ADD_PROJECT_WORDS.orPasteLink(BITBUCKET.name));
    await link.fill(unlistedLink);
    await pressKey(link, "Enter");
    await expect(page.locator("[data-repository-notice]")).toContainText("Added old-12.");
    const unlisted = (await page.evaluate(() => window.infinitary.repos.list())).find(
      (entry) => entry.name === "old-12",
    );
    expect(unlisted).toMatchObject({
      setupKind: "clone",
      host: { kind: "bitbucket", name: "bitbucket.org" },
    });
    if (!unlisted) throw new Error("The project added by its link is missing");
    expect(
      execFileSync("git", ["-C", unlisted.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe(
      execFileSync("git", ["-C", unlistedSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    expect(stub.requests()).toEqual(
      expect.arrayContaining([
        "GET /2.0/user",
        "GET /2.0/user/workspaces",
        "GET /2.0/repositories/octo",
        "GET /2.0/repositories/field-team",
      ]),
    );

    // The person revokes the token on Atlassian's page: the next Bitbucket
    // read is refused, the app asks Bitbucket who the token is, and one card
    // asks to sign in again. A new token from the row takes the card down.
    const signInAgain = forgeSignInTitle(BITBUCKET.name);
    stub.revokeFirstKey();
    await pressKey(page.getByRole("button", { name: "Back", exact: true }), "Enter");
    await page.evaluate(() => window.infinitary.forges.projects("bitbucket.org").catch(() => []));
    await expect(shownCard(page, signInAgain)).toBeVisible({ timeout: 30_000 });
    // It names what stops on Bitbucket: the pull requests the app opens, checks and merges there.
    await expect(cardBody(page, signInAgain).locator("p").first()).toHaveText(
      forgeRefusedText(BITBUCKET.name),
    );
    if (evidence)
      await regionShot(shownCard(page, signInAgain), join(evidence, "sign-in-again-card.png"));
    await pressKey(page.getByRole("button", { name: "Settings", exact: true }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Integrations", exact: true }), "Enter");
    await expect(bitbucketRow).toHaveAttribute("data-integration-state", "needs_reauth");
    await pressKey(bitbucketRow.getByRole("button", { name: "Sign in again" }), "Enter");
    await expect(address).toHaveValue("bitbucket.org");
    await key.fill(BITBUCKET_STUB_NEW_KEY);
    await pressKey(key, "Enter");
    await expect(bitbucketRow).toHaveAttribute("data-integration-state", "ok");
    await page.keyboard.press("Escape");
    await expectNoCard(page, signInAgain);
    expect(
      readFileSync(join(userDataDir, "forges", "health.log"), "utf8")
        .split("\n")
        .filter((line) => line.includes("bitbucket.org sign-in"))
        .map((line) => line.replace(/^\S+ /, "").replace(/ \(.*$/, "")),
    ).toEqual([
      "bitbucket.org sign-in none -> ok",
      "bitbucket.org sign-in ok -> needs_reauth",
      "bitbucket.org sign-in needs_reauth -> ok",
    ]);
  } finally {
    await launched.close();
    await stub.close();
  }
});
