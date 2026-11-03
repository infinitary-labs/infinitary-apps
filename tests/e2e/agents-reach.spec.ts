import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { hostEnv } from "../../src/core/hostEnv";
import { SYNC_CAP_MS } from "../../src/core/jobs/jobManager";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import automationManifest from "../../src/panels/automation/manifest.json" with { type: "json" };
import { AUTOMATION_STATE_WORDS } from "../../src/shared/automationWords";
import {
  fixedHoldWords,
  overrideCellWords,
  overrideWords,
  standingOverrideWords,
  withoutHoldWords,
} from "../../src/shared/holds";
import type { TaskView } from "../../src/shared/tasks";
import { CHECK_WORDS, MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { askFirstmate, bubbleWords, mateBubble } from "./lastTurn";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { resizeWindow } from "./layout";
import { FM_SYSTEM_MARKER, REVIEWED_TIER_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { latestServedTurn, providerMessages } from "./providerRequest";
import {
  dockRegion,
  expandDock,
  feedLine,
  hideRecord,
  openGroup,
  pressRow,
  putInLine,
  recordCard,
  recordFrame,
  reportLine,
  startedLine,
} from "./rails";
import { readSavedData } from "./savedData";
import {
  agentsReach,
  captainWords,
  REACH_AUDIT_CARD_TITLE,
  REACH_AUDIT_PROJECT,
  REACH_AUDIT_RULE,
  REACH_READ_STEER,
  REACH_READ_WORDS,
  REACH_RERUN_CARD_TITLE,
  REACH_RERUN_CHANGE,
  REACH_RERUN_CHECK,
  REACH_RERUN_HOLDS,
  REACH_RERUN_MARKER,
  REACH_RERUN_PATH,
  REACH_RERUN_REPLY,
  REACH_RULE_CHANGE,
  REACH_RULE_DONE_TITLE,
  REACH_RULE_HOLDS,
  REACH_RULE_MARKER,
  REACH_RULE_REPLY,
  REACH_RULE_WORDS,
  REACH_STOP_CARD_TITLE,
  REACH_STOP_HOLDS,
  REACH_STOP_STEER,
  REACH_STOP_WORDS,
} from "./scenarios/agentsReach";
import {
  MOCK_REVIEW_ASK_CARD_TITLE,
  MOCK_REVIEW_CAP_CARD_TITLE,
  MOCK_REVIEWED_CHANGE,
  REREVIEW_PROMPT_MARKER,
  reviewedTier,
} from "./scenarios/reviewedTier";
import { settingsSection } from "./settings";
import { cardReply, factsStrip, showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * The agent's-reach story, end to end (INF-484 ring 4, the INF-140 story):
 * the captain's words pass the holds that rest on a verdict, once and on the
 * record, and nothing passes the limits that rest on a fact.
 *
 * - Promised result, in five sections: (1) a reviewed task at its review
 *   cap and with failed checks hears "stop the review and merge it": one
 *   override row on its timeline and one feed line, the override cell on its
 *   completion card's strip, the merge at the version the reviewer last read
 *   with no re-review, and the review task retired; (2) words naming
 *   GitHub's required review pass asking first but are refused in words at
 *   GitHub's rule, a fixed limit, and the captain merges on GitHub himself;
 *   (3) a crewmate refused its second rerun reports, the first mate asks,
 *   and the captain's choice relayed as an override lets it rerun once more;
 *   (4) the weekly audit rule, set to run once now, starts exactly one audit
 *   task; (5) the corpus export counts each override per hold, and every
 *   refusal any agent was served names its hold: a soft hold's way out, or
 *   a fixed limit as fixed.
 * - Data: a disposable development home with two projects (meterlab, and
 *   infinitary for the audit), the GitHub stand-in serving each task's
 *   change and its checks, and the mock models, scripted by `reviewedTier`
 *   and `agentsReach`; the captain's words are typed into the composer.
 * - Completion signal: the forge's own records (merges, reruns), the task
 *   record, the cards and the export's manifest.
 * - Platform prerequisites: the hermetic launcher; node runs the export.
 * - Shared resources: none; its own userData, HOME, ports and stand-ins.
 */

const REPO_NAME = "meterlab";
const BUILDER_TITLE = `${REPO_NAME} ${REVIEWED_TIER_PROMPT_MARKER}`;
const RULE_TITLE = `${REPO_NAME} ${REACH_RULE_MARKER}`;
const RERUN_TITLE = `${REPO_NAME} ${REACH_RERUN_MARKER}`;
const FAILED = [{ name: REACH_RERUN_CHECK, status: "completed", conclusion: "failure" }];
const PASSED = [{ name: REACH_RERUN_CHECK, status: "completed", conclusion: "success" }];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

let repoDir: string;
let userDataDir: string;
let launched: LaunchedApp;
let github: GitHubStub;
/** The builder's readings so far (`builderReads`). */
let readings = 0;

/** A task branch's commit now: the head of its change on GitHub. */
const branchHead = (branch: string) => git(repoDir, "rev-parse", `refs/heads/${branch}`);

/** The builder pushes its fix: one more commit on its own branch, the change's new head. */
function pushFix(branch: string, subject: string): string {
  const tip = branchHead(branch);
  const next = git(repoDir, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", subject);
  git(repoDir, "update-ref", `refs/heads/${branch}`, next, tip);
  return next;
}

/**
 * The builder's own check_change after it pushes, through the app: the
 * captain asks, the first mate relays it, and the scripted builder reads the
 * head and its checks and, on green, revalidates it (`agentsReach`). The app
 * is the one writer while it runs (INF-1148): a write from here collided with
 * its own and failed with "database is locked".
 */
async function builderReads(taskId: string, head: string, ci: "green" | "red"): Promise<void> {
  // Each reading is its own captain turn, told apart by its count: the red
  // reading is at the version the last green one read.
  readings += 1;
  const words = `${REACH_READ_WORDS} (reading ${readings})`;
  const read = launched.mockProvider?.scriptFirstmateTurn(captainWords(words), [
    { name: "steer_crewmate", args: { task_id: taskId, message: REACH_READ_STEER } },
  ]);
  if (!read) throw new Error("this journey runs on the mock provider");
  await send(words);
  await expect
    .poll(read.outcome, { timeout: 30_000 })
    .toEqual(expect.objectContaining({ state: "closed" }));
  await expect.poll(() => stored(taskId), { timeout: 30_000 }).toMatchObject({ ci, headSha: head });
  if (ci === "green")
    await expect
      .poll(() => stored(taskId)?.liveValidation?.runs.some((run) => run.head === head), {
        timeout: 30_000,
      })
      .toBe(true);
}

async function send(text: string): Promise<void> {
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** The first board row that matches, once the board holds one. */
async function boardRow(match: (task: TaskView) => boolean): Promise<TaskView> {
  const find = async () =>
    (await launched.page.evaluate(() => window.infinitary.tasks.board())).tasks.find(match) ?? null;
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  return (await find()) as TaskView;
}

const detail = (id: string) =>
  launched.page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);

/** A task's delivery as the core saved it: the override is a saved fact the view does not carry. */
const stored = (id: string) =>
  readSavedData(userDataDir, (db) => new TaskStore(db).get(id)?.delivery ?? null);

/** The card with this title, once it is up. */
async function cardTitled(title: string) {
  const find = async () =>
    (await launched.page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.title === title,
    ) ?? null;
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  const card = await find();
  if (!card) throw new Error(`the card "${title}" is up`);
  return card;
}

/** A task's override rows: the timeline notes that carry the captain's override. */
async function overrideRows(id: string) {
  return (await detail(id)).events.filter(
    (event) => event.kind === "note" && event.data?.override !== undefined,
  );
}

/** Every tool result and wake any agent was served, once each. */
function servedTexts(): string[] {
  const texts = new Set<string>();
  for (const body of launched.mockProvider?.requestBodies() ?? []) {
    for (const message of providerMessages(body))
      if (message.role === "tool") texts.add(message.text);
    if (body.includes(FM_SYSTEM_MARKER))
      for (const segment of latestServedTurn(body)?.segments ?? [])
        if (segment.kind !== "context" && segment.kind !== "user") texts.add(segment.body);
  }
  return [...texts];
}

test.beforeAll(async () => {
  userDataDir = scratchDir("infinitary-agents-reach-");
  repoDir = seedRepo(userDataDir).repoDir;
  // The audit's project: the Infinitary project the weekly rule names.
  const auditDir = join(userDataDir, REACH_AUDIT_PROJECT);
  execFileSync("git", ["init", "--initial-branch=main", auditDir], { stdio: "pipe" });
  git(auditDir, "config", "user.name", "Test");
  git(auditDir, "config", "user.email", "test@localhost");
  git(auditDir, "commit", "--allow-empty", "-m", "init");
  github = await startGitHubStub();
  // The reviewed builder's change; each later task's change is queued
  // where its section starts (`serveNext`).
  github.servePull({ number: 55, ...MOCK_REVIEWED_CHANGE });
  github.headOf(branchHead);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: repoDir,
    name: REPO_NAME,
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
  });
  // A project an automation rule may name is one the board lists.
  seedProject(db, {
    id: "repo-infinitary",
    path: auditDir,
    name: REACH_AUDIT_PROJECT,
    setupKind: "clone",
    origin: "https://github.com/o/infinitary.git",
    runsOn: null,
    delivery: "direct-pr",
    key: "INF",
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [agentsReach, reviewedTier],
    userDataDir,
    // The schedule's pass and the check rereads run on the app's one tick.
    env: { ...github.env, ...SHORT_TICK },
  });
});

test.afterAll(async () => {
  await launched.close();
  await github.close();
});

test("the captain's words pass a soft hold once on the record, a fixed limit refuses in words, and the audit counts them", async () => {
  // Five journeys joined, each keeping the minute it would have had.
  test.setTimeout(5 * 60_000);
  const { page } = launched;
  const mockProvider = launched.mockProvider;
  if (!mockProvider) throw new Error("this journey runs on the mock provider");
  const out = (name: string) => test.info().outputPath(name);
  await resizeWindow(launched.app, page, { width: 1280, height: 900 });
  await expandDock(page, "activity");
  const merged: { number: number; sha: string }[] = [];

  await test.step("1. the review cap and red checks, then stop the review and merge it", async () => {
    await send(`${SPAWN_PROMPT_MARKER} ${BUILDER_TITLE}`);
    const builder = await boardRow((task) => task.title === BUILDER_TITLE);
    await expect(startedLine(page, builder.key)).toBeVisible({ timeout: 30_000 });
    await expect(reportLine(page, builder.key).first()).toBeVisible({ timeout: 30_000 });
    const review = await boardRow((task) => task.reviewOf === builder.id);
    await expect(shownCard(page, MOCK_REVIEW_ASK_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => detail(builder.id), { timeout: 30_000 })
      .toMatchObject({ delivery: expect.objectContaining({ reviewVerdict: "findings" }) });

    // Two re-reviews at two new versions; the third findings is past the cap.
    const branch = `fm/task-${builder.id}`;
    let reviewed = "";
    for (const [round, subject] of [
      [2, "fix: await the meter snapshot"],
      [3, "fix: keep the meter steady"],
    ] as const) {
      reviewed = pushFix(branch, subject);
      await builderReads(builder.id, reviewed, "green");
      await send(REREVIEW_PROMPT_MARKER);
      await expect
        .poll(() => detail(builder.id), { timeout: 30_000 })
        .toMatchObject({
          delivery: expect.objectContaining({ reviewSha: reviewed, reviewVerdict: "findings" }),
        });
    }
    await expect
      .poll(() => detail(builder.id), { timeout: 30_000 })
      .toMatchObject({
        delivery: expect.objectContaining({ reviewSha: reviewed, reviewVerdict: "findings" }),
      });
    const capCard = await cardTitled(MOCK_REVIEW_ASK_CARD_TITLE);
    // The version the reviewer last read fails its checks too.
    github.setChecks(FAILED);
    await builderReads(builder.id, reviewed, "red");
    await showCard(page, MOCK_REVIEW_ASK_CARD_TITLE);
    await regionShot(shownCard(page, MOCK_REVIEW_ASK_CARD_TITLE), out("1-review-cap-card.png"));

    // The captain's own words, typed: the first mate declares the override
    // they pass, retires its cap card and relays them to the builder.
    const reviewerSteers = (await detail(review.id)).events.filter(
      (event) => event.kind === "steered",
    ).length;
    const reviewRows = (await detail(builder.id)).events.filter(
      (event) => event.kind === "review",
    ).length;
    const stop = mockProvider.scriptFirstmateTurn(captainWords(REACH_STOP_WORDS), [
      {
        name: "update_task",
        args: { task: builder.id, override: { holds: REACH_STOP_HOLDS, until: "version" } },
      },
      {
        name: "close_card",
        args: { card_id: capCard.id, reason: "The captain answered it in his own words." },
      },
      { name: "steer_crewmate", args: { task_id: builder.id, message: REACH_STOP_STEER } },
    ]);
    await send(REACH_STOP_WORDS);
    await expect
      .poll(stop.outcome, { timeout: 30_000 })
      .toEqual(expect.objectContaining({ state: "closed" }));
    expect(stored(builder.id)?.override).toMatchObject({
      words: REACH_STOP_WORDS,
      holds: REACH_STOP_HOLDS,
      until: "version",
      head: reviewed,
    });
    // One override row, and it is the feed's one line for it.
    const rows = await overrideRows(builder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.feed).toBe(true);
    expect(rows[0]?.text).toBe(
      overrideWords({ words: REACH_STOP_WORDS, holds: REACH_STOP_HOLDS, until: "version" }),
    );
    const overrideRow = rows[0]?.id;
    // It is its own row in the record's Activity, folded under nothing.
    expect(
      (await detail(builder.id)).activityLog.filter((row) => row.id === overrideRow),
    ).toHaveLength(1);
    await expect(feedLine(page, rows[0]?.text ?? "")).toHaveCount(1);
    await regionShot(dockRegion(page, "activity"), out("1-override-feed-line.png"));

    // The builder's completion card at the reviewed version: the strip
    // names what his words passed, with his words on the cell.
    await cardTitled(REACH_STOP_CARD_TITLE);
    await showCard(page, REACH_STOP_CARD_TITLE);
    const facts = factsStrip(cardBody(page, REACH_STOP_CARD_TITLE));
    await expect(facts.override).toHaveText(overrideCellWords(REACH_STOP_HOLDS));
    // His words ride the cell's title.
    await expect(facts.cell("override")).toHaveAttribute("title", rows[0]?.text ?? "");
    await regionShot(shownCard(page, REACH_STOP_CARD_TITLE), out("1-completion-card-override.png"));

    // The captain's merge: at the version the reviewer last read, with no
    // re-review, and the review task goes with its builder. On failed checks
    // his override passes, the merge says it merges now (INF-756).
    const merge = shownCard(page, REACH_STOP_CARD_TITLE).getByRole("button", {
      name: MERGE_WORDS["merge-pr"],
      exact: true,
    });
    await expect(facts.checks).toHaveText(CHECK_WORDS.red);
    await expect(merge).toBeVisible();
    await merge.click();
    await expect(putInLine(page, builder.key)).toBeVisible({ timeout: 30_000 });
    expect(github.merges()).toEqual([
      {
        number: 55,
        sha: reviewed,
        method: "squash",
        title: MOCK_REVIEWED_CHANGE.title,
        message: MOCK_REVIEWED_CHANGE.body,
      },
    ]);
    merged.push({ number: 55, sha: reviewed });
    await expect
      .poll(() => detail(builder.id))
      .toMatchObject({ status: "done", closedReason: "merged" });
    await expect
      .poll(() => detail(review.id))
      .toMatchObject({ status: "dropped", closedReason: "superseded" });
    const after = await detail(builder.id);
    expect(after.events.filter((event) => event.kind === "review")).toHaveLength(reviewRows);
    expect(after.events.some((event) => event.kind === "cap_reset")).toBe(false);
    expect(
      (await detail(review.id)).events.filter((event) => event.kind === "steered"),
    ).toHaveLength(reviewerSteers);
    await page.screenshot({ path: out("1-merged.png") });

    // The merged task's record: its Activity holds the override row.
    await expandDock(page, "now");
    await openGroup(page, "landed");
    await pressRow(page, builder.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", builder.id);
    const record = recordFrame(page);
    await pressKey(record.locator('[data-record-section="timeline"] > summary'), "Enter");
    const overrideLine = record
      .locator('[data-record-event="note"]')
      .filter({ hasText: REACH_STOP_WORDS });
    await expect(overrideLine).toHaveCount(1);
    // The rows before the latest few fold under Show earlier.
    if (!(await overrideLine.isVisible()))
      await pressKey(record.locator("[data-record-earlier] > summary"), "Enter");
    // The record repaints its rows as the merge's last events arrive, so
    // the row is found again at the moment it is brought into view.
    await expect(overrideLine).toBeVisible();
    await overrideLine.evaluate((row) => row.scrollIntoView({ block: "center" }));
    await regionShot(recordCard(page), out("1-record-activity.png"));
    await hideRecord(page).click();
    await expect(recordCard(page)).toHaveCount(0);
  });

  await test.step("2. words naming GitHub's rule pass asking first and are refused at the rule", async () => {
    // INF-1127: from here on a commit takes a second longer than the
    // crewmate's shell waits, as on a busy Mac, so each crewmate's commit
    // finishes as a background job and it carries on from that job's exit.
    // The app's own git skips the project's hooks.
    const hook = join(repoDir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nsleep ${SYNC_CAP_MS / 1000 + 1}\n`);
    chmodSync(hook, 0o755);
    github.setChecks(PASSED);
    github.serveNext({ ...REACH_RULE_CHANGE, mergeableState: "blocked" });
    await send(`${SPAWN_PROMPT_MARKER} ${RULE_TITLE}`);
    const task = await boardRow((row) => row.title === RULE_TITLE);
    await cardTitled(REACH_RULE_DONE_TITLE);
    await expect
      .poll(async () => (await detail(task.id)).delivery?.headSha, { timeout: 30_000 })
      .toBe(branchHead(`fm/task-${task.id}`));
    const head = branchHead(`fm/task-${task.id}`);

    // The captain's words: his merge (asking first, a soft hold) and
    // skipping GitHub's required review (a fixed limit).
    await askFirstmate(page, REACH_RULE_WORDS);
    await expect(bubbleWords(mateBubble(page))).toHaveText(REACH_RULE_REPLY);
    // His words passed the soft hold they name, for this version, on the record...
    expect(stored(task.id)?.override).toMatchObject({
      words: REACH_RULE_WORDS,
      holds: REACH_RULE_HOLDS,
      until: "version",
      head,
    });
    expect(await overrideRows(task.id)).toHaveLength(1);
    // ...and the merge they asked for met GitHub's rule, which refused it
    // in its own words: a fixed limit no one's word passes.
    expect(servedTexts().some((text) => text.includes(fixedHoldWords("host-rules")))).toBe(true);
    expect(github.merges()).toEqual(merged.map((change) => expect.objectContaining(change)));
    expect(github.requests()).not.toContain(
      `PUT /repos/o/meterlab/pulls/${REACH_RULE_CHANGE.number}/merge`,
    );
    await regionShot(page.locator("[data-last-turn]"), out("2-fixed-limit-reply.png"));

    // The captain merges on GitHub's own page; his click on the card closes
    // the task as merged, with no merge asked of GitHub.
    github.mergeByHand(REACH_RULE_CHANGE.number);
    await showCard(page, REACH_RULE_DONE_TITLE);
    await regionShot(shownCard(page, REACH_RULE_DONE_TITLE), out("2-override-asking-first.png"));
    await shownCard(page, REACH_RULE_DONE_TITLE)
      .locator("[data-card-actions] button[data-card-action-default]")
      .click();
    await expect
      .poll(() => detail(task.id), { timeout: 30_000 })
      .toMatchObject({ status: "done", closedReason: "merged" });
    expect(github.merges()).toEqual(merged.map((change) => expect.objectContaining(change)));
  });

  await test.step("3. the crew records a second evidenced rerun without a host allowance", async () => {
    github.setChecks(FAILED);
    github.serveNext(REACH_RERUN_CHANGE);
    await send(`${SPAWN_PROMPT_MARKER} ${RERUN_TITLE}`);
    const task = await boardRow((row) => row.title === RERUN_TITLE);
    await expect
      .poll(() => github.reruns(), { timeout: 30000 })
      .toEqual([`POST ${REACH_RERUN_PATH}`, `POST ${REACH_RERUN_PATH}`]);
    await expect(reportLine(page, task.key)).toBeVisible({ timeout: 30000 });
    expect(await overrideRows(task.id)).toEqual([]);
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).filter(
        (card) => card.taskId === task.id,
      ),
    ).toEqual([]);
  });

  await test.step("4. the weekly audit rule, set to run once now, starts its one task", async () => {
    // The audit's project, by its repository's name on the board.
    const project = (await page.evaluate(() => window.infinitary.tasks.board())).projects.find(
      (entry) => entry.repo?.name === REACH_AUDIT_PROJECT,
    );
    if (!project) throw new Error("the board lists the Infinitary project");
    // Saved as a draft first, so it waits in Settings for its picture; only
    // turning it on afterwards lets it run, so the order decides, not a clock.
    const rule = {
      name: REACH_AUDIT_RULE.name,
      prompt: REACH_AUDIT_RULE.prompt,
      projectId: project.id,
    };
    const saved = await page.evaluate((draft) => window.infinitary.automation.save(draft), {
      ...rule,
      spec: { kind: "once" as const, at: Date.now() + 60 * 60_000 },
    });
    expect(saved).toMatchObject({ state: "draft", projectId: project.id });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: automationManifest.title, exact: true }).click();
    const row = settingsSection(page, "automation").locator(`[data-automation-row="${saved.id}"]`);
    await expect(row).toContainText(AUTOMATION_STATE_WORDS.draft);
    await page.screenshot({ path: out("4-automation-rule.png") });
    await page.keyboard.press("Escape");
    const on = await page.evaluate((turnOn) => window.infinitary.automation.save(turnOn), {
      ...rule,
      id: saved.id,
      spec: { kind: "once" as const, at: Date.now() + 2_000 },
      enable: true,
    });
    expect(on).toMatchObject({ id: saved.id, state: "enabled" });

    const audit = await boardRow((entry) => entry.title === REACH_AUDIT_RULE.name);
    expect(audit.projectId).toBe(project.id);
    await cardTitled(REACH_AUDIT_CARD_TITLE);
    // Once: the one-time rule ran, its run was handled and it left the
    // list, so nothing is left to fire; it started one audit.
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.automation.list())).rules.map(
          (rule) => rule.id,
        ),
      )
      .not.toContain(saved.id);
    const audits = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.filter(
      (entry) => entry.title === REACH_AUDIT_RULE.name,
    );
    expect(audits).toHaveLength(1);
    await showCard(page, REACH_AUDIT_CARD_TITLE);
    await regionShot(shownCard(page, REACH_AUDIT_CARD_TITLE), out("4-audit-card.png"));
  });

  await test.step("5. the export counts each override per hold, and every refusal names its hold", async () => {
    const refusals = servedTexts().filter((text) =>
      /\b(?:refused|Refused)\b|^Cannot merge\b/m.test(text),
    );
    // A refusal that names its hold ends with that hold's own sentence.
    const unnamed = refusals.filter((text) => withoutHoldWords(text) === text);
    await launched.close();
    const corpus = scratchDir("infinitary-agents-reach-corpus-");
    execFileSync(
      process.execPath,
      ["scripts/export-corpus.ts", "--user-data", userDataDir, "--out", corpus],
      { env: hostEnv(), stdio: "pipe" },
    );
    const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8")) as {
      rigor: { overrides_by_hold: Record<string, number>; metrics: Record<string, number | null> };
    };
    // The counts come from the holds the first mate declared, one per override.
    const declared = [REACH_STOP_HOLDS, REACH_RULE_HOLDS];
    const expected: Record<string, number> = {};
    for (const holds of declared)
      for (const hold of holds) expected[hold] = (expected[hold] ?? 0) + 1;
    writeFileSync(
      out("5-metrics.json"),
      `${JSON.stringify(
        {
          overrides_by_hold: manifest.rigor.overrides_by_hold,
          hold_overrides: manifest.rigor.metrics.hold_overrides,
          refusals_served: refusals,
          refusals_naming_no_hold: unnamed,
        },
        null,
        2,
      )}\n`,
    );
    expect(manifest.rigor.overrides_by_hold).toEqual(expected);
    expect(manifest.rigor.metrics.hold_overrides).toBe(declared.length);
    expect(refusals.length).toBeGreaterThan(0);
    expect(unnamed).toEqual([]);
  });
});
