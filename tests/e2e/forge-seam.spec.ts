import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SYNC_CAP_MS } from "../../src/core/jobs/jobManager";
import { openDatabase } from "../../src/core/storage/db";
import { CHECKS_ABSENT_WORDS } from "../../src/shared/checkSnapshot";
import {
  CHECK_WORDS,
  changeLinesShortWords,
  changeLinesWords,
  MERGE_WORDS,
  RIGOR_WORDS,
} from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { putInLine } from "./rails";
import { MOCK_SENT_UP_CARD_TITLE, SEND_UP_PROMPT_MARKER, sendUp } from "./scenarios/sendUp";
import { factsStrip, shownCard } from "./stack";

/**
 * The forge seam (git integration PR 1.1, `docs/forge.md`), the way a
 * person meets it. A project lives on a plain Git host - not GitHub - so
 * what the app says and does comes from the seam rather than from GitHub's
 * tool: a crewmate saves its work and sends its working copy up, the host
 * finds that copy where the project lives and reads it green with no
 * checks, the completion card names the change by its working copy and
 * shows the task's care, and the captain's click fast-forwards the
 * host's default branch onto exactly that version. GitHub's tool is never
 * asked anything: a stand-in that logs every call is first on the app's
 * path, and its log stays empty.
 *
 * The host is a bare repository on this Mac standing in for
 * `git.example.test` through git's own `insteadOf`, so the project's
 * recorded address is a real host name while every push stays on disk.
 */

const HOST = "git.example.test";
const ORIGIN = `https://${HOST}/me/plainhost.git`;

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

/** A folder with one commit on main, optionally on a host. */
function initFolder(dir: string, origin?: { url: string; bare?: string }) {
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  if (!origin) return;
  git("-C", dir, "remote", "add", "origin", origin.url);
  if (origin.bare) {
    // The recorded address is a host name; git itself sends it to the disk.
    git("-C", dir, "config", `url.${origin.bare}.insteadOf`, origin.url);
    git("-C", dir, "push", "origin", "HEAD:refs/heads/main");
    git("-C", dir, "fetch", "origin");
  }
}

let launched: LaunchedApp;
let bare: string;
let ghLog: string;

/** A `gh` first on PATH that logs every call and answers none. */
function writeLoggingGh(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "gh-calls.log");
  const path = join(dir, "gh");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`);
  chmodSync(path, 0o755);
  return log;
}

test.beforeAll(async () => {
  const userDataDir = scratchDir("infinitary-forge-seam-");
  bare = join(userDataDir, "host.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const plain = join(userDataDir, "plainhost");
  initFolder(plain, { url: ORIGIN, bare });
  // INF-1099: the host takes a second longer than the crewmate's shell
  // waits, as a busy Mac does, so the push always finishes as a background
  // job and the card goes up from that job's exit.
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\nsleep ${SYNC_CAP_MS / 1000 + 1}\n`);
  chmodSync(hook, 0o755);
  const onGitHub = join(userDataDir, "meterlab");
  initFolder(onGitHub, { url: "https://github.com/o/meterlab.git" });
  const keptLocal = join(userDataDir, "ledger");
  initFolder(keptLocal, { url: "https://github.com/o/ledger.git" });
  const notes = join(userDataDir, "notes");
  initFolder(notes);

  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-plain",
    path: plain,
    name: "plainhost",
    setupKind: "clone",
    origin: ORIGIN,
    runsOn: null,
    delivery: "direct-pr",
    addedAt: 1,
  });
  seedProject(db, {
    id: "repo-gh",
    path: onGitHub,
    name: "meterlab",
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: 2,
  });
  // On GitHub, but the captain keeps its changes on this Mac.
  seedProject(db, {
    id: "repo-local",
    path: keptLocal,
    name: "ledger",
    setupKind: "clone",
    origin: "https://github.com/o/ledger.git",
    runsOn: null,
    delivery: "local-only",
    addedAt: 3,
  });
  seedProject(db, {
    id: "repo-notes",
    path: notes,
    name: "notes",
    setupKind: "init",
    delivery: "local-only",
    addedAt: 4,
  });
  db.close();
  const bin = join(userDataDir, "bin");
  ghLog = writeLoggingGh(bin);
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [sendUp],
    userDataDir,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
});

test.afterAll(async () => {
  await launched.close();
});

test("a project on a plain Git host: the work is sent up, the card names it there, and putting it in moves the host", async () => {
  const { page } = launched;
  const title = `plainhost ${SEND_UP_PROMPT_MARKER}`;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");

  // The seam found the sent-up working copy with no checks, and the scripted
  // crew explicitly declared it ready before offering the completion card.
  await expect(shownCard(page, MOCK_SENT_UP_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
  const board = await page.evaluate(() => window.infinitary.tasks.board());
  const task = board.tasks.find((row) => row.title === title);
  expect(task).toBeDefined();
  // The change goes by the branch the app named, which the task's record keeps.
  const branch = task?.repo?.branch ?? "";
  expect(branch).not.toBe("");
  const sentUp = git("-C", bare, "rev-parse", `refs/heads/${branch}`);

  // The host's facts: the task's effective care (the mock asks for Quick),
  // the change by its working copy's name (it has no number and no page
  // there), and the checks.
  const frame = cardBody(page, MOCK_SENT_UP_CARD_TITLE);
  const facts = factsStrip(frame);
  await expect(facts.care).toHaveText(RIGOR_WORDS.quick);
  await expect(facts.change).toHaveText(branch);
  await expect(facts.change.locator("a")).toHaveCount(0);
  await expect(facts.checks).toHaveText(CHECKS_ABSENT_WORDS);
  expect(await factsStrip(frame).facts()).not.toContain("crew-verdict");
  // The lines the sent-up change adds and deletes, as git counts them where
  // the project lives (INF-820).
  let added = 0;
  let deleted = 0;
  for (const line of git("-C", bare, "diff", "--numstat", `main...${branch}`).split("\n")) {
    const [plus, minus] = line.split("\t");
    added += Number(plus) || 0;
    deleted += Number(minus) || 0;
  }
  expect(added).toBeGreaterThan(0);
  // The signed counts in the open, the words on rest (INF-3709's plan).
  await expect(facts.lines).toHaveText(changeLinesShortWords(added, deleted));
  await expect(facts.cell("lines")).toHaveAttribute("title", changeLinesWords(added, deleted));
  await expect(facts.strip).not.toContainText("GitHub");
  await page.screenshot({ path: test.info().outputPath("forge-seam-plain-host-card.png") });

  // The captain puts it in: the task's own put-in line, and the host's
  // default branch moves onto exactly the version that was checked. The
  // receipt's words, naming where it went in, are changeMerge.test.ts's.
  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
  await expect(putInLine(page, task?.key as string)).toBeVisible({ timeout: 30_000 });
  expect(git("-C", bare, "rev-parse", "refs/heads/main")).toBe(sentUp);
  await expect
    .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), task?.id as string))
    .toMatchObject({ status: "done", closedReason: "merged" });
  const detail = await page.evaluate(
    (id) => window.infinitary.tasks.detail(id),
    task?.id as string,
  );
  // INF-1555 F1, the captain's split choice: no hosted checks is a fact, not an invented passing result.
  expect(detail?.delivery).toMatchObject({
    changeLabel: branch,
    checks: { headSha: sentUp, items: [], absenceDeclared: true },
  });
  expect(detail?.delivery).not.toHaveProperty("crewVerdict");
  expect(detail?.delivery?.ci).toBeUndefined();
  expect(detail?.delivery?.prNumber).toBeUndefined();
  const feed = (await page.evaluate(() => window.infinitary.feed.recent()))
    .map((line) => line.text)
    .join("\n");
  expect(feed).not.toMatch(/\bgh\b|GitHub|PR merge blocked/);
  // Nothing on this path asked GitHub's tool anything.
  expect(existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "").toBe("");
});
