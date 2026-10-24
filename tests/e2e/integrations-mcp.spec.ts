import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WRITE_ANSWERED_LEAD } from "../../src/core/orchestrator/wakes";
import { ACTIONS } from "../../src/shared/actions";
import {
  INTEGRATION_APPROVAL_WORDS,
  INTEGRATION_RULE_WORDS,
  INTEGRATIONS_MCP_WORDS,
  INTEGRATIONS_WORDS,
  integrationApprovalTitle,
} from "../../src/shared/integrations";
import { SAMPLE_NOTES } from "../helpers/mcpStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { feedLineOf } from "./rails";
import {
  MCP_NOTES_ACTION,
  MCP_NOTES_CHANGE_MARKER,
  MCP_NOTES_FIRSTMATE_MARKER,
  MCP_NOTES_FIRSTMATE_REASON,
  MCP_NOTES_FIRSTMATE_REMINDER,
  MCP_NOTES_NAME,
  MCP_NOTES_PROMPT_MARKER,
  MCP_NOTES_REASON,
  MCP_NOTES_REMINDER,
  MCP_NOTES_REPORT_PREFIX,
  type McpNotesFirstmateSeen,
  mcpNotes,
  mcpNotesFirstmate,
} from "./scenarios/mcpNotes";
import { settingsSection } from "./settings";
import { showCard, shownCard } from "./stack";
import { pressKey, runFromSearch, typeInto, untilFocused } from "./windowKeys";

/**
 * An MCP server as an integration (INF-781; the captain's "a MCP server
 * should also be treated as an integration", and INF-775's plan check: "a
 * journey that adds a stand-in server from Settings and calls one of its
 * actions from a crewmate's shell").
 *
 * - Promised result: the "MCP server" chip's form, filled and sent by keys
 *   alone, connects the server and opens its new row on the server's own
 *   tools (the captain's q7, "trust the server's list and show it after"),
 *   every action asking; a crewmate's reasoned read raises the host's card,
 *   Always allow saves its grant, Not now runs nothing, Only this time adds
 *   a reminder without a grant, and keyboard Settings changes the read's rule.
 *   In the second test, the first mate's own reasoned change raises the same
 *   host card with no task of its own, Only this time highlighted; that
 *   click adds its reminder once and the first mate hears it (INF-1108).
 * - Data: the stand-in notes server (`tests/helpers/mcpStandIn.ts`) in the
 *   2026-07-28 protocol era, run as a program on this computer over stdio,
 *   reading a notes file in this test's folder.
 * - Completion signal: the task's report carries the notes the server
 *   listed, and `window.infinitary.integrations.list()` holds the row; the
 *   first mate's `write-answered` wake reaches its scripted model.
 * - Platform prerequisites: Node running the stand-in from its TypeScript
 *   source, as the unit test does; nothing leaves this computer.
 * - Shared resources: none; the app, its folder and the server are this
 *   test's own.
 */

const STAND_IN = join(process.cwd(), "tests", "helpers", "mcpStandIn.ts");

/** The host's approval card, once the call that raises it was kept. */
async function approval(page: Page, title: string) {
  // INF-950: crew startup and its shell call precede the host's approval.
  // Wait for that fact before showCard checks the presentation transition.
  await expect
    .poll(
      () =>
        page.evaluate(
          async (wanted) =>
            (await window.infinitary.cards.list()).some((card) => card.title === wanted),
          title,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await showCard(page, title);
  return shownCard(page, title);
}

/** The stand-in notes server over a fresh notes file, as a person writes what it runs. */
function notesServer(prefix: string): { notes: string; runs: string } {
  const notes = join(scratchDir(prefix), "notes.json");
  writeFileSync(notes, JSON.stringify({ notes: SAMPLE_NOTES }));
  // The program and its arguments as a person writes them, quoted where a folder has a space.
  return { notes, runs: `'${process.execPath}' '${STAND_IN}' stdio modern '${notes}'` };
}

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
});

test("an MCP server added from Settings by keys alone shows its own tools, and a crewmate reads through it", async () => {
  const { notes, runs } = notesServer("infinitary-mcp-notes-");
  launched = await launchApp({ withMockProvider: true, scenarios: [mcpNotes] });
  const { app, page } = launched;
  const view = () => page.evaluate(() => window.infinitary.integrations.list());
  const approvalFor = (title: string) => approval(page, title);

  await test.step("the chip's form adds the server and opens its row on its tools", async () => {
    await runFromSearch(app, page, "settings.integrations");
    const tab = settingsSection(page, "integrations");
    await expect(tab).toContainText(INTEGRATIONS_WORDS.intro);
    await pressKey(tab.locator('[data-integration-add="mcp"] button'), "Enter");
    const form = tab.locator("[data-integration-mcp-form]");
    const name = form.getByLabel(INTEGRATIONS_MCP_WORDS.name);
    await untilFocused(name);
    await typeInto(name, MCP_NOTES_NAME);
    await pressKey(name, "Tab");
    const runsField = form.getByLabel(INTEGRATIONS_MCP_WORDS.runs);
    await untilFocused(runsField);
    await typeInto(runsField, runs, { insert: true });
    await pressKey(runsField, "Enter");

    const row = tab.locator('[data-integration-row="mcp-notes"]');
    await expect(row).toContainText(INTEGRATIONS_MCP_WORDS.connected, { timeout: 30_000 });
    await expect(form).toHaveCount(0);
    await expect(tab.locator('[data-integration-toggle="mcp-notes"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const actions = tab.locator('[data-integration-actions="mcp-notes"]');
    await expect(
      actions.locator(`[data-integration-action="${MCP_NOTES_ACTION}"] [data-integration-rule]`),
    ).toHaveText(INTEGRATION_RULE_WORDS.ask);
    await expect(
      actions.locator('[data-integration-action="add_note"] [data-integration-rule]'),
    ).toHaveText(INTEGRATION_RULE_WORDS.ask);
    await expect(actions.locator('[data-integration-event="resource_changed"]')).toContainText(
      INTEGRATIONS_MCP_WORDS.events,
    );
    expect(
      (await view()).integrations.map((entry) => [entry.id, entry.kind, entry.health]),
    ).toEqual([["mcp-notes", "mcp", "ok"]]);
  });

  await test.step("a crewmate calls one of its reads from its shell and reports the answer", async () => {
    // Escape leaves Settings for the composer.
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
      "data-screen-label",
      "Settings",
    );
    // INF-1110: the Settings addition names the server in its completed record
    // and in the Activity the captain returns to, not the integration list.
    const addition = ACTIONS["integration-add-mcp"].done({ name: MCP_NOTES_NAME });
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    expect(
      board.tasks.filter((task) => task.kind === "operation" && task.title === addition),
    ).toMatchObject([{ status: "done", outcomeSummary: addition }]);
    await expect(
      feedLineOf(page, { type: "personalized", actor: "captain", text: addition }),
    ).toBeVisible();
    const title = `${MCP_NOTES_PROMPT_MARKER} for the week`;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    const approvalTitle = integrationApprovalTitle("List notes", MCP_NOTES_NAME);
    const approval = await approvalFor(approvalTitle);
    await expect(cardBody(page, approvalTitle).locator("body")).toContainText(MCP_NOTES_REASON);
    const evidenceDir = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidenceDir) {
      await resizeWindow(app, page, { width: 1280, height: 700 });
      await pressKey(approval.locator('[data-card-size-toggle="maximize"]'), "Enter");
    }
    if (evidenceDir) {
      await regionShot(approval, join(evidenceDir, "read-approval-after.png"));
      await heroShot(app, page, { region: approval, name: "integration-action-approval" });
    }
    await pressKey(
      approval.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.always, exact: true }),
      "Enter",
    );

    const outcome = async (): Promise<string> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? ((await window.infinitary.tasks.detail(row.id))?.outcome ?? "") : "";
      }, title);
    await expect.poll(outcome, { timeout: 60_000 }).toContain(MCP_NOTES_REPORT_PREFIX);
    const report = await outcome();
    for (const [index, note] of SAMPLE_NOTES.entries())
      expect(report).toContain(`${index + 1}. ${note}`);
    expect(
      (await view()).integrations[0]?.actions.find((a) => a.name === MCP_NOTES_ACTION)?.rule,
    ).toBe("allow");
    await input.fill(`${SPAWN_PROMPT_MARKER} ${MCP_NOTES_CHANGE_MARKER}`);
    await input.press("Enter");
    const outwardTitle = integrationApprovalTitle("add_note", MCP_NOTES_NAME);
    let outward = await approvalFor(outwardTitle);
    // A refusal runs nothing and does not turn this action into Always allowed.
    await pressKey(
      outward.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.deny, exact: true }),
      "Enter",
    );
    await expect
      .poll(async () => {
        const rows = await page.evaluate(() => window.infinitary.tasks.board());
        const row = rows.tasks.find((task) => task.title === MCP_NOTES_CHANGE_MARKER);
        return row
          ? await page.evaluate(
              async (id) => (await window.infinitary.tasks.detail(id))?.outcome,
              row.id,
            )
          : "";
      })
      .toContain("sent nothing");
    expect(JSON.parse(readFileSync(notes, "utf8")).notes).not.toContain(MCP_NOTES_REMINDER);
    await input.fill(`${SPAWN_PROMPT_MARKER} ${MCP_NOTES_CHANGE_MARKER} again`);
    await input.press("Enter");
    outward = await approvalFor(outwardTitle);
    const keptCard = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.title === outwardTitle,
    );
    expect(keptCard?.actions.find((action) => action.default)?.label).toBe(
      INTEGRATION_APPROVAL_WORDS.once,
    );
    if (evidenceDir) {
      const maximize = outward.locator('[data-card-size-toggle="maximize"]');
      if (await maximize.count()) await pressKey(maximize, "Enter");
      await regionShot(outward, join(evidenceDir, "outward-approval-after.png"));
    }
    await pressKey(
      outward.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
      "Enter",
    );
    await expect
      .poll(async () => JSON.parse(readFileSync(notes, "utf8")).notes)
      .toContain(MCP_NOTES_REMINDER);
    expect((await view()).integrations[0]?.actions.find((a) => a.name === "add_note")?.rule).toBe(
      "ask",
    );
    if (evidenceDir) await resizeWindow(app, page, { width: 1280, height: 800 });
    await runFromSearch(app, page, "settings.integrations");
    const settings = settingsSection(page, "integrations");
    const actionRow = settings.locator(`[data-integration-action="${MCP_NOTES_ACTION}"]`);
    if (!(await actionRow.isVisible()))
      await pressKey(settings.locator('[data-integration-toggle="mcp-notes"]'), "Enter");
    const choice = actionRow.locator("[data-integration-rule]");
    await pressKey(choice, "Enter");
    await expect(choice).toHaveText(INTEGRATION_RULE_WORDS.ask);
    await pressKey(choice, "Enter");
    await expect(choice).toHaveText(INTEGRATION_RULE_WORDS.allow);
    if (evidenceDir)
      await regionShot(
        settings.locator('[data-integration-actions="mcp-notes"]'),
        join(evidenceDir, "settings-after.png"),
      );

    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence) writeFileSync(join(evidence, "integrations-mcp-report.txt"), `${report}\n`);
  });
});

test("the first mate's own change on an MCP server waits for the app's card, then runs once", async () => {
  const { notes, runs } = notesServer("infinitary-mcp-firstmate-");
  const firstmateSeen: McpNotesFirstmateSeen = { wakes: [] };
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [mcpNotesFirstmate(firstmateSeen)],
  });
  const { page } = launched;
  const view = () => page.evaluate(() => window.infinitary.integrations.list());
  // The first journey adds the server by keys; this one adds it the same way Settings does.
  await page.evaluate((server) => window.infinitary.integrations.addMcp(server), {
    name: MCP_NOTES_NAME,
    runs,
  });
  expect((await view()).integrations[0]?.actions.find((a) => a.name === "add_note")?.rule).toBe(
    "ask",
  );

  const input = promptInput(page);
  await input.click();
  await input.fill(MCP_NOTES_FIRSTMATE_MARKER);
  await input.press("Enter");
  const title = integrationApprovalTitle("add_note", MCP_NOTES_NAME);
  const card = await approval(page, title);
  await expect(cardBody(page, title).locator("body")).toContainText(MCP_NOTES_FIRSTMATE_REASON);
  const held = (await page.evaluate(() => window.infinitary.cards.list())).find(
    (shown) => shown.title === title,
  );
  expect(held?.taskId).toBeUndefined();
  expect(held?.actions.find((action) => action.default)?.label).toBe(
    INTEGRATION_APPROVAL_WORDS.once,
  );
  expect(JSON.parse(readFileSync(notes, "utf8")).notes).not.toContain(MCP_NOTES_FIRSTMATE_REMINDER);
  await pressKey(
    card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
    "Enter",
  );
  await expect
    .poll(async () => JSON.parse(readFileSync(notes, "utf8")).notes)
    .toContain(MCP_NOTES_FIRSTMATE_REMINDER);
  await expect.poll(() => firstmateSeen.wakes.length, { timeout: 60_000 }).toBe(1);
  const kept: string[] = JSON.parse(readFileSync(notes, "utf8")).notes;
  expect(firstmateSeen.wakes[0]).toContain(WRITE_ANSWERED_LEAD);
  // The stand-in's own answer to the call, carried back to the first mate.
  expect(firstmateSeen.wakes[0]).toContain(`Added note ${kept.length}.`);
  expect((await view()).integrations[0]?.actions.find((a) => a.name === "add_note")?.rule).toBe(
    "ask",
  );
});
