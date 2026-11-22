import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { presentationMarkdownText } from "../../src/core/forge/presentation";
import {
  MERGE_LINE_MARK,
  MERGE_SETTING_WORDS,
  mergedWords,
} from "../../src/core/orchestrator/settleWords";
import { openDatabase } from "../../src/core/storage/db";
import type { RiskDimension } from "../../src/shared/cards";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { GITLAB_STUB_PROJECT, seedGitLabSignIn, startGitLabStub } from "./gitlabStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { MOCK_RISK, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, readyRegion, regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  DESTINATION_STORY_MARKER,
  DESTINATION_STORY_TITLE,
  destinationStory,
} from "./scenarios/destinationStory";
import { cardScroller, factsStrip, riskChart, shownCard, stageAtRest } from "./stack";

/**
 * INF-1965: every destination's completion carries the saved story, radar and merge line.
 * Each journey owns a disposable git project and host readings, then commissions a real
 * task through the app, publishes its story and merges only through the existing consent.
 * Hosted descriptions must read back the story; branches and local work must merge the
 * committed change without a fabricated request number. With autonomy on, the app merges
 * from the same merge card on its own (INF-2744); the card stays off the stack as the
 * story note until its merge has a result, then shows once with its story and merged line
 * (INF-2533).
 * The hermetic launcher and disposable GitHub/GitLab services are its only prerequisites;
 * no sign-in, account, keychain or resource is shared with another journey.
 */
const why = MOCK_GITHUB_STORY.why[0];
if (!why) throw new Error("The story fixture needs its reason.");

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

for (const kind of ["enterprise", "gitlab", "plain", "local"] as const) {
  for (const note of [false, true]) {
    test(`${kind}: the saved ${note ? "note" : "offer"} carries the story through its merge`, async () => {
      test.setTimeout(3 * 60_000);
      const userDataDir = scratchDir("infinitary-story-destination-");
      const host =
        kind === "enterprise"
          ? "github.example.com"
          : kind === "gitlab"
            ? "gitlab.example.com"
            : "git.example.test";
      const fullName = kind === "gitlab" ? GITLAB_STUB_PROJECT : "octo/meterlab";
      const origin = `https://${host}/${fullName}.git`;
      const dir = join(userDataDir, "meterlab");
      const bare = join(userDataDir, "host.git");
      git("init", "--initial-branch=main", dir);
      git("-C", dir, "config", "user.name", "Test");
      git("-C", dir, "config", "user.email", "test@localhost");
      git("-C", dir, "commit", "--allow-empty", "-m", "chore: seed the meter");
      // Even local-only has an origin: delivery policy, not origin presence, owns its route.
      git("init", "--bare", "--initial-branch=main", bare);
      git("-C", dir, "remote", "add", "origin", origin);
      git("-C", dir, "config", `url.${bare}.insteadOf`, origin);
      git("-C", dir, "push", "origin", "HEAD:refs/heads/main");
      git("-C", dir, "fetch", "origin");
      const initial = git("-C", bare, "rev-parse", "main");
      const db = openDatabase(userDataDir);
      seedProject(db, {
        id: "repo-meterlab",
        path: dir,
        name: "meterlab",
        setupKind: "init",
        origin,
        runsOn: null,
        delivery: kind === "local" ? "local-only" : "direct-pr",
        autonomy: note,
        rigor: "quick",
        addedAt: 1,
      });
      db.close();
      const github = kind === "enterprise" ? await startGitHubStub({ host }) : undefined;
      const gitlab = kind === "gitlab" ? await startGitLabStub(host) : undefined;
      const stub = github ?? gitlab;
      stub?.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
      const githubSignIn = "ghp_e2e_enterprise_key_0123456789";
      if (kind === "enterprise") seedGitHubSignIn(userDataDir, githubSignIn, host);
      if (kind === "gitlab") seedGitLabSignIn(userDataDir, host);
      const launched = await launchApp({
        withMockProvider: true,
        scenarios: [destinationStory(kind === "local")],
        userDataDir,
        env: stub?.env,
      });
      try {
        const { page } = launched;
        await resizeWindow(launched.app, page, { width: 1280, height: 1000 });
        const input = promptInput(page);
        const title = `meterlab ${DESTINATION_STORY_MARKER}`;
        await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await input.press("Enter");
        const card = shownCard(page, DESTINATION_STORY_TITLE);
        const frame = cardBody(page, DESTINATION_STORY_TITLE);
        const merge = card.getByRole("button", {
          name: MERGE_WORDS[kind === "local" ? "land" : "merge-pr"],
          exact: true,
        });
        const risk = riskChart(page);
        const showStoryTop = async () => {
          await stageAtRest(page);
          // The radar moves with the body's scroll, inside its fixed chart box.
          // Prepare the same top-of-story state as the before pictures and read a visible dot.
          await cardScroller(page).evaluate((scroller) => {
            scroller.scrollTop = 0;
          });
          await expect(risk.dot("blast")).toBeInViewport();
          await readyRegion(risk.chart);
        };
        const showsStory = async () => {
          await expect(frame.locator("body")).toContainText(why);
          await expect(risk.chart).toBeVisible();
          for (const [dimension, rating] of Object.entries(MOCK_RISK))
            await expect(risk.dot(dimension as RiskDimension)).toHaveAttribute(
              "data-risk-level",
              rating.level,
            );
          await expect(factsStrip(frame).project).toHaveText("meterlab");
        };
        const storyTask = async () =>
          (await page.evaluate(() => window.infinitary.cards.list())).find(
            (entry) => entry.title === DESTINATION_STORY_TITLE,
          )?.taskId;
        if (note) {
          // INF-2744: the crewmate shows its merge card as any task does, and with
          // autonomy on the app merges from it on its own, with no click or typed
          // request; the card waits off the stack as the story note until then (INF-2533).
          await expect
            .poll(
              async () => {
                const id = await storyTask();
                return id
                  ? (await page.evaluate((task) => window.infinitary.tasks.detail(task), id))
                      ?.status
                  : undefined;
              },
              { timeout: 90_000 },
            )
            .toBe("done");
        } else {
          await expect(card).toBeVisible({ timeout: 45_000 });
          await showsStory();
        }
        const cards = await page.evaluate(() => window.infinitary.cards.list());
        const savedCard = cards.find((entry) => entry.title === DESTINATION_STORY_TITLE);
        const taskId = savedCard?.taskId;
        if (!taskId) throw new Error("The saved-story card has no task.");
        const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
        if (kind === "plain" || kind === "local") {
          expect(detail?.delivery?.prNumber).toBeUndefined();
          expect(detail?.delivery?.prUrl).toBeUndefined();
        }
        let description = gitlab?.descriptions().values().next().value;
        if (github) {
          const response = await fetch(
            `${github.env.INFINITARY_GITHUB_ENTERPRISE_API_URL}/repos/${fullName}/pulls/${detail?.delivery?.prNumber}`,
            { headers: { authorization: `Bearer ${githubSignIn}` } },
          );
          expect(response.status).toBe(200);
          description = ((await response.json()) as { body: string }).body;
        }
        if (stub) expect(description).toContain(presentationMarkdownText(why));
        // A saved merge card the captain has not clicked grants nothing: the remote main
        // still has only the seed.
        if (!note) expect(git("-C", bare, "rev-parse", "main")).toBe(initial);
        if (!note) await showStoryTop();
        const evidence =
          test.info().repeatEachIndex === 0 ? process.env.INFINITARY_TASK_EVIDENCE_DIR : undefined;
        if (evidence) {
          if (!note) await regionShot(card, join(evidence, `${kind}-offer-after.png`));
          writeFileSync(
            join(evidence, `${kind}-${note ? "note" : "offer"}-after.json`),
            JSON.stringify({ card: savedCard, description: description ?? null }, null, 2),
          );
        }
        if (!note) await merge.click();
        await expect
          .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId))
          .toMatchObject({ status: "done" });
        if (github) expect(github.merges()).toHaveLength(1);
        if (gitlab) expect(gitlab.merges()).toHaveLength(1);
        if (kind === "plain" || kind === "local") {
          expect(git("-C", kind === "local" ? dir : bare, "show", "main:meter.txt")).toBe(
            "reads on time",
          );
          if (kind === "local") expect(git("-C", bare, "rev-parse", "main")).toBe(initial);
        }
        if (note) {
          await expect(card).toBeVisible();
          await showsStory();
          await expect(merge).toHaveCount(0);
          const line = frame.locator(`[${MERGE_LINE_MARK}]`);
          await expect(line).toContainText(mergedWords("", true).trim());
          await expect(line).not.toContainText(MERGE_SETTING_WORDS.project);
          expect(
            (await page.evaluate(() => window.infinitary.cards.list())).filter(
              (entry) => entry.title === DESTINATION_STORY_TITLE,
            ),
          ).toHaveLength(1);
          await showStoryTop();
          if (evidence) await regionShot(card, join(evidence, `${kind}-note-merged-after.png`));
          if (evidence && kind === "local")
            await heroShot(launched.app, page, { region: card, name: "saved-story-everywhere" });
        }
        if (evidence)
          writeFileSync(
            join(evidence, `${kind}-${note ? "note" : "offer"}-merged.json`),
            JSON.stringify(
              await page.evaluate((id) => window.infinitary.tasks.detail(id), taskId),
              null,
              2,
            ),
          );
      } finally {
        await launched.close();
        await stub?.close();
      }
    });
  }
}
