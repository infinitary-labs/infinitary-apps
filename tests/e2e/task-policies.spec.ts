import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  POLICY_DELIVERY_WORDS,
  POLICY_MERGING_WORDS,
  POLICY_SOURCE_WORDS,
} from "../../src/shared/taskPolicies";
import { CARE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedArgs, ScriptedCall } from "../helpers/scriptedCalls";
import { waitForFirstmateIdle } from "./crew";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { MOCK_CLOSING_SENTENCES, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import {
  expandDock,
  nowFrame,
  nowRow,
  recordCard,
  recordFact,
  recordFrame,
  taskKey,
} from "./rails";
import { AUTONOMY_PROMPT_MARKER, autonomy, MOCK_AUTONOMY_CARD_TITLE } from "./scenarios/autonomy";
import { shownCard } from "./stack";
import { pressKey, pressWindowKey, runFromSearch, typeInto } from "./windowKeys";

function evidence(name: string) {
  return process.env.INFINITARY_POLICY_EVIDENCE_DIR
    ? join(process.env.INFINITARY_POLICY_EVIDENCE_DIR, name)
    : test.info().outputPath(name);
}

async function request(app: LaunchedApp, words: string, calls: ScriptedCall[]) {
  if (!app.mockProvider) throw new Error("The policy journey requires the mock provider");
  await waitForFirstmateIdle(app.page);
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    calls,
  );
  const input = promptInput(app.page);
  await pressWindowKey(app.app, "l", ["meta"]);
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+A");
  await typeInto(input, words);
  await input.press("Enter");
  await expect
    .poll(answer.outcome, { timeout: 30_000 })
    .toMatchObject({ state: "closed", results: calls.map(() => expect.any(String)) });
  return answer.outcome();
}

async function edit(
  app: LaunchedApp,
  words: string,
  args: ScriptedArgs<"update_task">,
  rest: ScriptedCall[] = [],
) {
  return request(app, words, [{ name: "update_task", args }, ...rest]);
}

async function tabTo(app: LaunchedApp, target: Locator) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === el.ownerDocument.activeElement)) break;
    await app.page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function openRecord(app: LaunchedApp, key: string, backlog: boolean | "landed" = false) {
  await expandDock(app.page, "now");
  if (backlog)
    await nowFrame(app.page)
      .locator(`[data-now-group-header="${backlog === "landed" ? "landed" : "backlog"}"]`)
      .evaluate((el) => (el as HTMLElement).click());
  await pressKey(nowRow(app.page, key), "Enter");
  await expect(recordCard(app.page)).toBeVisible();
  const summary = recordFrame(app.page).locator('[data-record-section="details"] > summary');
  await runFromSearch(app.app, app.page, "focus.card-body");
  await tabTo(app, summary);
  await app.page.keyboard.press("Enter");
}

test("keyboard requests change queued policies, show their sources and Activity, and survive reset and restart without starting work", async () => {
  const userDataDir = scratchDir("fm-policy-queued-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const task = seedTask(tasks, {
    id: "policy-picture",
    title: "Fix an alpha-blocking test",
    status: "queued",
    startPolicy: "on-request",
    shape: { kind: "fix", rigor: "standard", autonomy_ask: false },
    intent: {
      goal: "Keep the test reliable.",
      userWords: "Fix this test and ask me before merging.",
    },
  });
  db.close();
  let app = await launchApp({ scenarios: [autonomy], userDataDir, withMockProvider: true });
  try {
    await resizeWindow(app.app, app.page, { width: 1440, height: 1000 });
    await openRecord(app, task.key, true);
    const detail = () => app.page.evaluate((id) => window.infinitary.tasks.detail(id), task.id);
    await expect(recordFact(app.page, "merging")).toContainText(POLICY_MERGING_WORDS.off);
    const changed = await edit(
      app,
      `Use pull requests, merge on your own, and use Careful for ${task.key}.`,
      { task: task.key, delivery: "direct-pr", autonomy: "on", rigor: "reviewed" },
    );
    expect(changed.results[0]).not.toContain("Refused");
    await expect.poll(detail).toMatchObject({
      status: "open",
      startedAt: null,
      policies: {
        delivery: { value: "direct-pr", source: "task" },
        autonomy: { value: true, source: "task" },
        rigor: { value: "reviewed", source: "task" },
      },
    });
    await expect(recordFact(app.page, "delivery")).toContainText(
      POLICY_DELIVERY_WORDS["direct-pr"],
    );
    await expect(recordFact(app.page, "merging")).toContainText(POLICY_MERGING_WORDS.on);
    await expect(recordFact(app.page, "care")).toContainText(CARE_WORDS.reviewed);
    await expect(recordFact(app.page, "care")).toContainText(POLICY_SOURCE_WORDS.task);
    await runFromSearch(app.app, app.page, "focus.card-body");
    await tabTo(app, recordFrame(app.page).locator('[data-record-section="timeline"] > summary'));
    await app.page.keyboard.press("Enter");
    await expect
      .poll(async () => (await detail()).events.some((event) => event.data?.changes))
      .toBe(true);
    await recordCard(app.page).screenshot({ path: evidence("record-after.png") });
    if (process.env.INFINITARY_POLICY_HERO === "1")
      await heroShot(app.app, app.page, {
        region: recordFrame(app.page).locator('[data-record-section="details"]'),
        name: "live-task-policies",
      });
    writeFileSync(
      evidence("queued-policy-response.json"),
      JSON.stringify({ tool: changed, record: await detail() }, null, 2),
    );
    await edit(app, `Merge ${task.key} locally instead.`, {
      task: task.key,
      delivery: "local-only",
    });
    await expect.poll(detail).toMatchObject({
      policies: {
        rigor: { value: "standard", requested: "reviewed" },
        autonomy: { value: true },
      },
    });
    await recordCard(app.page).screenshot({ path: evidence("record-local-bound.png") });
    await edit(app, `Use the project settings for all three policies on ${task.key}.`, {
      task: task.key,
      delivery: "project",
      autonomy: "project",
      rigor: "project",
    });
    await expect.poll(detail).toMatchObject({
      status: "open",
      policies: {
        delivery: { source: "project" },
        autonomy: { source: "project" },
        rigor: { source: "project" },
      },
    });
    await recordCard(app.page).screenshot({ path: evidence("record-reset.png") });
    const history = (await detail()).events.filter((event) => event.data?.changes).length;
    const homeDir = app.homeDir;
    await app.close();
    app = await launchApp({ scenarios: [autonomy], userDataDir, homeDir, withMockProvider: true });
    await expect.poll(detail).toMatchObject({
      status: "open",
      startedAt: null,
      policies: {
        delivery: { value: "local-only", source: "project" },
        autonomy: { value: true, source: "project" },
        rigor: { value: "standard", source: "project" },
      },
    });
    expect((await detail()).events.filter((event) => event.data?.changes)).toHaveLength(history);
    writeFileSync(evidence("reset-after-restart.json"), JSON.stringify(await detail(), null, 2));
  } finally {
    await app.close();
  }
});

for (const checks of ["success", "failure"] as const)
  test(`explicit self-merging on a ready pull request with ${checks} checks`, async () => {
    const userDataDir = scratchDir("fm-policy-ready-");
    const { repoDir } = seedRepo(userDataDir);
    const github = await startGitHubStub();
    const change = {
      number: 61,
      title: "fix: make the meter read on time",
      body: "The meter reads on the first paint.",
    };
    github.servePull(change);
    github.headOf((branch) =>
      execFileSync("git", ["-C", repoDir, "rev-parse", `refs/heads/${branch}`], {
        encoding: "utf8",
      }).trim(),
    );
    seedGitHubSignIn(userDataDir);
    const db = openDatabase(userDataDir);
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0, 'quick')",
    ).run("repo-meterlab", repoDir, "meterlab", Date.now(), "https://github.com/o/meterlab.git");
    seedHostedOrigins(db, userDataDir);
    db.close();
    const app = await launchApp({
      scenarios: [autonomy],
      userDataDir,
      withMockProvider: true,
      env: github.env,
    });
    try {
      const title = `meterlab ${AUTONOMY_PROMPT_MARKER}`;
      const input = promptInput(app.page);
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      await expect(shownCard(app.page, MOCK_AUTONOMY_CARD_TITLE(title))).toBeVisible({
        timeout: 30_000,
      });
      const key = await taskKey(app.page, title);
      const row = (await app.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
        (task) => task.key === key,
      );
      if (!row) throw new Error("Ready task missing");
      const detail = () => app.page.evaluate((id) => window.infinitary.tasks.detail(id), row.id);
      github.setChecks([{ name: "linux-checks", status: "completed", conclusion: checks }]);
      const result = await edit(
        app,
        `Let ${key} merge on its own now.`,
        { task: key, autonomy: "on" },
        [
          {
            name: "settle_task",
            args: {
              task_id: row.id,
              mode: "merge-pr",
              closing_sentence: MOCK_CLOSING_SENTENCES["merge-pr"],
            },
          },
        ],
      );
      if (checks === "failure") {
        expect(github.merges()).toHaveLength(0);
        expect((await detail()).status).toBe("active");
        writeFileSync(
          evidence("failed-checks-policy-hold.json"),
          JSON.stringify({ tool: result, record: await detail() }, null, 2),
        );
        github.setChecks([{ name: "linux-checks", status: "completed", conclusion: "success" }]);
        await request(app, `Check ${key} again.`, [
          {
            name: "settle_task",
            args: {
              task_id: row.id,
              mode: "merge-pr",
              closing_sentence: MOCK_CLOSING_SENTENCES["merge-pr"],
            },
          },
        ]);
      }
      await expect.poll(detail, { timeout: 30_000 }).toMatchObject({
        status: "done",
        closedReason: "merged",
        policies: { autonomy: { value: true, source: "task" } },
      });
      expect(github.merges()).toHaveLength(1);
      writeFileSync(
        evidence(`ready-policy-merge-${checks}.json`),
        JSON.stringify({ tool: result, record: await detail(), merges: github.merges() }, null, 2),
      );
      const refused = await edit(app, `Ask before merging ${key}.`, { task: key, autonomy: "off" });
      expect(refused.results[0]).toContain("Policies can only change");
      expect((await detail()).policies?.autonomy.value).toBe(true);
      if (checks === "success") {
        await resizeWindow(app.app, app.page, { width: 1440, height: 1000 });
        await openRecord(app, key, "landed");
        await recordCard(app.page).screenshot({ path: evidence("record-closed.png") });
      }
    } finally {
      await app.close();
      await github.close();
    }
  });
