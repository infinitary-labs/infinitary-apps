import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { afterMergeWords } from "../../src/core/orchestrator/deliveryWakes";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  AFTER_MERGE_DOER_WORDS,
  AFTER_MERGE_LEAD,
  AFTER_MERGE_TITLE_PREFIX,
  afterMergeWaitWords,
} from "../../src/shared/afterMerge";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import {
  AFTER_MERGE_STORY_MARKER,
  AFTER_MERGE_STORY_TITLE,
  afterMergeStory,
  DASHBOARD_EXISTING_KEY,
  DASHBOARD_FEED_KEY,
  DASHBOARD_PROJECT_KEY,
  FIRSTMATE_AFTER_MERGE_STEP,
  FIRSTMATE_AFTER_MERGE_STORY_MARKER,
  METER_AFTER_MERGE_STEP,
  NO_AFTER_MERGE_STORY_MARKER,
  WAITING_AFTER_MERGE_STORY_MARKER,
} from "./scenarios/afterMergeStory";
import { cardScroller, shownCard, stageAtRest } from "./stack";

/**
 * INF-2796, the captain's Approve and build: a crewmate lists after-merge
 * steps on its merge card, and the app files each as a Continue task that
 * starts on its own once the merge goes through - and, in the captain's
 * written-in words, "we should not mandate these follow up tasks though. a
 * merge can totally end without anything to continue".
 * Each test owns a disposable local-only git project, commissions a real task
 * through the app and merges only through the captain's click on its card.
 * The finish line is the task record: the origin closes merged, and the step's
 * task is active with nobody starting it. The hermetic launcher is its only
 * prerequisite; nothing is shared with another journey.
 *
 * The third test is the captain's "Build them in this change": a step like
 * DOP-299's goes to another project and waits for another task's merge, and a
 * step may name a task already on the board. Its own dashboard project holds
 * the feed task both steps wait for and the existing task the second names;
 * after the merge both are set to start on their own and stay held by the feed.
 *
 * The fourth test is INF-3060's finding 4, the captain's "an after-merge step
 * names its doer, and app changes go to the first mate": a step that removes
 * an Automation rule names the first mate, the card says so, and the merge
 * files no task for it; the first mate's next turn is handed the step.
 */

const DASHBOARD_FEED_TITLE = "Send the meter feed to the dashboard";
const DASHBOARD_EXISTING = {
  title: "Chart the meter's on-time readings",
  goal: "The dashboard charts the meter's readings by the minute they arrive.",
};

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const continueTitle = `${AFTER_MERGE_TITLE_PREFIX}${METER_AFTER_MERGE_STEP.title}`;

const VARIANTS = {
  steps: { name: "lists a step that starts on its own", marker: AFTER_MERGE_STORY_MARKER },
  none: { name: "with no steps merges as before", marker: NO_AFTER_MERGE_STORY_MARKER },
  waits: {
    name: "lists steps that wait for other work, in another project and on the board",
    marker: WAITING_AFTER_MERGE_STORY_MARKER,
  },
  firstmate: {
    name: "hands an app change to the first mate with no task",
    marker: FIRSTMATE_AFTER_MERGE_STORY_MARKER,
  },
} as const;

for (const variant of ["steps", "none", "waits", "firstmate"] as const) {
  const steps = variant === "steps" || variant === "waits";
  test(`a merge card ${VARIANTS[variant].name}`, async () => {
    test.setTimeout(3 * 60_000);
    const userDataDir = scratchDir("infinitary-after-merge-");
    const dir = join(userDataDir, "meterlab");
    git("init", "--initial-branch=main", dir);
    git("-C", dir, "config", "user.name", "Test");
    git("-C", dir, "config", "user.email", "test@localhost");
    git("-C", dir, "commit", "--allow-empty", "-m", "chore: seed the meter");
    const db = openDatabase(userDataDir);
    seedProject(db, {
      id: "repo-meterlab",
      path: dir,
      name: "meterlab",
      setupKind: "init",
      origin: null,
      runsOn: null,
      delivery: "local-only",
      autonomy: false,
      rigor: "quick",
      addedAt: 1,
    });
    if (variant === "waits") {
      const dashDir = join(userDataDir, "dashlab");
      git("init", "--initial-branch=main", dashDir);
      git("-C", dashDir, "config", "user.name", "Test");
      git("-C", dashDir, "config", "user.email", "test@localhost");
      git("-C", dashDir, "commit", "--allow-empty", "-m", "chore: seed the dashboard");
      seedProject(db, {
        id: "repo-dashlab",
        path: dashDir,
        name: "dashlab",
        key: DASHBOARD_PROJECT_KEY,
        setupKind: "init",
        origin: null,
        runsOn: null,
        delivery: "local-only",
        autonomy: false,
        rigor: "quick",
        addedAt: 2,
      });
      const tasks = new TaskService({ db });
      // Both wait on the board for someone to start them: the feed task, and
      // the chart task the second step names.
      seedTask(tasks, {
        id: "dashfeed",
        title: DASHBOARD_FEED_TITLE,
        repoId: "repo-dashlab",
        status: "queued",
        startPolicy: "on-request",
      });
      tasks.create({
        id: "dashchart",
        kind: "work",
        title: DASHBOARD_EXISTING.title,
        goal: DASHBOARD_EXISTING.goal,
        prompt: "",
        repoId: "repo-dashlab",
        startPolicy: "on-request",
        actor: "host",
      });
    }
    db.close();
    const launched = await launchApp({
      withMockProvider: true,
      scenarios: [afterMergeStory()],
      userDataDir,
    });
    try {
      const { page } = launched;
      await resizeWindow(launched.app, page, { width: 1280, height: 1000 });
      const input = promptInput(page);
      const title = `meterlab ${VARIANTS[variant].marker}`;
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      const card = shownCard(page, AFTER_MERGE_STORY_TITLE);
      await expect(card).toBeVisible({ timeout: 45_000 });
      // The steps lead the card's body (INF-3149), inside its document.
      const listed = cardBody(page, AFTER_MERGE_STORY_TITLE).getByRole("region", {
        name: AFTER_MERGE_LEAD,
      });
      if (steps) {
        await expect(listed).toContainText(continueTitle);
        await expect(listed).toContainText(METER_AFTER_MERGE_STEP.goal);
        await expect(listed).toContainText(AFTER_MERGE_DOER_WORDS.crewmate);
      }
      if (variant === "firstmate") {
        // The step names the first mate as its doer, with no Continue title.
        await expect(listed).toContainText(FIRSTMATE_AFTER_MERGE_STEP.title);
        await expect(listed).toContainText(FIRSTMATE_AFTER_MERGE_STEP.goal);
        await expect(listed).toContainText(AFTER_MERGE_DOER_WORDS.firstmate);
        await expect(listed).not.toContainText(AFTER_MERGE_TITLE_PREFIX);
      }
      if (variant === "waits") {
        // The existing task leads with its key and its own words, and each
        // step says what it waits for.
        await expect(listed).toContainText(`${DASHBOARD_EXISTING_KEY} ${DASHBOARD_EXISTING.title}`);
        await expect(listed).toContainText(DASHBOARD_EXISTING.goal);
        await expect(listed.getByText(afterMergeWaitWords([DASHBOARD_FEED_KEY]))).toHaveCount(2);
      }
      if (variant === "none") {
        await expect(listed).toHaveCount(0);
      }
      const board = () => page.evaluate(() => window.infinitary.tasks.board());
      // Offering the step files nothing: only the merge does.
      expect((await board()).tasks.filter((row) => row.title === continueTitle)).toEqual([]);

      const evidence =
        test.info().repeatEachIndex === 0 ? process.env.INFINITARY_TASK_EVIDENCE_DIR : undefined;
      if (evidence) {
        await stageAtRest(page);
        await cardScroller(page).evaluate((scroller) => {
          scroller.scrollTop = 0;
        });
        await regionShot(card, join(evidence, `merge-card-${variant}.png`));
        if (variant === "steps")
          await heroShot(launched.app, page, { region: card, name: "after-merge-steps" });
        if (variant === "firstmate")
          await heroShot(launched.app, page, { region: card, name: "after-merge-doer" });
      }

      const origin = (await board()).tasks.find((row) => row.title === title);
      if (!origin) throw new Error("The meter task never reached the board.");
      await card.getByRole("button", { name: MERGE_WORDS.land, exact: true }).click();
      await expect
        .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), origin.id))
        .toMatchObject({ status: "done" });
      expect(git("-C", dir, "show", "main:meter.txt")).toBe("reads on time");

      if (variant === "waits") {
        // Both steps are set to start on their own, in the dashboard's
        // project, and the feed task they wait for still holds them.
        await expect
          .poll(
            async () =>
              (await board()).tasks
                .filter((row) => row.title === continueTitle)
                .map((row) => row.status),
            { timeout: 45_000 },
          )
          .toEqual(["open"]);
        const filed = (await board()).tasks.find((row) => row.title === continueTitle);
        const detail = await page.evaluate(
          (id) => window.infinitary.tasks.detail(id),
          filed?.id ?? "",
        );
        const existing = await page.evaluate(() => window.infinitary.tasks.detail("dashchart"));
        if (evidence)
          writeFileSync(
            join(evidence, "waiting-steps-after-merge.json"),
            JSON.stringify({ filed: detail, existing }, null, 2),
          );
        const held = {
          repo: { name: "dashlab" },
          status: "open",
          startPolicy: "when-ready",
          startedAt: null,
          blockedBy: [DASHBOARD_FEED_KEY],
        };
        expect(detail).toMatchObject(held);
        expect(existing).toMatchObject({ ...held, key: DASHBOARD_EXISTING_KEY });
      } else if (steps) {
        // The step's task is filed by the merge and started by the app alone.
        await expect
          .poll(
            async () =>
              (await board()).tasks
                .filter((row) => row.title === continueTitle)
                .map((row) => row.status),
            { timeout: 45_000 },
          )
          .toEqual(["active"]);
        const filed = (await board()).tasks.find((row) => row.title === continueTitle);
        const detail = await page.evaluate(
          (id) => window.infinitary.tasks.detail(id),
          filed?.id ?? "",
        );
        if (evidence)
          writeFileSync(
            join(evidence, "continue-task-started.json"),
            JSON.stringify(detail, null, 2),
          );
        expect(detail).toMatchObject({
          goal: METER_AFTER_MERGE_STEP.goal,
          startPolicy: "when-ready",
        });
      } else if (variant === "firstmate") {
        // The merge hands the step to the first mate in its settled wake,
        // and files no task, so no crewmate starts for it.
        const handed = afterMergeWords([], [FIRSTMATE_AFTER_MERGE_STEP]);
        await expect
          .poll(
            () =>
              (launched.mockProvider?.requestBodies() ?? []).some((body) =>
                providerMessages(body).some((message) => message.text.includes(handed)),
              ),
            { timeout: 45_000 },
          )
          .toBe(true);
        expect(
          (await board()).tasks.filter((row) => row.title.startsWith(AFTER_MERGE_TITLE_PREFIX)),
        ).toEqual([]);
        expect((await board()).tasks.map((row) => row.title)).not.toContain(
          FIRSTMATE_AFTER_MERGE_STEP.title,
        );
      } else {
        expect(
          (await board()).tasks.filter((row) => row.title.startsWith(AFTER_MERGE_TITLE_PREFIX)),
        ).toEqual([]);
      }
    } finally {
      await launched.close();
    }
  });
}
