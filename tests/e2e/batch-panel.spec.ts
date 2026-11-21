import { expect, type Page, test } from "@playwright/test";
import batchesManifest from "../../resources/runbooks/batches/panel/manifest.json" with {
  type: "json",
};
import * as words from "../../resources/runbooks/batches/panel/messages.generated";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import type { BatchRecord } from "../../src/shared/batches";
import { panelCommandId } from "../../src/shared/keyboard";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { panelBody } from "./frames";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { leaveSettings } from "./handoverCards";
import { launchApp, SHORT_TICK } from "./launch";
import { shownPanelCardBody } from "./panelCards";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { recordCard } from "./rails";
import { settingsSection } from "./settings";
import { focusOn, pressKey, pressKeyTakingFrame, runFromSearch } from "./windowKeys";

/**
 * The Batches panel (docs/forge.md, "The Batches panel"), the captain's ask
 * for a panel on the Batched pull requests runbook, "similar to my rolling
 * alpha panel but only scoped to batched PRs", built from the approved plan.
 *
 * - Promised result: while the runbook is on, the right rail shows the
 *   project's held batch with its failed check and members, the change
 *   waiting and the change left out, and a closed Last day; by keys alone
 *   the arrows move through it, Enter on a member opens its task, Enter on
 *   Answer in Settings opens the held batch in Settings → Projects, and
 *   command search's Show your batches puts up the details card with the
 *   batch that merged in the last day.
 * - Data: a batched project whose saved record holds an open batch held on
 *   a failed check, a change in line, a change left out and a batch that
 *   merged two hours ago, written through the registry's own writer before
 *   the launch, with each change's task seeded; a disposable GitHub serves
 *   the batch's pull request at the held version and its failed check.
 * - Completion signal: the panel's rows as drawn, the task record card of
 *   the member pressed, the Settings section holding the held batch with
 *   focus inside it, and the details card's table row.
 * - Platform prerequisites: none beyond the hermetic launcher.
 * - Shared resources: none; its own userData, HOME and GitHub stand-in.
 */

const PANEL = "batches-panel";
const REPO = "repo-meterlab";
const HEAD = "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6";
const BRANCH = "infinitary-batch/7c41";
const FAILED = [
  { name: "build", status: "completed", conclusion: "success" },
  { name: "unit-tests", status: "completed", conclusion: "failure" },
];

const CHANGES = {
  parser: "fix(parser): read dates with a time zone",
  export: "feat(export): add a CSV export",
  legend: "fix(chart): keep the legend inside the chart",
  axis: "fix(chart): label the time axis in local time",
} as const;
type Change = keyof typeof CHANGES;
/** Each change's approved version. */
const HEADS: Record<Change, string> = {
  parser: "1111111111111111111111111111111111111111",
  export: "2222222222222222222222222222222222222222",
  legend: "3333333333333333333333333333333333333333",
  axis: "4444444444444444444444444444444444444444",
};

/** The panel on its rail. */
function batchesPanel(page: Page) {
  return page.locator(`[data-side-panel="${PANEL}"]`);
}

test("the Batches panel shows a held batch, its line and its last day, and points from each by keys", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("infinitary-batch-panel-");
  const { repoDir } = seedRepo(userDataDir);
  const github = await startGitHubStub();
  github.serveNumbered({ number: 31, branch: BRANCH, title: "Batch of 2 changes", headSha: HEAD });
  github.setChecks(FAILED);
  seedGitHubSignIn(userDataDir);

  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: REPO,
    path: repoDir,
    name: "meterlab",
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "queue-pr",
    rigor: "quick",
  });
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const now = Date.now();
  const keys = {} as Record<Change, string>;
  for (const id of Object.keys(CHANGES) as Change[]) {
    keys[id] = seedTask(tasks, {
      id: `t-${id}`,
      title: CHANGES[id],
      repoId: REPO,
      repoDir,
      branch: `inf/${id}`,
      status: "idle",
      startPolicy: "on-request",
    }).key;
    // The captain's merge click kept each change's approval at its version, as the
    // batch's members and the change in line carry it; the left-out one's is spent.
    if (id !== "axis")
      seedDelivery(tasks, `t-${id}`, {
        mergeAuthorization: {
          version: 1,
          id: `approval-${id}`,
          generation: 1,
          issuer: "captain",
          at: now - 3 * 60 * 60_000,
          card: { id: `card-${id}`, offerId: `offer-${id}`, actionId: "merge" },
          target: {
            repoId: REPO,
            host: "github.com",
            owner: "o",
            name: "meterlab",
            branch: `inf/${id}`,
            delivery: "direct-pr",
            method: "squash",
          },
          approvedHead: HEADS[id],
          lineage: [],
          proceedWithOpen: false,
          status: "standing",
        },
      });
  }
  const change = (id: Change) => ({
    taskId: `t-${id}`,
    branch: `inf/${id}`,
    head: HEADS[id],
    title: CHANGES[id],
    body: "",
    at: now - 3 * 60 * 60_000,
  });
  const record: BatchRecord = {
    line: [change("legend")],
    open: {
      branch: BRANCH,
      base: "0000000000000000000000000000000000000000",
      head: HEAD,
      since: now - 50 * 60_000,
      number: 31,
      url: "https://github.com/o/meterlab/pull/31",
      members: [
        { ...change("parser"), commit: "a".repeat(40) },
        { ...change("export"), commit: HEAD },
      ],
      hold: { reason: "checks", head: HEAD, checks: ["unit-tests"], at: now - 4 * 60_000 },
      holds: 1,
    },
    held: [HEAD],
    receipts: [],
    leftOut: [
      {
        taskId: "t-axis",
        head: HEADS.axis,
        reason: "it no longer combines with the default branch",
        at: now - 30 * 60_000,
      },
    ],
    finished: [
      {
        number: 30,
        url: "https://github.com/o/meterlab/pull/30",
        formed: now - 3 * 60 * 60_000,
        ended: now - 2 * 60 * 60_000,
        outcome: "merged",
        members: [{ taskId: "t-parser", title: "an earlier change" }],
        holds: 0,
      },
    ],
  };
  new RepoRegistry(db, userDataDir).recordBatch(REPO, record);
  db.close();

  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    env: { ...github.env, ...SHORT_TICK },
  });
  const { app, page } = launched;
  try {
    const panel = batchesPanel(page);
    await expect(panel).toBeAttached({ timeout: 30_000 });
    const body = panelBody(page, PANEL);

    await test.step("collapsed, its header says what it holds; open, it shows each group", async () => {
      if ((await panel.getAttribute("data-side-panel-collapsed")) !== null) {
        await expect(panel).toContainText(words.batchesPanelWaitingCount({ count: 1 }));
        await expect(panel).toContainText(words.batchesPanelLeftOutCount({ count: 1 }));
        await panel.getByRole("button", { name: `Expand ${batchesManifest.title}` }).click();
      }
      await expect(panel).not.toHaveAttribute("data-side-panel-collapsed", "");
      await expect(body.locator("[data-batches-open]")).toContainText(
        words.batchesPanelBatchTitle({ number: "31", count: 2 }),
      );
      // Held, not checking; how many minutes depends on when the launch finished.
      await expect(body.locator("[data-batches-open]")).toContainText(
        words.batchesPanelHeld({ duration: "" }).trim(),
      );
      await expect(body.locator("[data-batches-failed]")).toContainText("unit-tests");
      await expect(body.locator("[data-batches-member]")).toHaveText([keys.parser, keys.export]);
      await expect(body.locator("[data-batches-line]")).toContainText(
        words.batchesPanelWaiting({ count: 1 }),
      );
      await expect(body.locator('[data-batches-left-out="t-axis"]')).toContainText(keys.axis);
      // The Last day starts closed.
      await expect(body.locator("[data-batches-finished]")).toHaveCount(0);
      // The host's own reading of the batch's checks, once the app's pass read it.
      await expect(body.locator("[data-batches-checks]")).toContainText(
        words.batchesPanelChecksPassed({ passed: "1", total: "2" }),
      );
    });

    await test.step("the arrows move through it, and Enter on a member opens its task", async () => {
      const first = body.locator('[data-batches-stop="open:repo-meterlab"] button');
      await focusOn(first);
      await pressKey(first, "ArrowDown");
      const answer = body.locator('[data-batches-stop="answer:repo-meterlab"]');
      await expect(answer).toBeFocused();
      await pressKey(answer, "ArrowDown");
      const chip = body.locator('[data-batches-member="t-parser"]');
      await expect(chip).toBeFocused();
      await pressKey(chip, "Enter");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", "t-parser");
    });

    await test.step("Enter on Answer in Settings opens the held batch in Settings → Projects", async () => {
      const answer = body.locator('[data-batches-stop="answer:repo-meterlab"]');
      await pressKeyTakingFrame(answer, "Enter");
      const projects = settingsSection(page, "projects");
      const held = projects.locator(`[data-batch-hold="${REPO}"]`);
      await expect(held).toBeVisible();
      await expect
        .poll(() => held.evaluate((node) => node.contains(node.ownerDocument.activeElement)))
        .toBe(true);
      await leaveSettings(page);
    });

    await test.step("Show your batches puts up the details card with the last day's batch", async () => {
      await runFromSearch(app, page, panelCommandId(PANEL, "open"));
      const card = shownPanelCardBody(page, PANEL, "details");
      await expect(card.locator("[data-batches-details-open]")).toContainText(
        words.batchesPanelFailedNames({ names: "unit-tests" }),
      );
      await expect(card.locator('[data-batches-finished-row="30"]')).toContainText(
        words.batchesPanelMergedNumber({ number: "30" }),
      );
      await expect(card.locator("[data-batches-details-line]")).toContainText(keys.legend);
    });
  } finally {
    await launched.close();
    await github.close();
  }
});
