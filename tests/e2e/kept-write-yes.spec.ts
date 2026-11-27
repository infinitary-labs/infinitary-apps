import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { KnowledgeService } from "../../src/core/knowledge/knowledgeService";
import {
  notStandingWords,
  passedNothingWords,
  sentOnYesLine,
} from "../../src/core/orchestrator/keptWriteYes";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { cardReaderWritesTitle } from "../../src/shared/i18n/messages.generated";
import { sendWriteWords } from "../../src/shared/vocabulary";
import type { ForgeWriteAsk } from "../../src/shared/writeAsk";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type GitHubStub, STUB_OPEN_ISSUE, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { openRecord, recordFrame, showRecordTab } from "./rails";
import { readSavedData } from "./savedData";
import {
  INTAKE_DIRECTION,
  KEPT_REPLY,
  KEPT_REPLY_CARD_TITLE,
  KEPT_REPLY_OUTCOME,
  KEPT_REPLY_WRITE,
  keptWriteCrew,
  keptWriteFirstmate,
  SEND_AS_READER,
  SEND_ON_CLICK,
  SEND_ON_DIRECTION,
  SEND_ON_UNHEARD,
} from "./scenarios/keptWriteYes";
import { showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * A kept write passed by a yes that still stands (INF-6987's approved plan,
 * piece A1; docs/forge.md, "A write that asks").
 *
 * - Promised result: a side-effect task's reply on its own project, which
 *   the app keeps for the captain's click, goes to GitHub once with no card
 *   when its crewmate names a project direction heard from the captain, and
 *   the task's Activity quotes the words it rested on; a reply that names no
 *   yes sends nothing until the captain's click, which sends it once; one
 *   that names a direction never heard from the captain is refused with
 *   nothing kept or sent; and an unsafe data reader's reply that names the
 *   heard direction waits on the reader's approval card, sending nothing.
 * - Data: meterlab on GitHub over a bare repository here, the GitHub stand-in
 *   signed in with its one open issue, and for the first journey the
 *   captain's intake direction for meterlab, heard in their own words, or
 *   saved on the first mate's own judgment.
 * - Completion signal: GitHub's requests and the issue's comments, the
 *   task's kept ask, its Activity and its outcome.
 * - Not proven here: whether a real model judges that a reply plainly
 *   follows the direction's words; the first mate and crew are scripted.
 * - Shared resources: none; the app, its folder and the stand-in are this
 *   test's own.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const REPLY_CALL = `${KEPT_REPLY_WRITE.method} ${KEPT_REPLY_WRITE.path}`;
const METERLAB = { id: "repo-meterlab", name: "meterlab" };

let launched: LaunchedApp | undefined;
let github: GitHubStub | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await github?.close();
  github = undefined;
});

/**
 * A fresh folder holding meterlab on GitHub, and the intake direction when
 * asked: heard in the captain's own words, or saved on the first mate's own
 * judgment with no heard mark.
 */
function arrange(prefix: string, direction?: "heard" | "unheard"): string {
  const userDataDir = scratchDir(prefix);
  const origin = "https://github.com/octo/meterlab.git";
  const bare = join(userDataDir, "github-meterlab.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const meterlab = join(userDataDir, "meterlab");
  git("init", "--initial-branch=main", meterlab);
  git("-C", meterlab, "config", "user.name", "Test");
  git("-C", meterlab, "config", "user.email", "test@localhost");
  git("-C", meterlab, "commit", "--allow-empty", "-m", "init");
  git("-C", meterlab, "remote", "add", "origin", origin);
  git("-C", meterlab, "config", `url.${bare}.insteadOf`, origin);
  git("-C", meterlab, "push", "origin", "HEAD:refs/heads/main");
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: METERLAB.id,
    path: meterlab,
    name: METERLAB.name,
    setupKind: "clone",
    origin,
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
    addedAt: 1,
  });
  db.close();
  if (direction) {
    const project = { ...METERLAB, path: meterlab };
    const knowledge = new KnowledgeService({
      dir: join(userDataDir, "knowledge"),
      projects: { list: () => [project], get: (id) => (id === project.id ? project : undefined) },
    });
    try {
      knowledge.directions.change({
        op: "add",
        id: INTAKE_DIRECTION.id,
        scope: METERLAB.id,
        text: INTAKE_DIRECTION.text,
        ...(direction === "heard"
          ? { reason: "The captain said it in their own words.", heard: { from: "turn" } }
          : { reason: "The first mate saved it on its own judgment." }),
      });
    } finally {
      knowledge.close();
    }
  }
  seedGitHubSignIn(userDataDir);
  return userDataDir;
}

async function launch(userDataDir: string): Promise<LaunchedApp> {
  github = await startGitHubStub();
  github.setProjects([
    { fullName: "octo/meterlab", private: true, updatedAt: "2026-09-22T10:00:00Z" },
  ]);
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [keptWriteFirstmate, keptWriteCrew],
    userDataDir,
    env: github.env,
  });
  await resizeWindow(launched.app, launched.page, { width: 1100, height: 860 });
  return launched;
}

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function rowTitled(page: Page, title: string): Promise<{ id: string; key: string }> {
  let row = { id: "", key: "" };
  await expect
    .poll(
      async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        const found = board.tasks.find((one) => one.title === title);
        row = { id: found?.id ?? "", key: found?.key ?? "" };
        return row.id;
      },
      { timeout: 45_000 },
    )
    .not.toBe("");
  return row;
}

const keptAsks = (userDataDir: string, id: string) =>
  readSavedData(
    userDataDir,
    (db) => (new TaskStore(db).get(id)?.delivery?.writeAsks ?? []) as ForgeWriteAsk[],
  );

/** The captain's ask in their own words: a project direction lets plain replies go (INF-6987, A1). */
test("a side-effect task's reply that names a heard direction goes to GitHub once, with no card, and its Activity quotes the direction", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = arrange("infinitary-kept-write-yes-", "heard");
  const { page } = await launch(userDataDir);

  await send(page, SEND_ON_DIRECTION.ask);
  const row = await rowTitled(page, SEND_ON_DIRECTION.title);
  const detail = () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), row.id);
  await expect
    .poll(() => github?.commentsOn(STUB_OPEN_ISSUE), { timeout: 60_000 })
    .toEqual([KEPT_REPLY]);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 45_000 })
    .toContain(
      `${KEPT_REPLY_OUTCOME}Sent once on d:${INTAKE_DIRECTION.id}, which still stands, with no card`,
    );
  expect(github?.requests().filter((entry) => entry === REPLY_CALL)).toEqual([REPLY_CALL]);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  expect(cards.map((card) => card.title)).not.toContain(KEPT_REPLY_CARD_TITLE);
  expect(keptAsks(userDataDir, row.id)).toMatchObject([
    {
      method: KEPT_REPLY_WRITE.method,
      path: KEPT_REPLY_WRITE.path,
      yes: `d:${INTAKE_DIRECTION.id}`,
      outcome: { kind: "answered", status: 201 },
    },
  ]);

  await openRecord(page, row.key, row.id);
  await showRecordTab(page, "activity");
  const { text: line } = sentOnYesLine(
    {
      ok: true,
      call: REPLY_CALL,
      place: "GitHub",
      outcome: { kind: "answered", status: 201, requestId: null },
    },
    INTAKE_DIRECTION.text,
  );
  // The line is the crewmate's turn's, so it folds under that turn's report.
  const report = recordFrame(page)
    .locator('[data-record-event="report"]')
    .filter({ hasText: line });
  await expect(report).toHaveCount(1, { timeout: 15_000 });
  await pressKey(report.locator(":scope > summary"), "Enter");
  await expect(report.locator("[data-record-folded]").filter({ hasText: line })).toBeVisible();

  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    await page.screenshot({ path: join(evidence, "kept-write-sent-on-direction.png") });
    writeFileSync(
      join(evidence, "kept-write-sent-on-direction.txt"),
      `Outcome:\n${(await detail())?.outcome ?? ""}\n\nRequests:\n${github?.requests().join("\n")}\n\nComments:\n${github?.commentsOn(STUB_OPEN_ISSUE).join("\n")}\n`,
    );
  }
});

/** The soft hold's other way: the captain's click on the ask's card (INF-6987, A1). */
test("a side-effect task's reply that names no yes waits for the captain's click, which sends it once", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = arrange("infinitary-kept-write-click-");
  const { page } = await launch(userDataDir);

  await send(page, SEND_ON_CLICK.ask);
  const row = await rowTitled(page, SEND_ON_CLICK.title);
  const detail = () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), row.id);
  const card = shownCard(page, KEPT_REPLY_CARD_TITLE);
  await expect(card).toBeVisible({ timeout: 60_000 });
  expect(github?.requests()).not.toContain(REPLY_CALL);
  expect(github?.commentsOn(STUB_OPEN_ISSUE)).toEqual([]);
  const [kept] = keptAsks(userDataDir, row.id);
  expect(kept).toMatchObject({ method: KEPT_REPLY_WRITE.method, path: KEPT_REPLY_WRITE.path });
  expect(kept?.yes).toBeUndefined();
  expect(kept?.sentAt).toBeUndefined();

  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) await page.screenshot({ path: join(evidence, "kept-write-card.png") });
  await pressKey(
    page.getByRole("button", { name: sendWriteWords("GitHub"), exact: true }),
    "Enter",
  );
  await expect
    .poll(() => github?.commentsOn(STUB_OPEN_ISSUE), { timeout: 20_000 })
    .toEqual([KEPT_REPLY]);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 45_000 })
    .toContain(KEPT_REPLY_OUTCOME);
  expect(github?.requests().filter((entry) => entry === REPLY_CALL)).toEqual([REPLY_CALL]);
});

/** An unheard direction is no yes (INF-6987, A1 tests; piece P: a direction saved on the first mate's own judgment). */
test("a side-effect task's reply that names a direction never heard from the captain is refused, with nothing kept or sent", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = arrange("infinitary-kept-write-unheard-", "unheard");
  const { page } = await launch(userDataDir);

  await send(page, SEND_ON_UNHEARD.ask);
  const row = await rowTitled(page, SEND_ON_UNHEARD.title);
  const detail = () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), row.id);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
    .toContain(`${KEPT_REPLY_OUTCOME}${notStandingWords(SEND_ON_UNHEARD.allowance)}`);
  expect(github?.requests()).not.toContain(REPLY_CALL);
  expect(github?.commentsOn(STUB_OPEN_ISSUE)).toEqual([]);
  expect(keptAsks(userDataDir, row.id)).toEqual([]);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  expect(cards.map((card) => card.title)).not.toContain(KEPT_REPLY_CARD_TITLE);
});

/** The captain's pick on INF-6987's reader question: route A, a reader's writes keep the click. */
test("an unsafe data reader's reply that names a heard direction waits on the reader's approval card and sends nothing", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = arrange("infinitary-kept-write-reader-", "heard");
  const { page } = await launch(userDataDir);

  await send(page, SEND_AS_READER.ask);
  const row = await rowTitled(page, SEND_AS_READER.title);
  const detail = () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), row.id);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
    .toContain(passedNothingWords(SEND_AS_READER.allowance));
  const title = cardReaderWritesTitle({ place: "GitHub" });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (one) => one.title === title,
        ),
      { timeout: 45_000 },
    )
    .toBe(true);
  await showCard(page, title);
  const rows = cardBody(page, title).locator("[data-inf-ask-row]");
  await expect(rows).toHaveCount(1, { timeout: 45_000 });
  await expect(rows.nth(0)).toContainText(REPLY_CALL);
  expect(github?.requests()).not.toContain(REPLY_CALL);
  expect(github?.commentsOn(STUB_OPEN_ISSUE)).toEqual([]);
  const [kept] = keptAsks(userDataDir, row.id);
  expect(kept).toMatchObject({ method: KEPT_REPLY_WRITE.method, path: KEPT_REPLY_WRITE.path });
  expect(kept?.yes).toBeUndefined();
  expect(kept?.sentAt).toBeUndefined();

  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) await page.screenshot({ path: join(evidence, "kept-write-reader-card.png") });
});
