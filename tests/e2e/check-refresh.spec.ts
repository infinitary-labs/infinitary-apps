import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CHECK_REFRESH_MS } from "../../src/core/orchestrator/checkWatch";
import { keptFeedLine } from "../../src/core/orchestrator/mergeAuthorization";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  CHECKS_NOT_REPORTED_WORDS,
  checkSnapshotSummary,
  currentCheckStatus,
} from "../../src/shared/checkSnapshot";
import {
  CHECK_WORDS,
  MERGE_AFTER_FIXING_WORDS,
  MERGE_ANYWAY_WORDS,
  MERGE_WHEN_CHECKS_PASS_WORDS,
  MERGE_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp, SHORT_TICK } from "./launch";
import { atRest } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, readyRegion, regionShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import {
  activityFrame,
  dockRegion,
  expandDock,
  expectRecordBody,
  expectRecordSized,
  hideRecord,
  notesNaming,
  nowRow,
  recordCard,
  recordFrame,
  restOnRow,
  rowSummary,
  rowSummaryBody,
  taskFact,
  taskKeyLinks,
} from "./rails";
import { readSavedData } from "./savedData";
import {
  STALE_CHECKS_CARD,
  STALE_CHECKS_MARKER,
  STALE_CHECKS_REFUSAL,
  staleChecks,
} from "./scenarios/staleChecks";
import { cardSurface, completionAction, factsStrip } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * GitHub changes after completion: the quiet reader forwards changed facts,
 * while its existing merge offer supplies the crew's judgment; no second verdict is recorded.
 * The quiet refresh reads finished checks once they are
 * `CHECK_REFRESH_MS` old, on the host's tick, which this journey shortens to
 * seconds (`SHORT_TICK`). The spec records the green reading as that old - an
 * overdue clock, as idle-ladder.spec.ts seeds - and waits for the read, never
 * for five minutes of wall clock or the rest of a minute's tick.
 */
// INF-1555 F12/F14: the offer means ready; checks alone hold it, including a known read refusal.
for (const kind of ["failed", "empty", "unreadable"] as const) {
  test(`${kind} check facts and their hold stay truthful without a separate crew verdict (INF-1555 F12/F14)`, async () => {
    const empty = kind === "empty";
    const unreadable = kind === "unreadable";
    const refusal = STALE_CHECKS_REFUSAL;
    test.setTimeout(300_000);
    const userDataDir = scratchDir("infinitary-check-refresh-");
    const repo = seedRepo(userDataDir);
    const github = await startGitHubStub();
    github.servePull({ number: 58, title: "fix: correct the meter", headSha: "stale-head-1" });
    // The merge click reads a real disposable commit, not a display-only placeholder.
    github.headOf(repo.branchHead);
    // Green at first: the stand-in's default check run is linux-checks completed/success.
    seedGitHubSignIn(userDataDir);
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'standard')",
    ).run(
      "repo-meterlab",
      repo.repoDir,
      "meterlab",
      Date.now(),
      "https://github.com/o/meterlab.git",
    );
    seedHostedOrigins(db, userDataDir);
    const app = await launchApp({
      withMockProvider: true,
      scenarios: [staleChecks],
      userDataDir,
      env: { ...github.env, ...SHORT_TICK },
    });
    const title = `meterlab ${STALE_CHECKS_MARKER}`;
    let taskId = "";
    const ledger = () => readSavedData(userDataDir, (db) => new TaskStore(db).get(taskId));
    const send = async (words: string) => {
      const input = promptInput(app.page);
      await input.fill(words);
      await input.press("Enter");
    };
    const checkReads = () =>
      github.requests().filter((r) => /check-runs|\/status$|commits\/.*\/check/.test(r)).length;
    try {
      await send(`${SPAWN_PROMPT_MARKER} ${title}`);
      await expect
        .poll(
          async () => {
            const board = await app.page.evaluate(() => window.infinitary.tasks.board());
            taskId = board.tasks.find((t) => t.title === title)?.id ?? "";
            return taskId;
          },
          { timeout: 30000 },
        )
        .not.toBe("");
      await expect
        .poll(
          async () =>
            (await app.page.evaluate(() => window.infinitary.cards.list())).map((c) => c.title),
          { timeout: 30000 },
        )
        .toContain(STALE_CHECKS_CARD);
      const frame = cardBody(app.page, STALE_CHECKS_CARD);
      await expect(factsStrip(frame).checks).toBeVisible();
      await expect(factsStrip(frame).checks).toHaveText(CHECK_WORDS.green);
      // The merge names what a click does (INF-23): on passed checks it merges.
      const merge = (words: string) =>
        app.page.locator("[data-card-layer]").getByRole("button", { name: words, exact: true });
      await expect(merge(MERGE_WORDS["merge-pr"])).toBeVisible();
      await app.page.screenshot({ path: test.info().outputPath("card-green.png") });

      // The crewmate reported and waits on the captain: its work is complete.
      await expect.poll(() => ledger()?.activity, { timeout: 30_000 }).toBe("idle");

      // GitHub's checks turn red on the same pull request.
      github.setChecks(
        empty
          ? []
          : [
              {
                name: "linux-checks",
                status: "completed",
                conclusion: unreadable ? "success" : "failure",
                // INF-1555 F21: a completed check's known start must not become an unreadable reading's running clock.
                ...(unreadable
                  ? {
                      started_at: new Date(Date.now() - CHECK_REFRESH_MS).toISOString(),
                      completed_at: new Date().toISOString(),
                    }
                  : {}),
              },
            ],
      );
      if (unreadable) github.setWorkflowReadFailure({ status: 403, message: refusal });
      const readsBefore = checkReads();
      // Record the green reading as one refresh interval old: the host's next
      // tick then reads the checks again on its own, with no captain prompt.
      // e2e-writer-ok: the journey ages the green reading by a refresh interval, the way waiting would
      seedDelivery(tasks, taskId, { ciAt: Date.now() - CHECK_REFRESH_MS });
      // Wait for work, not a fixed sleep: a few ticks bound a busy host.
      await expect
        .poll(() => ledger()?.delivery?.ci, { timeout: 180_000 })
        .toBe(empty || unreadable ? "pending" : "red");
      expect(ledger()?.delivery).not.toHaveProperty("crewVerdict");
      expect(
        ledger()?.delivery?.ciRepair?.declarations?.some(
          (row) => "verdict" in row && (row.verdict === "ready" || row.verdict === "red"),
        ) ?? false,
      ).toBe(false);
      expect(checkReads()).toBeGreaterThan(readsBefore);
      const expectedWords = checkSnapshotSummary(ledger()!.delivery!.checks!).words;
      await expect(factsStrip(frame).checks).toHaveText(expectedWords);
      expect(await factsStrip(frame).facts()).not.toContain("crew-verdict");
      // Captain INF-1555 F20 preserves his distinct failed-check wording.
      await expect(
        merge(empty || unreadable ? MERGE_WHEN_CHECKS_PASS_WORDS : MERGE_AFTER_FIXING_WORDS),
      ).toBeVisible();
      await expect(merge(MERGE_WORDS["merge-pr"])).toHaveCount(0);
      await expect(merge(MERGE_ANYWAY_WORDS)).toHaveCount(empty || unreadable ? 0 : 1);
      if (unreadable) {
        await expect(factsStrip(frame).checks).toContainText(refusal);
      } else {
        await expect(factsStrip(frame).checks).toHaveText(
          empty ? CHECKS_NOT_REPORTED_WORDS : CHECK_WORDS.red,
        );
      }
      const cards = await app.page.evaluate(() => window.infinitary.cards.list());
      const card = cards.find((c) => c.title === STALE_CHECKS_CARD);
      if (process.env.INFINITARY_CAPTURE_CHECK_HERO === "1" && kind === "failed") {
        // The release picture shows every merge control, without the hover summary covering them.
        await heroShot(app.app, app.page, {
          name: "crew-check-judgments",
          region: cardSurface(app.page),
        });
      }
      await app.page.screenshot({ path: test.info().outputPath("card-after-red.png") });
      const key = ledger()?.key ?? "";
      await restOnRow(app.page, key);
      await expect(rowSummary(app.page)).toBeVisible();
      await readyRegion(rowSummaryBody(app.page));
      // Both surfaces show the same actual check facts, without a second verdict.
      await expect(taskFact(rowSummary(app.page), "checks")).toHaveAttribute(
        "data-dot",
        unreadable ? "warn" : empty ? "running" : "failed",
      );
      await expect(rowSummary(app.page).locator('[data-task-fact="crew-verdict"]')).toHaveCount(0);
      if (unreadable) {
        await expect(taskFact(rowSummary(app.page), "checks")).toContainText(refusal);
        const bounds = await taskFact(rowSummary(app.page), "checks")
          .locator("[data-task-fact-checks]")
          .boundingBox();
        const summaryBounds = await rowSummaryBody(app.page).boundingBox();
        expect(bounds).not.toBeNull();
        expect(summaryBounds).not.toBeNull();
        if (!bounds || !summaryBounds) throw new Error("Missing visible check-refusal summary");
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(summaryBounds.x + summaryBounds.width);
      }
      await app.page.screenshot({ path: test.info().outputPath("row-summary-after-red.png") });
      writeFileSync(
        test.info().outputPath("app-state.json"),
        JSON.stringify(
          {
            delivery: ledger()?.delivery,
            card,
            requests: github.requests(),
            row: await nowRow(app.page, key).textContent(),
          },
          null,
          2,
        ),
      );
      // F12/F21: the record and its Activity read the same facts, without a second verdict or running clock.
      await taskKeyLinks(cardSurface(app.page)).first().click();
      await expect(recordCard(app.page)).toBeVisible();
      await expectRecordBody(app.page);
      await expectRecordSized(app.page);
      await expect(taskFact(recordCard(app.page), "checks")).toHaveText(expectedWords);
      await expect(recordCard(app.page).locator('[data-task-fact="crew-verdict"]')).toHaveCount(0);
      await regionShot(recordCard(app.page), test.info().outputPath("record-after.png"));
      const timeline = recordFrame(app.page).locator('[data-record-section="timeline"]');
      if ((await timeline.getAttribute("open")) === null) {
        await timeline
          .locator(":scope > summary")
          .evaluate((element) => (element as HTMLElement).click());
      }
      await expect(timeline).toHaveAttribute("open", "");
      await recordFrame(app.page)
        .getByText(`Checks: ${expectedWords}`, { exact: false })
        .last()
        .scrollIntoViewIfNeeded();
      await regionShot(recordCard(app.page), test.info().outputPath("activity-after.png"));
      await hideRecord(app.page).click();
      await expect(factsStrip(frame).checks).toHaveText(expectedWords);
      // Captain F27: the kept approval's Activity line names a fix only for actual failed checks.
      await (await completionAction(app.page, STALE_CHECKS_CARD)).click();
      await expect.poll(() => ledger()?.delivery?.mergeAuthorization?.waiting?.on).toBe("checks");
      await expandDock(app.page, "activity");
      await expect(notesNaming(app.page, title).last()).toBeVisible();
      // The existing keyboard view wraps Activity rows in full rather than ellipsizing them.
      await pressKey(activityFrame(app.page).locator("[data-feed-scroller]"), "End");
      await atRest(notesNaming(app.page, title).last());
      await regionShot(
        dockRegion(app.page, "activity"),
        test.info().outputPath("kept-checks-activity.png"),
      );
      await expect(
        notesNaming(app.page, title).filter({
          hasText: keptFeedLine(title, "checks", "GitHub", currentCheckStatus(ledger()?.delivery)),
        }),
      ).toBeVisible();
      expect(github.merges()).toEqual([]);
    } finally {
      if (taskId)
        writeFileSync(
          test.info().outputPath("final-task-state.json"),
          JSON.stringify(
            {
              task: readSavedData(userDataDir, (db) => new TaskStore(db).get(taskId)),
              timeline: tasks.timeline(taskId),
            },
            null,
            2,
          ),
        );
      await app.close();
      await github.close();
      db.close();
    }
  });
}
