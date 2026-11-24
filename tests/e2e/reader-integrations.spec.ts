import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { savedDeliveryReader } from "../../src/core/storage/taskDeliveryFields";
import { taskReadTable } from "../../src/core/storage/taskRecordFields";
import { cardReaderCallsTitle } from "../../src/shared/i18n/messages.generated";
import { INTEGRATION_APPROVAL_WORDS } from "../../src/shared/integrations";
import { fencedSpans } from "../../src/shared/outsideData";
import { NOTES_ADD_TOOL, SAMPLE_NOTES } from "../helpers/mcpStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { savedWriteAsks } from "./apiWriteCases";
import { launchClaudeCrew } from "./claudeCrew";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { READER_RUNTIMES } from "./readerJourney";
import { readSavedData } from "./savedData";
import {
  READER_ANSWERED,
  READER_COUNT_REASON,
  READER_INTEGRATIONS_MARKER,
  READER_ISSUE,
  READER_LIST_REASON,
  READER_LISTED,
  READER_NOTE,
  READER_NOTE_REASON,
  readerIntegrations,
} from "./scenarios/readerIntegrations";
import { shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * An unsafe data reader reaches the captain's integrations (docs/integrations.md,
 * "A reader's integrations"; the captain's approved reader plan, piece 2), on a
 * Pi crewmate and on Claude's own client.
 *
 * - Promised result: the reader lists the integrations through its typed tool.
 *   Its read of the stand-in integration, which the captain set to Always
 *   allow, runs with no card and reaches it marked whole as data from outside,
 *   and the host records that the reader holds something of the captain's.
 *   The MCP notes server's read, though set to Always allow too, its change on
 *   that server and its issue where its project lives all wait as ticked rows
 *   on its one approval card, which offers only Not now and Only this time.
 *   The captain unticks both changes by keys and chooses Only this time: the
 *   notes read runs once and reaches the reader marked, the note is never
 *   added and GitHub is never asked to open the issue.
 * - Data: a project on GitHub, the GitHub stand-in signed in, the stand-in
 *   integration over a scratch items file with two items, and the MCP notes
 *   stand-in (`tests/helpers/mcpStandIn.ts`) over a scratch notes file.
 * - Completion signal: the card's rows, the reader's reports in the task's
 *   outcome, the model's requests, the saved asks' outcomes, GitHub's
 *   requests and the notes file.
 * - Platform prerequisites: Node running the notes stand-in from its source.
 * - Shared resources: none; the app, its folder and every stand-in are this
 *   test's own.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const NOTES_STAND_IN = join(process.cwd(), "tests", "helpers", "mcpStandIn.ts");

let launched: LaunchedApp | undefined;
let stopGitHub: (() => Promise<void>) | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await stopGitHub?.();
  stopGitHub = undefined;
});

/** The host's saved record that the reader first held something of the captain's. */
function readerHolds(
  userDataDir: string,
  taskId: string,
): { at: number; what: string } | undefined {
  const delivery = readSavedData(userDataDir, (db) => {
    const row = db
      .prepare(`SELECT delivery_json AS delivery FROM ${taskReadTable(db)} WHERE id = ?`)
      .get(taskId) as { delivery: string | null } | undefined;
    return savedDeliveryReader(db)(taskId, row?.delivery ?? null);
  });
  return (JSON.parse(delivery ?? "{}") as { readerHolds?: { at: number; what: string } })
    .readerHolds;
}

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

for (const runtime of READER_RUNTIMES) {
  test(`an unsafe data reader on ${runtime.name} reads an allowed integration marked and its other calls wait on its one card`, async () => {
    const userDataDir = scratchDir("infinitary-reader-integrations-");
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
    db.close();
    seedGitHubSignIn(userDataDir);
    const github = await startGitHubStub();
    stopGitHub = () => github.close();
    github.setProjects([
      { fullName: "octo/meterlab", private: true, updatedAt: "2026-09-22T10:00:00Z" },
    ]);
    github.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
    const items = scratchDir("infinitary-reader-items-");
    writeFileSync(
      join(items, "items.jsonl"),
      `${JSON.stringify({ id: "a", summary: "First" })}\n${JSON.stringify({ id: "b", summary: "Second" })}\n`,
    );
    const notes = join(scratchDir("infinitary-reader-notes-"), "notes.json");
    writeFileSync(notes, JSON.stringify({ notes: SAMPLE_NOTES }));
    const env = { ...github.env, INFINITARY_STAND_IN_INTEGRATION: items };
    const scenarios = [readerIntegrations];
    launched = runtime.claude
      ? await launchClaudeCrew({ scenarios, userDataDir, env })
      : await launchApp({ withMockProvider: true, scenarios, userDataDir, env });
    const { app, page } = launched;
    await page.evaluate((server) => window.infinitary.integrations.addMcp(server), {
      name: "Notes",
      runs: `'${process.execPath}' '${NOTES_STAND_IN}' stdio modern '${notes}'`,
    });
    // The captain sets the stand-in's count and the notes server's list to Always allow.
    const connected = await page.evaluate(async () =>
      (await window.infinitary.integrations.list()).integrations.map((one) => [one.id, one.name]),
    );
    const idOf = (name: string) => connected.find((one) => one[1] === name)?.[0] ?? "";
    await page.evaluate(
      async ({ standIn, notesId }) => {
        await window.infinitary.integrations.rule(standIn, "count_items", true);
        await window.infinitary.integrations.rule(notesId, "list_notes", true);
      },
      { standIn: idOf("Stand-in"), notesId: idOf("Notes") },
    );

    await send(
      page,
      `${SPAWN_PROMPT_MARKER} meterlab ${READER_INTEGRATIONS_MARKER}${runtime.suffix}`,
    );
    const title = cardReaderCallsTitle();
    const card = shownCard(page, title);
    await expect(card).toBeVisible({ timeout: 60_000 });
    const rows = cardBody(page, title).locator("[data-inf-ask-row]");
    // The allowed count ran with no row; the notes read, the note and the issue wait.
    await expect(rows).toHaveCount(3, { timeout: 45_000 });
    await expect(rows.nth(0)).toContainText(READER_LIST_REASON);
    await expect(rows.nth(1)).toContainText(READER_NOTE);
    await expect(rows.nth(1)).toContainText(READER_NOTE_REASON);
    await expect(rows.nth(2)).toContainText(`${READER_ISSUE.method} ${READER_ISSUE.path}`);
    await expect(card).not.toContainText(READER_COUNT_REASON);
    for (const row of [0, 1, 2]) await expect(rows.nth(row).getByRole("checkbox")).toBeChecked();
    const shown = (await page.evaluate(() => window.infinitary.cards.list())).filter(
      (one) => one.meta === "Integration approval",
    );
    expect(shown.map((one) => one.title)).toEqual([title]);
    expect(shown[0]?.actions.map((action) => action.label)).toEqual([
      INTEGRATION_APPROVAL_WORDS.deny,
      INTEGRATION_APPROVAL_WORDS.once,
    ]);
    const id = shown[0]?.taskId ?? "";
    const outcome = async () =>
      (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id))?.outcome ?? "";
    await expect.poll(outcome, { timeout: 45_000 }).toContain(READER_LISTED);
    const listed = await outcome();
    // Its list names the notes server and the stand-in, each action at Asks you.
    expect(listed).toContain('"name":"Notes"');
    expect(listed).toContain(NOTES_ADD_TOOL);
    expect(listed).toContain("this task reads words strangers can write");
    // The allowed count answered before any click, and the host recorded the hold.
    expect(listed).toContain("The stand-in holds 2 items.");
    expect(readerHolds(userDataDir, id)?.what).toBe("Stand-in");
    expect(JSON.parse(readFileSync(notes, "utf8")).notes).toEqual(SAMPLE_NOTES);

    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    const shot = `reader-integrations-${runtime.name.toLowerCase()}`;
    if (evidence) {
      await resizeWindow(app, page, { width: 1100, height: 860 });
      await regionShot(card, join(evidence, `${shot}-card.png`));
      if (!runtime.claude)
        await heroShot(app, page, {
          region: card,
          anchors: [
            card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
          ],
          name: "reader-integration-reads",
        });
      await rows.nth(2).scrollIntoViewIfNeeded();
      await regionShot(card, join(evidence, `${shot}-card-issue.png`));
    }

    for (const change of [1, 2]) {
      await pressKey(rows.nth(change).getByRole("checkbox"), " ");
      await expect(rows.nth(change).getByRole("checkbox")).not.toBeChecked();
    }
    await pressKey(
      card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
      "Enter",
    );
    await expect(card).toBeHidden({ timeout: 20_000 });
    await expect.poll(outcome, { timeout: 45_000 }).toContain(READER_ANSWERED);
    const answered = await outcome();
    expect(answered).toContain(SAMPLE_NOTES[1]);
    // The count and the notes list each reached the reader's own model whole
    // between integration-data marks; its reports then carry them inside its
    // own reader-data marks, so the marks are read off the model's requests.
    const marked = (launched?.mockProvider?.requestBodies() ?? [])
      .filter((raw) => raw.includes(READER_INTEGRATIONS_MARKER))
      .flatMap((raw) => fencedSpans(raw))
      .filter((span) => span.label === "integration-data");
    expect(marked.some((span) => span.words.includes("The stand-in holds 2 items."))).toBe(true);
    expect(marked.some((span) => span.words.includes(SAMPLE_NOTES[1] ?? "-"))).toBe(true);
    expect(JSON.parse(readFileSync(notes, "utf8")).notes).toEqual(SAMPLE_NOTES);
    expect(github.openedIssues()).toEqual([]);
    expect(github.requests()).not.toContain(`${READER_ISSUE.method} ${READER_ISSUE.path}`);
    const asks = savedWriteAsks(userDataDir, id).sort((a, b) => a.at - b.at);
    expect(asks).toEqual([
      expect.objectContaining({
        action: "list_notes",
        sentAt: expect.any(Number),
        outcome: expect.objectContaining({ kind: "ran" }),
      }),
      expect.objectContaining({
        action: NOTES_ADD_TOOL,
        outcome: expect.objectContaining({ kind: "refused" }),
      }),
      expect.objectContaining({
        path: READER_ISSUE.path,
        outcome: expect.objectContaining({ kind: "refused" }),
      }),
    ]);
    expect(readerHolds(userDataDir, id)?.what).toBe("Stand-in");
    if (evidence)
      writeFileSync(
        join(evidence, `${shot}.txt`),
        `First report:\n${listed}\n\nAfter the click:\n${answered}\n\nSaved asks:\n${JSON.stringify(asks, null, 2)}\n\nGitHub requests:\n${github.requests().join("\n")}\n\nNotes file:\n${readFileSync(notes, "utf8")}`,
      );
  });
}
