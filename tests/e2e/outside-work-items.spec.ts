import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { cardReaderWritesTitle } from "../../src/shared/i18n/messages.generated";
import {
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalTitle,
} from "../../src/shared/integrations";
import { NOTES_ADD_TOOL, SAMPLE_NOTES } from "../helpers/mcpStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { type GitHubStub, STUB_OPEN_ISSUE, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { readSavedData } from "./savedData";
import {
  OUTSIDE_ANSWERED,
  OUTSIDE_FIX,
  OUTSIDE_ISSUE_ASK,
  OUTSIDE_ISSUE_GOAL,
  OUTSIDE_ISSUE_REPLY,
  OUTSIDE_ISSUE_TITLE,
  OUTSIDE_ISSUE_URL,
  OUTSIDE_ISSUE_WRITES,
  OUTSIDE_TICKET_ASK,
  OUTSIDE_TICKET_GOAL,
  OUTSIDE_TICKET_NOTE,
  OUTSIDE_TICKET_REASON,
  OUTSIDE_TICKET_TITLE,
  outsideIssueCrew,
  outsideTicketCrew,
  outsideWorkItemsFirstmate,
} from "./scenarios/outsideWorkItems";
import { showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * Outside work items, the built-in runbook on by default (docs/runbooks.md,
 * "Outside work items"; INF-6845's approved plan, piece 1).
 *
 * - Promised result: the captain names an outside item; the first mate files
 *   its waiting task in one call, waiting on the fix that merged and shipped
 *   in a recorded release, and that task starts with a brief naming the fix's
 *   first release and its reported summary, and the runbook's crew section,
 *   which an ordinary crewmate's brief never holds.
 *   On GitHub the task is an unsafe data reader: it reads the issue, and its
 *   reply and its close wait as two rows on the app's one approval card;
 *   Only this time sends both, once each, and nothing is sent before.
 *   In the captain's Notes tracker, an MCP server, only the captain's people
 *   write the ticket, so the task is no reader: its call follows the
 *   server's Ask rule, so the app's own card holds it, and Only this time
 *   adds the note once.
 * - Data: a project on GitHub over a bare repository here, the GitHub
 *   stand-in signed in with its one open issue, the fix seeded merged with
 *   its first release recorded, and the MCP notes stand-in
 *   (`tests/helpers/mcpStandIn.ts`) over a scratch notes file.
 * - Completion signal: the task record, the model's requests, GitHub's
 *   requests and the issue's comments and state, and the notes file.
 * - Not proven here: whether a real model follows the runbook's words; the
 *   first mate and crew are scripted.
 * - Shared resources: none; the app, its folder and every stand-in are this
 *   test's own.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const NOTES_STAND_IN = join(process.cwd(), "tests", "helpers", "mcpStandIn.ts");
const CREW_SECTION = readFileSync(
  join(process.cwd(), "resources", "runbooks", "outside-work-items", "crew.md"),
  "utf8",
);
/** The crew section's first instruction, which only a side-effect task's brief carries. */
const CREW_LINE = CREW_SECTION.split("\n").find((line) => line.startsWith("When ")) ?? "";

let launched: LaunchedApp | undefined;
let github: GitHubStub | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await github?.close();
  github = undefined;
});

/** A fresh folder holding meterlab on GitHub and its fix, merged and first shipped in 1.4.0. */
function arrange(prefix: string): string {
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
    id: "repo-meterlab",
    path: meterlab,
    name: "meterlab",
    setupKind: "clone",
    origin,
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
    addedAt: 1,
  });
  const tasks = new TaskService({ db });
  seedTask(tasks, {
    id: OUTSIDE_FIX.id,
    title: OUTSIDE_FIX.title,
    repoId: "repo-meterlab",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.turns.recordReport(OUTSIDE_FIX.id, {
    text: OUTSIDE_FIX.summary,
    summary: OUTSIDE_FIX.summary,
  });
  seedDelivery(tasks, OUTSIDE_FIX.id, { firstRelease: OUTSIDE_FIX.release });
  tasks.close(OUTSIDE_FIX.id, { status: "done", reason: "merged", actor: "host" });
  db.close();
  seedGitHubSignIn(userDataDir);
  return userDataDir;
}

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function rowTitled(page: Page, title: string): Promise<string> {
  let id = "";
  await expect
    .poll(
      async () => {
        const board = await page.evaluate(() => window.infinitary.tasks.board());
        id = board.tasks.find((row) => row.title === title)?.id ?? "";
        return id;
      },
      { timeout: 45_000 },
    )
    .not.toBe("");
  return id;
}

/** The first crewmate request carrying these words, as the provider received it. */
function crewRequest(words: string): string {
  return (
    (launched?.mockProvider?.requestBodies() ?? []).find(
      (body) => body.includes("You are a crewmate") && body.includes(words),
    ) ?? ""
  );
}

/** The brief's line under a wait, as the served request's JSON text carries it. */
const briefText = (request: string) => JSON.stringify(JSON.parse(request || "{}"));

test("an issue on GitHub hears how its fix ended: a reply and a close on one click, after the merge and release", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = arrange("infinitary-outside-issue-");
  github = await startGitHubStub();
  github.setProjects([
    { fullName: "octo/meterlab", private: true, updatedAt: "2026-09-22T10:00:00Z" },
  ]);
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [outsideWorkItemsFirstmate, outsideIssueCrew],
    userDataDir,
    env: github.env,
  });
  const { app, page } = launched;

  await send(page, OUTSIDE_ISSUE_ASK);
  const id = await rowTitled(page, OUTSIDE_ISSUE_TITLE);
  const detail = () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
  // The first mate's one call filed a reader: it only answers in words.
  expect((await detail())?.deliverable).toBe("answer");

  const title = cardReaderWritesTitle({ place: "GitHub" });
  const card = shownCard(page, title);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (one) => one.title === title,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await showCard(page, title);
  const rows = cardBody(page, title).locator("[data-inf-ask-row]");
  await expect(rows).toHaveCount(2, { timeout: 45_000 });
  const [reply, close] = OUTSIDE_ISSUE_WRITES.map((call) => `${call.method} ${call.path}`);
  await expect(rows.nth(0)).toContainText(reply as string);
  await expect(rows.nth(1)).toContainText(close as string);

  // Its brief named the fix's first release and its reported summary, and
  // carried the runbook's crew section.
  const brief = briefText(crewRequest(OUTSIDE_ISSUE_GOAL));
  expect(brief).toContain(OUTSIDE_ISSUE_URL);
  expect(brief).toContain(
    `merged; first shipped in release ${OUTSIDE_FIX.release.version} (${OUTSIDE_FIX.release.url})`,
  );
  expect(brief).toContain(`Reported: ${OUTSIDE_FIX.summary}`);
  expect(brief).toContain(CREW_LINE);
  // It read the issue, and nothing was written before the captain's click.
  expect(github.requests()).toContain(`GET /repos/octo/meterlab/issues/${STUB_OPEN_ISSUE}`);
  expect(github.requests()).not.toContain(reply);
  expect(github.requests()).not.toContain(close);
  expect(github.commentsOn(STUB_OPEN_ISSUE)).toEqual([]);
  expect(github.openIssueState()).toBe("open");

  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    await resizeWindow(app, page, { width: 1100, height: 860 });
    await page.screenshot({ path: join(evidence, "outside-issue-card.png") });
  }
  await pressKey(
    card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
    "Enter",
  );
  await expect
    .poll(() => github?.commentsOn(STUB_OPEN_ISSUE), { timeout: 20_000 })
    .toEqual([OUTSIDE_ISSUE_REPLY]);
  await expect.poll(() => github?.openIssueState(), { timeout: 20_000 }).toBe("closed");
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 45_000 })
    .toContain(OUTSIDE_ANSWERED);
  expect(github.requests().filter((entry) => entry === reply)).toEqual([reply]);
  expect(github.requests().filter((entry) => entry === close)).toEqual([close]);

  // An ordinary crewmate in the same project is served none of it.
  const ordinary = "meterlab check the cold start reading";
  await send(page, `${SPAWN_PROMPT_MARKER} ${ordinary}`);
  await expect.poll(() => crewRequest(ordinary), { timeout: 45_000 }).not.toBe("");
  expect(briefText(crewRequest(ordinary))).not.toContain(CREW_LINE);

  if (evidence) {
    await page.screenshot({ path: join(evidence, "outside-issue-after-click.png") });
    writeFileSync(
      join(evidence, "outside-issue.txt"),
      `Brief:\n${brief}\n\nAfter the click:\n${(await detail())?.outcome ?? ""}\n\nRequests:\n${github.requests().join("\n")}\n\nComments:\n${github.commentsOn(STUB_OPEN_ISSUE).join("\n")}\nState: ${github.openIssueState()}\n`,
    );
  }
});

test("a ticket in the captain's tracker hears how its fix ended through that integration's own card", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = arrange("infinitary-outside-ticket-");
  github = await startGitHubStub();
  const notes = join(scratchDir("infinitary-outside-notes-"), "notes.json");
  writeFileSync(notes, JSON.stringify({ notes: SAMPLE_NOTES }));
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [outsideWorkItemsFirstmate, outsideTicketCrew],
    userDataDir,
    env: github.env,
  });
  const { app, page } = launched;
  await page.evaluate((server) => window.infinitary.integrations.addMcp(server), {
    name: "Notes",
    runs: `'${process.execPath}' '${NOTES_STAND_IN}' stdio modern '${notes}'`,
  });

  await send(page, OUTSIDE_TICKET_ASK);
  const id = await rowTitled(page, OUTSIDE_TICKET_TITLE);
  const detail = () => page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
  // Filed read-only as the guide says, and with no reader mark: only the captain's people write the ticket.
  expect(
    readSavedData(userDataDir, (db) => new TaskStore(db).get(id)?.shape?.unsafe_data_reader),
  ).toBeUndefined();

  const title = integrationApprovalTitle(NOTES_ADD_TOOL, "Notes");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (one) => one.title === title,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await showCard(page, title);
  const card = shownCard(page, title);
  await expect(cardBody(page, title).locator("body")).toContainText(OUTSIDE_TICKET_REASON);
  const brief = briefText(crewRequest(OUTSIDE_TICKET_GOAL));
  expect(brief).toContain(`Reported: ${OUTSIDE_FIX.summary}`);
  expect(brief).toContain(CREW_LINE);
  expect(JSON.parse(readFileSync(notes, "utf8")).notes).not.toContain(OUTSIDE_TICKET_NOTE);

  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    await resizeWindow(app, page, { width: 1100, height: 860 });
    await page.screenshot({ path: join(evidence, "outside-ticket-card.png") });
  }
  await pressKey(
    card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
    "Enter",
  );
  await expect
    .poll(() => JSON.parse(readFileSync(notes, "utf8")).notes, { timeout: 20_000 })
    .toContain(OUTSIDE_TICKET_NOTE);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 45_000 })
    .toContain(OUTSIDE_ANSWERED);
  const added = (JSON.parse(readFileSync(notes, "utf8")).notes as string[]).filter(
    (note) => note === OUTSIDE_TICKET_NOTE,
  );
  expect(added).toEqual([OUTSIDE_TICKET_NOTE]);
  if (evidence)
    writeFileSync(
      join(evidence, "outside-ticket.txt"),
      `Brief:\n${brief}\n\nAfter the click:\n${(await detail())?.outcome ?? ""}\n\nNotes:\n${readFileSync(notes, "utf8")}\n`,
    );
});
