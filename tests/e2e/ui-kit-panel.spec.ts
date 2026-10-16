import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { type GitHubStub, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type GitLabStub, seedGitLabSignIn, startGitLabStub } from "./gitlabStub";
import { type LaunchedApp, launchApp } from "./launch";
import { heroShot, regionShot } from "./pictures";

/**
 * Coherence by construction (the talk-to-personalize plan, Step 3): a
 * personal panel builds from `@infinitary/ui`, the app's own components, and
 * an extension written the way a data skill teaches mounts on a rail and
 * paints what its data says, measured here against the built app.
 *
 * The extensions are the real thing - compiled and mounted by the personal
 * extension host from a seeded workspace, exactly as one the captain asked
 * for would be.
 */

test.describe("the fixture extensions the data skills teach", () => {
  let launched: LaunchedApp;
  let github: GitHubStub;
  let gitlab: GitLabStub;

  test.beforeAll(async () => {
    // The real thing: the fixtures are seeded into the personal
    // workspace and the host compiles them - so a skill that taught an
    // import the compiler refuses, or a panel shape that will not render,
    // fails here.
    const userDataDir = scratchDir("infinitary-e2e-skills-");
    const workspace = join(userDataDir, "fleet", "personal");
    mkdirSync(workspace, { recursive: true });
    // The `usage` skill's token-watch has a spec of its own
    // (token-dashboard.spec.ts): with it, both rails here would pass their
    // three-panel cap.
    cpSync(join(process.cwd(), "tests", "fixtures", "personal-skills"), workspace, {
      recursive: true,
      filter: (source) => !source.includes("token-watch"),
    });
    // The quota fixture reads the app's OWN quota through the declared
    // `quota.snapshot` read (Step 4), so the app's sensor is pointed at a
    // fixture carrying the three states the honesty rules are about: a real
    // reading, a carried-forward one, and one the sensor could not measure.
    const quotaFixtureDir = scratchDir("infinitary-quota-fixture-");
    writeFileSync(
      join(quotaFixtureDir, "snapshot.json"),
      JSON.stringify({
        generatedAt: "2026-09-18T00:00:00.000Z",
        providers: [
          {
            provider: "claude",
            label: "Claude",
            accountLabel: "Personal",
            status: "ok",
            stale: false,
            windows: [
              {
                id: "session",
                label: "session",
                percentRemaining: 62,
                pace: "behind",
                resetText: "resets 18:00",
              },
              {
                id: "weekly",
                label: "weekly",
                percentRemaining: 34,
                pace: "ahead",
                resetText: "resets Fri",
              },
            ],
          },
          {
            provider: "grok",
            label: "Grok",
            accountLabel: "Work",
            status: "ok",
            stale: true,
            measuredAt: Date.now() - 3 * 60 * 60 * 1000,
            windows: [{ id: "premium", label: "premium", pace: "unknown" }],
          },
          {
            provider: "codex",
            label: "Codex",
            accountLabel: "Team",
            status: "not_measured",
            stale: false,
            detail: "Signed in; this account exposed no usage window on that read.",
            windows: [],
          },
        ],
      }),
    );
    // The proposed-changes fixture reads the app's OWN `forge.changes` read,
    // which the app answers from GitHub with its in-app sign-in (git
    // integration PR 1.2): a local stand-in for GitHub and a sign-in made.
    github = await startGitHubStub();
    github.setOpenChanges([
      { number: 186, title: "Fix provider-qualified spawn model pins", checks: "SUCCESS" },
      { number: 184, title: "Shrink dock after group collapse", checks: "PENDING" },
      { number: 111, title: "Let a retry unlock the login store", checks: "FAILURE", draft: true },
    ]);
    seedGitHubSignIn(userDataDir);
    // And a merge request the captain opened on GitLab, whose pipeline
    // passed, read with the key he made there.
    gitlab = await startGitLabStub("gitlab.com");
    gitlab.headOf(() => "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    gitlab.openMergeRequest({ branch: "notes-sync", title: "Sync the field notes on time" });
    seedGitLabSignIn(userDataDir, "gitlab.com");
    launched = await launchApp({
      userDataDir,
      env: { INFINITARY_QUOTA_FIXTURE_DIR: quotaFixtureDir, ...github.env, ...gitlab.env },
    });
    await expect
      .poll(
        async () =>
          launched.page.evaluate(() =>
            window.infinitary.plugins.personal
              .list()
              .then((snapshot) =>
                snapshot.extensions.map((extension) => [
                  extension.id,
                  extension.error?.message ?? "compiled",
                ]),
              ),
          ),
        { timeout: 60_000 },
      )
      .toEqual([
        ["crew-reports", "compiled"],
        ["open-prs", "compiled"],
        ["quota-glance", "compiled"],
        ["tokyo-clock", "compiled"],
      ]);
  });

  test.afterAll(async () => {
    await launched.close();
    await github.close();
    await gitlab.close();
  });

  test("each one mounts on a rail and paints what its data says", async () => {
    const { page } = launched;

    // Three panels on the app's own reads (quota, the feed, the captain's
    // open proposed changes on GitHub and GitLab), fed by the app itself.
    const openPrs = page.locator('[data-side-panel="open-prs"]');
    await expect(openPrs).toBeVisible({ timeout: 30_000 });
    await expect(openPrs.getByText("Fix provider-qualified spawn model pins")).toBeVisible();
    await expect(openPrs.getByText("#186")).toBeVisible();
    await expect(openPrs.getByText("draft")).toBeVisible();
    // The merge request on GitLab is a row too, under GitLab's own name for it.
    await expect(openPrs.getByText("Sync the field notes on time")).toBeVisible();
    await expect(openPrs.getByText("!1", { exact: true })).toBeVisible();
    const pictures = process.env.INFINITARY_GITLAB_PICTURES;
    if (pictures) {
      await regionShot(openPrs, join(pictures, "open-changes-panel.png"));
      await heroShot(page, { region: openPrs, name: "gitlab-open-changes" });
    }

    const quota = page.locator('[data-side-panel="quota-glance"]');
    await expect(quota.getByText("62%")).toBeVisible();
    // Unknown is never zero, and a carried-forward reading says its age.
    await expect(quota.getByText("–")).toBeVisible();
    await expect(quota.getByText("as of 3h ago")).toBeVisible();
    await expect(
      quota.getByText("Signed in; this account exposed no usage window on that read."),
    ).toBeVisible();

    // A fresh app has no crewmate reports yet: the slice's honest empty
    // state, from the real feed read, never invented lines.
    const reports = page.locator('[data-side-panel="crew-reports"]');
    await expect(reports.getByText("No reports yet")).toBeVisible();

    const clock = page.locator('[data-side-panel="tokyo-clock"]');
    await expect(clock.getByText(/^\d\d:\d\d$/)).toBeVisible();

    // The host owns the chrome: the title comes from the manifest and the
    // panel is marked as the captain's own, not by a plugin name.
    await expect(openPrs.getByText("Open changes")).toBeVisible();
    await expect(openPrs.locator("[data-side-panel-attribution]")).toHaveText("yours");
  });
});
