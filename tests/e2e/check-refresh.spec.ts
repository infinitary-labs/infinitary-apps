import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CHECK_REFRESH_MS } from "../../src/core/orchestrator/checkWatch";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { CHECK_WORDS, MERGE_AFTER_FIXING_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER, STALE_CHECKS_CARD, STALE_CHECKS_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { nowRow, restOnRow, rowSummary, taskFact } from "./rails";
import { cardSurface, factsStrip } from "./stack";

/**
 * GitHub changes after completion: the card and task facts refresh without a
 * model turn. The quiet refresh reads finished checks once they are
 * `CHECK_REFRESH_MS` old, on the host's one-minute tick. The spec records the
 * green reading as that old - an overdue clock, as idle-ladder.spec.ts seeds -
 * and waits for the read, never for five minutes of wall clock.
 */
test("external check changes refresh the completion strip and task facts", async () => {
  test.setTimeout(300_000);
  const userDataDir = scratchDir("infinitary-check-refresh-");
  const repo = seedRepo(userDataDir);
  const github = await startGitHubStub();
  github.servePull({ number: 58, title: "fix: correct the meter", headSha: "stale-head-1" });
  // Green at first: the stand-in's default check run is linux-checks completed/success.
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'standard')",
  ).run("repo-meterlab", repo.repoDir, "meterlab", Date.now(), "https://github.com/o/meterlab.git");
  seedHostedOrigins(db, userDataDir);
  const app = await launchApp({ withMockProvider: true, userDataDir, env: github.env });
  const title = `meterlab ${STALE_CHECKS_MARKER}`;
  let taskId = "";
  const ledger = () => tasks.get(taskId);
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
    github.setChecks([{ name: "linux-checks", status: "completed", conclusion: "failure" }]);
    const readsBefore = checkReads();
    // Record the green reading as one refresh interval old: the host's next
    // tick then reads the checks again on its own, with no captain prompt.
    // e2e-writer-ok: the journey ages the green reading by a refresh interval, the way waiting would
    tasks.recordDelivery(taskId, { ciAt: Date.now() - CHECK_REFRESH_MS });
    // Wait for work, not a fixed sleep: a few ticks bound a busy host.
    await expect.poll(() => ledger()?.delivery?.ci, { timeout: 180_000 }).toBe("red");
    expect(checkReads()).toBeGreaterThan(readsBefore);
    await expect(factsStrip(frame).checks).toHaveText(CHECK_WORDS.red);
    // On failed checks a click keeps the approval for a fix.
    await expect(merge(MERGE_AFTER_FIXING_WORDS)).toBeVisible();
    await expect(merge(MERGE_WORDS["merge-pr"])).toHaveCount(0);
    const cards = await app.page.evaluate(() => window.infinitary.cards.list());
    const card = cards.find((c) => c.title === STALE_CHECKS_CARD);
    await app.page.screenshot({ path: test.info().outputPath("card-after-red.png") });
    const key = ledger()?.key ?? "";
    await restOnRow(app.page, key);
    await expect(rowSummary(app.page)).toBeVisible();
    // The preview's checks read the new reading, the merge card's way.
    await expect(taskFact(rowSummary(app.page), "checks")).toHaveAttribute("data-dot", "failed");
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
    if (process.env.INFINITARY_CAPTURE_CHECK_HERO === "1") {
      await heroShot(app.page, {
        name: "live-pull-request-checks",
        region: cardSurface(app.page),
        anchors: [rowSummary(app.page)],
        ready: () => restOnRow(app.page, key),
      });
    }
    await expect(factsStrip(frame).checks).toHaveText(CHECK_WORDS.red);
  } finally {
    await app.close();
    await github.close();
    db.close();
  }
});
