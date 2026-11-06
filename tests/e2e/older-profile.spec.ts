import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Card } from "@shared/cards";
import { GATED_CHECK_PLACEHOLDER } from "@shared/firstRun";
import type { Slot } from "@shared/modelSlots";
import { PLACEMENT_DEMANDS, placementSnapshotSchema } from "@shared/placement";
import { CardService } from "../../src/core/orchestrator/cardService";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { timelineEventIdentity } from "../../src/core/storage/taskEventStore";
import { taskReadTable } from "../../src/core/storage/taskRecordFields";
import {
  type MergeAuthorization,
  type TaskDelivery,
  TaskStore,
} from "../../src/core/storage/taskStore";
import { ACTIVITY_PLACES } from "../../src/core/tasks/recordActivity";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { TaskTimeline } from "../../src/core/tasks/taskTimeline";
import { freshCheckTitle } from "../../src/renderer/src/app/firstRunGateWords";
import { INTEGRATIONS_MCP_WORDS, integrationRenameWords } from "../../src/shared/integrations";
import type { TaskDetail } from "../../src/shared/tasks";
import type { WriteAsk } from "../../src/shared/writeAsk";
import { SAMPLE_NOTES, serveNotesHttp } from "../helpers/mcpStandIn";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { startCustomApiFixture } from "./customApiFixture";
import { STUB_LOGIN, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import {
  closeModelPanel,
  levelLane,
  openModelPanel,
  openModelsBoard,
  setLevelInPanel,
} from "./modelsBoard";
import { asSavedByOlderRelease, seedLegacyGithubServer } from "./olderProfile";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { sinceLastUser } from "./providerRequest";
import { openGroup, pressRow, recordCard, recordFrame } from "./rails";
import { readSavedData } from "./savedData";
import {
  GITHUB_NAMES_PROMPT,
  GITHUB_NAMES_REPORT,
  GITHUB_SERVER_NAME,
  githubNames,
} from "./scenarios/githubNames";
import { relationshipsAsk, upgradedRelationshipsRead } from "./scenarios/upgradedRelationshipsRead";
import {
  UPGRADED_TASK_FIELDS,
  UPGRADED_TASK_PROMPT,
  upgradedTaskRead,
} from "./scenarios/upgradedTaskRead";
import { settingsSection } from "./settings";
import { closeOpenCards } from "./stack";
import { seedCrewTranscript } from "./transcriptFixtures";
import { pressKey, runFromSearch, typeInto } from "./windowKeys";

// A profile an older release saved, opened in this build: the upgrade a
// person makes (docs/saved-data-compatibility.md, "Profiles saved by an older
// release"). Each journey sets the profile up on this build, quits, rewrites
// it into the older release's form, and opens it again.

const FIRSTMATE_MODEL = "operator-model";
const CREW_MODEL = "operator-large-model";

let launched: LaunchedApp | undefined;
let api: Awaited<ReturnType<typeof startCustomApiFixture>> | undefined;
let model: Awaited<ReturnType<typeof startMockProvider>> | undefined;
test.afterEach(async () => {
  if (launched)
    writeFileSync(
      test.info().outputPath("diagnostic-state.json"),
      JSON.stringify(
        await launched.page.evaluate(async () => ({
          firstRun: await window.infinitary.app.firstRun(),
          firstmateModel: await window.infinitary.settings.getFirstmateModel(),
          available: await window.infinitary.models.available(),
          slots: await window.infinitary.models.slots(),
          custom: await window.infinitary.accounts.custom.list(),
        })),
        null,
        2,
      ),
    );
  await launched?.close();
  await api?.close();
  await model?.close();
  launched = undefined;
  api = undefined;
  model = undefined;
});

/** The crew slots a model holds, none while it is not offered. */
function placements(page: Page, provider: string, id: string): Promise<Slot[]> {
  return page.evaluate(
    async ({ provider, id }) => {
      const view = await window.infinitary.models.slots();
      return (
        [...view.models, ...view.byName].find((row) => row.provider === provider && row.id === id)
          ?.slots ?? []
      );
    },
    { provider, id },
  );
}

/** The models of one connection that work can run on. */
async function offered(page: Page, provider: string): Promise<string[]> {
  const models = await page.evaluate(() => window.infinitary.models.available());
  return models.filter((entry) => entry.provider === provider).map((entry) => entry.id);
}

async function gateOpen(page: Page): Promise<boolean> {
  return (await page.evaluate(() => window.infinitary.app.firstRun())).gateOpen;
}

/**
 * A connection to the custom API fixture and nothing else, set up through the
 * calls Settings makes: both models checked and saved, the Firstmate on one,
 * a crew slot on each.
 */
async function connectCustomOnly(
  page: Page,
  baseUrl: string,
  protocol: "openai-completions" | "openai-responses",
): Promise<{ id: string; providerId: string }> {
  const saved = await page.evaluate(
    async ({ baseUrl, protocol, models }) => {
      const custom = window.infinitary.accounts.custom;
      const { destination } = await custom.review(baseUrl, "local");
      const draft = await custom.prepare({
        label: "Operator gateway",
        baseUrl,
        mode: "local",
        protocol,
        key: "",
        noKey: true,
        headers: [],
        approvedDestination: destination,
        unencryptedLocalApproved: true,
        allowStorageDefault: false,
        storageApproved: false,
        models: models.map((id) => ({ id, context: 200000, output: 4096 })),
      });
      if (!draft.draftId) throw new Error("No draft to check");
      for (const id of models) await custom.check(draft.draftId, id);
      return custom.save(draft.draftId, false);
    },
    { baseUrl, protocol, models: [FIRSTMATE_MODEL, CREW_MODEL] },
  );
  const account = (await page.evaluate(() => window.infinitary.accounts.list())).find(
    (entry) => entry.id === saved.accountId,
  );
  if (!account) throw new Error("The custom connection was not saved");
  const { providerId } = account;
  await expect
    .poll(() => offered(page, providerId))
    .toEqual(expect.arrayContaining([FIRSTMATE_MODEL, CREW_MODEL]));
  for (const [id, slot] of [
    [FIRSTMATE_MODEL, "medium"],
    [CREW_MODEL, "high"],
  ] as const)
    await page.evaluate(
      ({ key, slot }) => window.infinitary.models.setSlotMembership(key, slot, true),
      { key: `${providerId}/${id}`, slot },
    );
  await page.evaluate((model) => window.infinitary.settings.setFirstmateModel(model), {
    provider: providerId,
    id: FIRSTMATE_MODEL,
  });
  // The window re-reads the gate on a quota push; a model choice pushes none.
  await page.evaluate(() => window.infinitary.quota.refresh());
  return { id: account.id, providerId };
}

/**
 * The first-launch gate's ask for a connection's fresh check, and its one
 * action (`FirstRunGate`): the gate names the connection instead of asking
 * for a subscription.
 */
function freshCheckAsk(page: Page, accountId: string) {
  const gate = page.locator('[data-first-run-gate="open"]');
  return {
    gate,
    title: gate.locator("[data-gate-title]"),
    ask: gate.locator(`[data-fresh-check="${accountId}"]`),
    action: gate.locator(`[data-fresh-check="${accountId}"] button`),
    failure: gate.getByRole("alert"),
  };
}

for (const protocol of ["openai-completions", "openai-responses"] as const) {
  test(`${protocol}: a custom-API-only profile an older release saved works after the upgrade`, async () => {
    const provider = await startMockProvider();
    model = provider;
    const server = await startCustomApiFixture(provider.port);
    api = server;
    const options = {
      reuseMockProvider: provider,
      modelsJson: () => JSON.stringify({ providers: {} }),
    };
    let app = await launchApp(options);
    launched = app;
    let page = app.page;
    const account = await test.step("set up: only a custom connection, in use", async () => {
      const connected = await connectCustomOnly(page, server.baseUrl, protocol);
      await expect.poll(() => gateOpen(page)).toBe(false);
      await askFirstmate(page, "Please pause the work for now");
      return connected;
    });

    await test.step("upgrade: the profile, as the release before saved it, opens here", async () => {
      await app.close();
      launched = undefined;
      // Something was rewritten, or the journey would open this build's own profile.
      expect(asSavedByOlderRelease(app.userDataDir).customChecks).not.toHaveLength(0);
      app = await launchApp({ ...options, userDataDir: app.userDataDir, homeDir: app.homeDir });
      launched = app;
      page = app.page;
      // Right after the upgrade the gate names the connection the Firstmate
      // was chosen on and asks for its fresh check in place, never for a
      // subscription.
      const [connection] = await page.evaluate(() => window.infinitary.accounts.custom.list());
      const label = connection?.label ?? "";
      const fresh = (await page.evaluate(() => window.infinitary.app.firstRun())).freshCheck;
      expect(fresh?.accountId).toBe(account.id);
      expect(fresh?.models).toEqual(expect.arrayContaining([FIRSTMATE_MODEL, CREW_MODEL]));
      // A card on the stage covers the gate; the welcome the setup earned
      // may still be up.
      await closeOpenCards(page);
      const { title, ask } = freshCheckAsk(page, account.id);
      await expect(ask).toBeVisible();
      await expect(title).toHaveText(freshCheckTitle(label));
      await expect(promptInput(page)).toHaveAttribute("placeholder", GATED_CHECK_PLACEHOLDER);
      await page.screenshot({ path: test.info().outputPath(`${protocol}-upgraded.png`) });
    });

    await test.step("one fresh check, from the gate: Firstmate's model and the crew's are offered again", async () => {
      const { action, failure } = freshCheckAsk(page, account.id);
      // A server that refuses keeps the ask, with its reason beside it.
      server.refuse(503);
      await pressKey(action, "Enter");
      await expect(failure).toBeVisible();
      expect(await gateOpen(page)).toBe(true);
      server.refuse(200);
      await pressKey(action, "Enter");
      await expect.poll(() => gateOpen(page)).toBe(false);
      await expect(page.locator('[data-first-run-gate="open"]')).toHaveCount(0);
      expect(await offered(page, account.providerId)).toEqual(
        expect.arrayContaining([FIRSTMATE_MODEL, CREW_MODEL]),
      );
      // The crew slots chosen before the upgrade come back with the models.
      expect(await placements(page, account.providerId, FIRSTMATE_MODEL)).toContain("medium");
      expect(await placements(page, account.providerId, CREW_MODEL)).toContain("high");
    });

    await test.step("crew use takes a click on the Models board", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Intelligence" }).click();
      const models = await openModelsBoard(page);
      const panel = await openModelPanel(page, levelLane(models, "high"), CREW_MODEL);
      await setLevelInPanel(panel, CREW_MODEL, "low", true);
      await closeModelPanel(models);
      await expect.poll(() => placements(page, account.providerId, CREW_MODEL)).toContain("low");
      await page.screenshot({ path: test.info().outputPath(`${protocol}-crew.png`) });
    });

    await test.step("Firstmate answers", async () => {
      await page.keyboard.press("Escape");
      await askFirstmate(page, "Resume the work please");
      await page.screenshot({ path: test.info().outputPath(`${protocol}-answered.png`) });
    });
  });
}

/**
 * INF-882, captain's automatic-name choice: preserve GitHub sign-in and explain the server's new name.
 * Promised result: an older server named GitHub gets a distinct name, the name is reserved while signed
 * out, sign-in still completes, and the crew's reads by both names reach the right connections.
 * Data: the real MCP binding's discovery from the notes stand-in and GitHub's device-flow stand-in.
 * Completion: Settings and its explanation survive restart, project discovery works, and a real crew
 * command reports GitHub's account and the server's notes. No outward write is made.
 * Prerequisites: the hermetic launcher. Shared resources: none; folders, servers and ports are private.
 */
test("GitHub sign-in keeps distinct integration names and the crew reaches both", async () => {
  const userDataDir = scratchDir("infinitary-integration-names-");
  const notes = await serveNotesHttp("modern");
  const github = await startGitHubStub();
  let launched: LaunchedApp | undefined;
  try {
    await seedLegacyGithubServer(userDataDir, notes.url);
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [githubNames],
      userDataDir,
      env: github.env,
    });
    let { app, page } = launched;
    await runFromSearch(app, page, "settings.integrations");
    let tab = settingsSection(page, "integrations");
    const explanation = integrationRenameWords({ from: "GitHub", for: "GitHub" });
    await expect(tab.locator('[data-integration-row="mcp-github"]')).toContainText(
      GITHUB_SERVER_NAME,
    );
    await expect(tab.locator('[data-integration-renamed="mcp-github"]')).toHaveText(explanation);
    // A new server cannot reclaim GitHub, even before the person signs in.
    await pressKey(tab.locator('[data-integration-add="mcp"] button'), "Enter");
    const form = tab.locator("[data-integration-mcp-form]");
    const name = form.getByLabel(INTEGRATIONS_MCP_WORDS.name);
    await typeInto(name, "GitHub");
    await pressKey(name, "Tab");
    const runs = form.getByLabel(INTEGRATIONS_MCP_WORDS.runs);
    await typeInto(runs, notes.url, { insert: true });
    await pressKey(runs, "Enter");
    await expect(form.getByRole("status")).toBeVisible();
    await expect(form.getByRole("status")).toContainText("GitHub");
    expect(
      (await page.evaluate(() => window.infinitary.integrations.list())).integrations,
    ).toHaveLength(1);
    await pressKey(form.getByRole("button", { name: INTEGRATIONS_MCP_WORDS.cancel }), "Enter");
    // The same GitHub device flow still serves project work.
    await pressKey(tab.locator('[data-integration-add="github"] button'), "Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.forges.list())).flow?.host)
      .toBe("github.com");
    github.device.approve();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.infinitary.integrations.list())).integrations.map(
          (row) => [row.name, row.account],
        ),
      )
      .toEqual([
        ["GitHub", STUB_LOGIN],
        [GITHUB_SERVER_NAME, null],
      ]);
    await expect(tab.locator('[data-integration-row="github"]')).toContainText(`as ${STUB_LOGIN}`);
    await page.evaluate(() => window.infinitary.forges.projects("github.com"));
    expect(github.requests()).toContain("GET /user/repos");
    await launched.close();
    launched = await launchApp({
      withMockProvider: true,
      scenarios: [githubNames],
      userDataDir,
      env: github.env,
    });
    ({ app, page } = launched);
    await runFromSearch(app, page, "settings.integrations");
    tab = settingsSection(page, "integrations");
    await expect(tab.locator('[data-integration-row="mcp-github"]')).toContainText(
      GITHUB_SERVER_NAME,
    );
    await expect(tab.locator('[data-integration-renamed="mcp-github"]')).toHaveText(explanation);
    // INF-950: older connections also start asking. This naming journey grants
    // the two reads by keyboard before testing their routing across the restart.
    for (const [id, action] of [
      ["github", "read"],
      ["mcp-github", "list_notes"],
    ]) {
      await pressKey(tab.locator(`[data-integration-toggle="${id}"]`), "Enter");
      const choice = tab.locator(
        `[data-integration-actions="${id}"] [data-integration-action="${action}"] [data-integration-rule]`,
      );
      await expect(choice).toHaveAttribute("data-integration-rule", "ask");
      await pressKey(choice, "Enter");
      await expect(choice).toHaveAttribute("data-integration-rule", "allow");
    }
    await page.keyboard.press("Escape");
    const title = GITHUB_NAMES_PROMPT;
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await input.press("Enter");
    const outcome = () =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? ((await window.infinitary.tasks.detail(row.id))?.outcome ?? "") : "";
      }, title);
    await expect.poll(outcome, { timeout: 60_000 }).toContain(GITHUB_NAMES_REPORT);
    const report = await outcome();
    expect(report).toContain(STUB_LOGIN);
    expect(report).toContain(GITHUB_SERVER_NAME);
    for (const note of SAMPLE_NOTES) expect(report).toContain(note);
    await test
      .info()
      .attach("integration-read-answers", { body: report, contentType: "text/plain" });
    console.log(`Integration read answers from the stand-ins:\n${report}`);
  } finally {
    await launched?.close();
    await github.close();
    await notes.close();
  }
});

const HISTORY_ID = "upgraded-history";
const KEPT = { kept: "flush", runs: 10 };
const NEWER = { kept: "flush", runs: 12 };

/** The task services a seeding or a read between launches writes through, on the stopped app's data. */
function taskWriters(userDataDir: string, at = Date.now() - 60 * 60_000) {
  const db = openDatabase(userDataDir);
  const now = () => (at += 60_000);
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const cards = new CardService({
    now,
    tasks,
    cardStore,
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  return { db, tasks, cardStore, cards };
}

/**
 * A finished task's history as this build writes it, through its own
 * writers: its brief, an update, a decision card with a thread and the
 * captain's choice, the report that carried its typed result, and its close.
 */
function seedHistory(userDataDir: string): string {
  const { db, tasks, cards } = taskWriters(userDataDir);
  try {
    seedTask(tasks, {
      id: HISTORY_ID,
      title: "Rerun the practice release's Mac check",
      intent: { goal: "The practice release passes.", userWords: "rerun the practice release" },
      status: "idle",
    });
    tasks.recordBrief(HISTORY_ID, ["Goal: The practice release passes."]);
    tasks.noteProgress(HISTORY_ID, "The rerun failed on a different journey; reading its log.");
    const card = cards.emitCrewmateCard(
      HISTORY_ID,
      {
        id: "which-fix",
        title: "Which fix should I keep?",
        body: "<p>Two fixes pass the practice release.</p>",
        actions: [
          { id: "flush", label: "Await the queue flush", default: true },
          { id: "retry", label: "Keep the retry" },
        ],
      },
      "Rerun",
    );
    const asked = cards.addMessage(card, "captain", "does the flush cover windows too?");
    // The crewmate's line names the captain's message, which is what answers it.
    cards.addMessage(
      card,
      "crewmate",
      "Yes: the flush runs on every platform.",
      undefined,
      undefined,
      undefined,
      false,
      {
        answersMessage: asked.id,
      },
    );
    cards.resolve(cards.get(card) as Card, "flush", "flush");
    tasks.turns.recordReport(HISTORY_ID, {
      text: "The Mac check passes with the queue flush. I kept it and removed the retry.",
      summary: "The Mac check passes with the queue flush.",
      declared: { result: KEPT },
    });
    tasks.close(HISTORY_ID, { status: "done", reason: "merged", actor: "host" });
    const key = tasks.get(HISTORY_ID)?.key;
    if (!key) throw new Error("The seeded task has no key.");
    return key;
  } finally {
    db.close();
  }
}

type SavedEvent = Pick<
  TaskDetail["events"][number],
  "id" | "at" | "actor" | "kind" | "text" | "data"
>;

/** What the app's data holds for the task, read from its rows, not through a reader. */
function savedRows(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const events = (
      db
        .prepare(
          "SELECT id, at, actor, kind, text, data_json FROM task_events WHERE task_id = ? ORDER BY at, id",
        )
        .all(HISTORY_ID) as (Omit<SavedEvent, "data"> & { data_json: string | null })[]
    ).map(({ data_json, ...event }) => ({
      ...event,
      data: data_json ? (JSON.parse(data_json) as Record<string, unknown>) : null,
    }));
    const delivery = db
      .prepare(`SELECT delivery_json FROM ${taskReadTable(db)} WHERE id = ?`)
      .pluck()
      .get(HISTORY_ID) as string | null;
    return {
      events,
      copy: (delivery ? JSON.parse(delivery).result : undefined) as
        | { at: number; value: Record<string, unknown> }
        | undefined,
    };
  });
}

/** The first mate's `tasks` read by key, one field per call, as the tool returned them. */
async function firstmateRead(app: LaunchedApp, key: string): Promise<Record<string, unknown>> {
  const prompt = `${UPGRADED_TASK_PROMPT} ${key}`;
  await askFirstmate(app.page, prompt);
  const read = (app.mockProvider?.requestBodies() ?? [])
    .map(sinceLastUser)
    .filter((turn) => turn.user.includes(prompt))
    .find((turn) => turn.results.length === UPGRADED_TASK_FIELDS.length);
  if (!read) throw new Error("The first mate did not read every field.");
  return Object.fromEntries(
    UPGRADED_TASK_FIELDS.map((field, index) => {
      const page = read.results[index] ?? "";
      const header = page.match(
        /^field (\w+) as (text|json), offset 1, nextOffset none, length \d+\n/,
      );
      expect(header?.[1], `the ${field} page`).toBe(field);
      const text = page.slice(header?.[0].length ?? 0);
      return [field, header?.[2] === "json" ? JSON.parse(text) : text];
    }),
  );
}

/**
 * INF-1296 piece 1, the captain's "i want to make sure this gets good e2e
 * test coverage to ensure exsiting users don't get regressed during this
 * migration". Promised result: a task's history an older release saved - a
 * result copied onto the task's delivery facts and a card choice that names
 * no card evidence - reads the same after the upgrade and a restart, in the
 * record and through the first mate's `tasks` read, and a report this build
 * writes later takes over the result without rewriting the older copy.
 * Data: a task written through the app's own writers, rewritten into the
 * older release's form (`asSavedByOlderRelease`). Completion: the first
 * mate's answer after its four reads, and the saved rows read back after
 * the app quits. Prerequisites: the hermetic launcher. Shared resources:
 * none.
 */
test("a task's history an older release saved reads the same after the upgrade", async () => {
  const userDataDir = scratchDir("infinitary-upgraded-history-");
  const key = seedHistory(userDataDir);
  const older = asSavedByOlderRelease(userDataDir);
  const saved = savedRows(userDataDir);
  const reports = saved.events.filter((event) => event.kind === "report");
  const decisions = saved.events.filter((event) => event.kind === "card_resolved");
  // Something was rewritten, or the journey would open this build's own profile.
  expect(older.resultCopies).toEqual([{ taskId: HISTORY_ID, at: reports[0]?.at }]);
  expect(older.decisions).toEqual(decisions.map((event) => event.id));
  expect(saved.copy).toEqual({ at: reports[0]?.at, value: KEPT });
  const briefWords = (() => {
    const { db, tasks } = taskWriters(userDataDir);
    try {
      const briefed = tasks.timeline(HISTORY_ID).find((event) => event.kind === "briefed");
      return briefed ? tasks.servedBrief(briefed) : "";
    } finally {
      db.close();
    }
  })();
  expect(briefWords).toContain("Goal: The practice release passes.");

  const launch = () =>
    launchApp({ withMockProvider: true, scenarios: [upgradedTaskRead], userDataDir });
  /** What the older release showed: its rows, its copied result, its choice's data. */
  const expectAsSaved = async (
    app: LaunchedApp,
    result: Record<string, unknown>,
  ): Promise<TaskDetail> => {
    const detail: TaskDetail = await app.page.evaluate(
      (id) => window.infinitary.tasks.detail(id),
      HISTORY_ID,
    );
    const rows = savedRows(userDataDir).events;
    expect(
      detail.events.map(({ id, at, actor, kind, text, data }) => ({
        id,
        at,
        actor,
        kind,
        text,
        data,
      })),
    ).toEqual(rows);
    // Nothing about the task is left out of Activity: every event but the evidence is a row or under one.
    expect(
      detail.activityLog
        .flatMap((row) => [row.id, ...(row.folded ?? []).map((line) => line.id)])
        .sort((a, b) => a - b),
    ).toEqual(
      rows
        .filter((event) => ACTIVITY_PLACES[event.kind] !== "evidence")
        .map((event) => event.id)
        .sort((a, b) => a - b),
    );
    expect(await firstmateRead(app, key)).toEqual({
      reports: rows
        .filter((event) => event.kind === "report")
        .map((event) => ({ event_id: event.id, text: event.text })),
      result,
      decisions: decisions.map((event) => ({
        event_id: event.id,
        text: event.text,
        data: event.data,
      })),
      brief: briefWords,
    });
    return detail;
  };

  let app: LaunchedApp | undefined = await launch();
  try {
    const upgraded =
      await test.step("upgrade: the record and the first mate's read show what the older release saved", async () => {
        if (!app) throw new Error("The app did not launch.");
        const detail = await expectAsSaved(app, KEPT);
        // The captain opens the record by keys and reads the report's row.
        await openGroup(app.page, "landed");
        await pressRow(app.page, key);
        await expect(recordCard(app.page)).toHaveAttribute("data-task-record", HISTORY_ID);
        await expect(recordFrame(app.page).locator('[data-record-event="report"]')).toHaveCount(1);
        return detail;
      });

    await test.step("restart: the same history reads the same", async () => {
      await app?.close();
      app = await launch();
      const detail = await expectAsSaved(app, KEPT);
      expect(detail.activityLog).toEqual(upgraded.activityLog);
    });

    await test.step("a newer report's result takes over, and the older copy stays saved as it was", async () => {
      await app?.close();
      app = undefined;
      const { db, tasks } = taskWriters(userDataDir, Date.now());
      try {
        tasks.turns.recordReport(HISTORY_ID, {
          text: "Two more nightly runs passed with the queue flush.",
          declared: { result: NEWER },
        });
      } finally {
        db.close();
      }
      app = await launch();
      await expectAsSaved(app, NEWER);
      await app.close();
      app = undefined;
      expect(savedRows(userDataDir).copy).toEqual(saved.copy);
    });

    await test.step("the unified timeline reads every entry the upgraded task holds, once", () => {
      const { db, tasks, cardStore } = taskWriters(userDataDir);
      try {
        const entries = new TaskTimeline({ tasks, cards: cardStore }).entries(HISTORY_ID);
        const ids = entries.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        // The older choice names no card evidence, so its event and the evidence both stay.
        for (const event of savedRows(userDataDir).events)
          expect(ids).toContain(timelineEventIdentity({ taskId: HISTORY_ID, id: event.id }));
        expect(ids.filter((id) => id.startsWith("card-observation:")).length).toBe(
          cardStore.observationsForTask(HISTORY_ID).filter((row) => row.kind !== "message_ref")
            .length,
        );
        expect(ids.filter((id) => id.startsWith("card-message:"))).toHaveLength(
          cardStore.messagesForTask(HISTORY_ID).length,
        );
      } finally {
        db.close();
      }
    });
  } finally {
    await app?.close();
  }
});

/** The tasks a profile's relationships are seeded on, by role. */
const RELATED = {
  plan: "upgraded-plan",
  first: "upgraded-first-attempt",
  parent: "upgraded-parent",
  retry: "upgraded-retry",
  wip: "upgraded-wip",
  waiting: "upgraded-waiting",
} as const;
/** A basis an older release kept as named, naming no task. */
const UNNAMED_BASIS = "the-spec-draft";

/**
 * Tasks related every way a person's record relates them, as this build
 * writes them through its own writer: a plan a retry builds on, the earlier
 * attempt it branches from and retries, the parent it is a part of, and an
 * unstarted task waiting on another open one with a basis that names no
 * task yet. Nothing open starts on its own, so the upgrade alone moves them.
 */
function seedRelationships(userDataDir: string): Record<keyof typeof RELATED, string> {
  const { db, tasks } = taskWriters(userDataDir);
  try {
    seedTask(tasks, {
      id: RELATED.plan,
      title: "Plan the usage chart",
      status: "completed",
      outcome: "Draw B.",
    });
    seedTask(tasks, {
      id: RELATED.first,
      title: "Draw the usage chart",
      status: "completed",
      outcome: "Drew A.",
    });
    seedTask(tasks, { id: RELATED.parent, title: "Ship the usage chart", status: "idle" });
    const key = (id: string) => tasks.get(id)?.key ?? "";
    seedTask(tasks, {
      id: RELATED.retry,
      title: "Draw the usage chart again",
      parentId: RELATED.parent,
      shape: {
        kind: "fix",
        basis: key(RELATED.plan),
        branch_from: key(RELATED.first),
        escalate_from: key(RELATED.first),
      },
      status: "completed",
      outcome: "Drew B.",
    });
    tasks.create({
      id: RELATED.wip,
      title: "Decide the chart's colors",
      prompt: "",
      repoId: null,
      startPolicy: "on-request",
      actor: "captain",
    });
    tasks.create({
      id: RELATED.waiting,
      title: "Color the usage chart",
      prompt: "",
      repoId: null,
      shape: { kind: "implement", basis: UNNAMED_BASIS },
      blockedBy: [RELATED.wip],
      startPolicy: "on-request",
      actor: "firstmate",
    });
    for (const id of [RELATED.plan, RELATED.first, RELATED.retry, RELATED.parent])
      tasks.close(id, { status: "done", reason: "merged", actor: "host" });
    return Object.fromEntries(
      Object.entries(RELATED).map(([role, id]) => [role, key(id)]),
    ) as Record<keyof typeof RELATED, string>;
  } finally {
    db.close();
  }
}

/** Each seeded task's relationships as the saved rows hold them. */
function savedRelationships(userDataDir: string) {
  return readSavedData(userDataDir, (db) => ({
    // An older release's profile has no table of references.
    references: !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_references'")
      .get()
      ? undefined
      : db
          .prepare(
            "SELECT task_id, kind, ref, target_id, actor, recorded_at FROM task_references ORDER BY task_id, kind",
          )
          .all(),
    shapes: Object.fromEntries(
      (
        db
          .prepare(
            `SELECT id, shape_json FROM ${taskReadTable(db)} WHERE id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(Object.values(RELATED))) as {
          id: string;
          shape_json: string | null;
        }[]
      ).map((row) => [row.id, row.shape_json ? JSON.parse(row.shape_json) : null]),
    ),
  }));
}

/** The relationship fields the first mate reads of each task, by role. */
const RELATIONSHIP_FIELDS = {
  retry: ["parent", "basis", "branch_from", "earlier_attempt"],
  plan: ["built_on_by"],
  first: ["status"],
  waiting: ["status", "basis", "blocked_by"],
} as const;

/** The first mate's `tasks` reads of one task's fields, by key, as the tool returned them. */
async function firstmateFields(
  app: LaunchedApp,
  key: string,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const prompt = relationshipsAsk(key, fields);
  await askFirstmate(app.page, prompt);
  const read = (app.mockProvider?.requestBodies() ?? [])
    .map(sinceLastUser)
    .filter((turn) => turn.user.includes(prompt))
    .find((turn) => turn.results.length === fields.length);
  if (!read) throw new Error(`The first mate did not read every field of ${key}.`);
  return Object.fromEntries(
    fields.map((field, index) => {
      const page = read.results[index] ?? "";
      const header = page.match(
        /^field (\w+) as (text|json), offset 1, nextOffset none, length \d+\n/,
      );
      expect(header?.[1], `the ${field} page of ${key}`).toBe(field);
      const text = page.slice(header?.[0].length ?? 0);
      return [field, header?.[2] === "json" ? JSON.parse(text) : text];
    }),
  );
}

/** The keys the first mate read the plan is built on by. */
function builtOnKeys(firstmate: Record<string, Record<string, unknown>>): string[] {
  return ((firstmate.plan?.built_on_by ?? []) as { key: string }[]).map((row) => row.key);
}

/** What the window and the first mate read of every seeded task's relationships. */
async function relationshipsAsRead(app: LaunchedApp, keys: Record<keyof typeof RELATED, string>) {
  const details = await app.page.evaluate(
    (ids) => Promise.all(ids.map((id) => window.infinitary.tasks.detail(id))),
    Object.values(RELATED),
  );
  const shown = Object.fromEntries(
    details.map((detail: TaskDetail) => [
      detail.id,
      {
        status: detail.status,
        parentId: detail.parentId,
        blockedBy: detail.blockedBy,
        basis: detail.basis,
      },
    ]),
  );
  const firstmate: Record<string, Record<string, unknown>> = {};
  for (const [role, fields] of Object.entries(RELATIONSHIP_FIELDS))
    firstmate[role] = await firstmateFields(app, keys[role as keyof typeof RELATED], fields);
  return { window: shown, firstmate };
}

/**
 * INF-1296 piece 2, the captain's "i want to make sure this gets good e2e
 * test coverage to ensure exsiting users don't get regressed during this
 * migration". Promised result: tasks an older release related through
 * names in their work shape - a basis, the task a retry branches from and
 * the attempt it retries - beside a parent and a dependency, read the same
 * after the upgrade moves the names into relationships and after a
 * restart, in the window and through the first mate's `tasks` reads; the
 * waiting task stays unstarted; and a basis set after the upgrade reads
 * back as verified. Data: tasks written through the app's own writer,
 * rewritten into the older release's form (`asSavedByOlderRelease`).
 * Completion: the first mate's answers after its reads, and the saved rows
 * read back after the app quits. Prerequisites: the hermetic launcher.
 * Shared resources: none.
 */
test("tasks an older release related by name read the same after the upgrade", async () => {
  const userDataDir = scratchDir("infinitary-upgraded-relationships-");
  const keys = seedRelationships(userDataDir);
  const launch = () =>
    launchApp({ withMockProvider: true, scenarios: [upgradedRelationshipsRead], userDataDir });

  let app: LaunchedApp | undefined = await launch();
  try {
    const before = await relationshipsAsRead(app, keys);
    // The reads name what was seeded, or a match below would compare nothing.
    expect(before.firstmate.retry).toEqual({
      parent: keys.parent,
      basis: keys.plan,
      branch_from: keys.first,
      earlier_attempt: keys.first,
    });
    expect(builtOnKeys(before.firstmate)).toEqual([keys.retry]);
    expect(before.firstmate.waiting).toEqual({
      status: "open",
      basis: UNNAMED_BASIS,
      blocked_by: [keys.wip],
    });
    expect(before.window[RELATED.waiting]?.basis).toEqual({ ref: UNNAMED_BASIS, verified: false });
    expect(before.window[RELATED.retry]?.basis).toEqual({ ref: keys.plan, verified: true });
    await app.close();
    app = undefined;
    const recorded = savedRelationships(userDataDir).references;

    const older = asSavedByOlderRelease(userDataDir);
    // Something was rewritten, or the journey would open this build's own profile.
    expect(older.references).toEqual(
      expect.arrayContaining([
        { taskId: RELATED.retry, field: "basis", ref: keys.plan },
        { taskId: RELATED.retry, field: "branch_from", ref: keys.first },
        { taskId: RELATED.retry, field: "escalate_from", ref: keys.first },
        { taskId: RELATED.waiting, field: "basis", ref: UNNAMED_BASIS },
      ]),
    );
    expect(older.references).toHaveLength(4);
    const asOlder = savedRelationships(userDataDir);
    expect(asOlder.references).toBeUndefined();
    expect(asOlder.shapes[RELATED.retry]).toMatchObject({
      basis: keys.plan,
      branch_from: keys.first,
      escalate_from: keys.first,
    });

    await test.step("upgrade: the window and the first mate read every relationship as before", async () => {
      app = await launch();
      expect(await relationshipsAsRead(app, keys)).toEqual(before);
      await app.close();
      app = undefined;
      const saved = savedRelationships(userDataDir);
      // Each name moved as saved, to the task it names; who named it and when were never saved.
      expect(saved.references).toEqual(
        recorded?.map((row) => ({ ...(row as object), actor: null, recorded_at: null })),
      );
      for (const shape of Object.values(saved.shapes))
        for (const field of ["basis", "branch_from", "escalate_from"])
          expect(shape ?? {}).not.toHaveProperty(field);
    });

    await test.step("restart: the same relationships read the same", async () => {
      app = await launch();
      expect(await relationshipsAsRead(app, keys)).toEqual(before);
      await app.close();
      app = undefined;
    });

    await test.step("a basis set after the upgrade reads back verified, and the plan lists it", async () => {
      const { db, tasks } = taskWriters(userDataDir, Date.now());
      try {
        tasks.updateFields(RELATED.waiting, { basis: keys.plan }, "firstmate");
      } finally {
        db.close();
      }
      app = await launch();
      const after = await relationshipsAsRead(app, keys);
      expect(after.window[RELATED.waiting]).toEqual({
        ...before.window[RELATED.waiting],
        basis: { ref: keys.plan, verified: true },
      });
      expect(after.firstmate.waiting).toEqual({ ...before.firstmate.waiting, basis: keys.plan });
      expect(builtOnKeys(after.firstmate).sort()).toEqual([keys.retry, keys.waiting].sort());
    });
  } finally {
    await app?.close();
  }
});

/** The tasks a profile's running work and policy inputs are seeded on, by role. */
const RUNNING = {
  waiting: "upgraded-waiting-on-you",
  legacy: "upgraded-older-token",
  placed: "upgraded-on-the-mini",
} as const;
/** The computer that runs work the placed task chose. */
const MINI = { id: "studio-mini", name: "Studio mini" };
const WAITING_REASON = "Pick the chart's colors";

/** A placement as Automatic commits it, choosing the Mac mini. */
function miniPlacement() {
  const candidate = {
    physicalComputerId: null,
    missingTools: [],
    reading: { status: "unknown", reason: "out-of-reach" },
    factsAgeMs: null,
    capacity: null,
    reserved: { cpu: 0, memoryBytes: 0 },
    remaining: null,
    model: null,
    preferenceRank: null,
  } as const;
  return placementSnapshotSchema.parse({
    version: 1,
    at: Date.now() - 2 * 60 * 60_000,
    computerId: MINI.id,
    computerName: MINI.name,
    physicalComputerId: "b".repeat(64),
    orderId: `prepare:${RUNNING.placed}`,
    demand: PLACEMENT_DEMANDS.standard,
    model: { provider: "fm-mock", id: "mock-1" },
    acceptedFallback: false,
    requirements: { tools: ["git"], systems: ["macos"], profile: "standard" },
    candidateCount: 1,
    candidates: [{ ...candidate, computerId: MINI.id, name: MINI.name, rejections: [] }],
  });
}

/**
 * Running work and policy inputs as this build writes them, through its own
 * writer: an idle task waiting on the captain with a timed check-back and
 * its conversation recorded, with the delivery,
 * merging and care asked at filing and two edits since (one a reset to the
 * project); a finished task whose resume token no conversation records,
 * its file still in its crewmate's folder; and a finished task Automatic
 * placed on another computer. Nothing here starts on its own.
 */
function seedRunningWork(userDataDir: string): Record<keyof typeof RUNNING, string> {
  const { db, tasks } = taskWriters(userDataDir);
  const sessionFile = (id: string, name: string) => {
    return seedCrewTranscript(userDataDir, id, `${name}.jsonl`, []);
  };
  const facts = (file: string) => ({
    file,
    computer: "this-mac",
    device_id: null,
    provider: "fm-mock",
    model: "mock-1",
    account_id: null,
    began: "start" as const,
  });
  try {
    seedTask(tasks, {
      id: RUNNING.waiting,
      title: "Color the usage chart",
      status: "idle",
      shape: {
        kind: "implement",
        delivery_ask: "local-only",
        autonomy_ask: false,
        rigor_ask: "reviewed",
      },
    });
    const waitingFile = sessionFile(RUNNING.waiting, "colors-1");
    tasks.turns.setSessionFile(RUNNING.waiting, waitingFile, facts(waitingFile));
    tasks.updateFields(
      RUNNING.waiting,
      { policies: { delivery: null, autonomy: true } },
      "firstmate",
    );
    tasks.turns.recordReport(RUNNING.waiting, {
      text: "Two palettes both pass contrast. Which one should the chart use?",
      declared: {
        wait: { reason: WAITING_REASON },
        checkBack: { minutes: 24 * 60, waitingFor: "the captain's pick" },
      },
    });

    seedTask(tasks, {
      id: RUNNING.legacy,
      title: "Fix the chart's axis",
      status: "completed",
      outcome: "The axis starts at zero.",
    });
    // A token from before conversations were recorded: no conversation names it.
    tasks.turns.setSessionFile(RUNNING.legacy, sessionFile(RUNNING.legacy, "axis-older"));
    tasks.close(RUNNING.legacy, { status: "done", reason: "merged", actor: "host" });

    tasks.create({
      id: RUNNING.placed,
      title: "Render the chart on the mini",
      prompt: "",
      repoId: null,
      actor: "captain",
    });
    tasks.placement.commitPlacement(RUNNING.placed, () => miniPlacement());
    const placedFile = `/Users/mini/infinitary/crewmates/${RUNNING.placed}/sessions/render-1.jsonl`;
    tasks.turns.setSessionFile(RUNNING.placed, placedFile, {
      ...facts(placedFile),
      computer: MINI.name,
      device_id: MINI.id,
    });
    tasks.close(RUNNING.placed, { status: "done", reason: "merged", actor: "host" });
    const key = (id: string) => tasks.get(id)?.key ?? "";
    return Object.fromEntries(
      Object.entries(RUNNING).map(([role, id]) => [role, key(id)]),
    ) as Record<keyof typeof RUNNING, string>;
  } finally {
    db.close();
  }
}

/** Each seeded task's running work and policy inputs as the saved rows hold them. */
function savedRunningWork(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const has = (table: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      );
    if (has("task_specifications")) {
      const columns = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      for (const name of [
        "session_file",
        "device_id",
        "idle_since",
        "recovery_rung",
        "placement_json",
      ])
        expect(columns).not.toContain(name);
    }
    const ids = JSON.stringify(Object.values(RUNNING));
    return {
      // An older release's profile has neither table.
      execution: has("task_execution")
        ? db
            .prepare(
              `SELECT task_id, session_file, conversation, device_id, account_id, placement_json,
                 idle_since, recovery_rung, recovery_count, recovery_at, start_notice, turn_json
               FROM task_execution WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id`,
            )
            .all(ids)
        : undefined,
      policies: has("task_policies")
        ? db
            .prepare(
              "SELECT * FROM task_policies WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id",
            )
            .all(ids)
        : undefined,
      tasks: db
        .prepare(
          `SELECT id, ${has("task_specifications") ? "NULL AS session_file, NULL AS device_id, NULL AS idle_since, 0 AS recovery_rung, NULL AS placement_json" : "session_file, device_id, idle_since, recovery_rung, placement_json"},
             delivery_json, shape_json
           FROM ${taskReadTable(db)} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        )
        .all(ids) as Record<string, string | number | null>[],
    };
  });
}

/** The running-work fields the first mate reads of each task, by role. */
const RUNNING_FIELDS = {
  waiting: ["status", "policies", "sessions"],
  legacy: ["status", "policies", "sessions"],
  placed: ["status", "computer", "sessions"],
} as const;

/** What the window and the first mate read of every seeded task's running work. */
async function runningWorkAsRead(app: LaunchedApp, keys: Record<keyof typeof RUNNING, string>) {
  const details = await app.page.evaluate(
    (ids) => Promise.all(ids.map((id) => window.infinitary.tasks.detail(id))),
    Object.values(RUNNING),
  );
  const shown = Object.fromEntries(
    details.map((detail: TaskDetail) => [
      detail.id,
      {
        status: detail.status,
        activity: detail.activity,
        workPosture: detail.workPosture,
        needsYou: detail.flags.needsYou,
        captainWait: detail.captainWait,
        delivery: detail.delivery,
        executionDeviceId: detail.executionDeviceId,
        policies: detail.policies,
        placement: detail.placement,
        events: detail.events.map((event) => event.id),
      },
    ]),
  );
  const firstmate: Record<string, Record<string, unknown>> = {};
  for (const [role, fields] of Object.entries(RUNNING_FIELDS))
    firstmate[role] = await firstmateFields(app, keys[role as keyof typeof RUNNING], fields);
  return { window: shown, firstmate };
}

/** The conversation each session list marks current. */
function currentConversation(read: Record<string, unknown> | undefined): unknown {
  return ((read?.sessions ?? []) as { conversation: string; current: boolean }[]).find(
    (session) => session.current,
  )?.conversation;
}

/**
 * INF-1296 piece 3, the captain's "i want to make sure this gets good e2e
 * test coverage to ensure exsiting users don't get regressed during this
 * migration". Promised result: running work and policy inputs an older
 * release kept on the task row, its delivery facts and its work shape - a
 * resume token its conversation records and one none records, the idle
 * clock, a captain wait and a check-back, a placement on another
 * computer, the asks made at filing and the edits since, and a finished
 * task's closed policies - read the same after the upgrade moves them into
 * their own records and after a restart, in the window and through the
 * first mate's `tasks` reads; and a policy edit and a new turn after the
 * upgrade read back. Data: tasks written through the app's own writer,
 * rewritten into the older release's form (`asSavedByOlderRelease`).
 * Completion: the first mate's answers after its reads, and the saved rows
 * read back after the app quits. Prerequisites: the hermetic launcher.
 * Shared resources: none.
 */
test("running work and policy inputs an older release saved read the same after the upgrade", async () => {
  const userDataDir = scratchDir("infinitary-upgraded-running-work-");
  const keys = seedRunningWork(userDataDir);
  const launch = () =>
    launchApp({ withMockProvider: true, scenarios: [upgradedRelationshipsRead], userDataDir });

  let app: LaunchedApp | undefined = await launch();
  try {
    const before = await runningWorkAsRead(app, keys);
    // The reads name what was seeded, or a match below would compare nothing.
    expect(before.window[RUNNING.waiting]?.policies).toMatchObject({
      delivery: { source: "project" },
      autonomy: { value: true, source: "task" },
      rigor: { requested: "reviewed", source: "task" },
    });
    expect(before.window[RUNNING.legacy]?.policies).toBeTruthy();
    expect(before.window[RUNNING.placed]?.placement?.computerId).toBe(MINI.id);
    expect(before.window[RUNNING.placed]?.executionDeviceId).toBe(MINI.id);
    expect(before.window[RUNNING.waiting]).toMatchObject({ needsYou: true, captainWait: true });
    expect(currentConversation(before.firstmate.waiting)).toBe("colors-1");
    expect(currentConversation(before.firstmate.legacy)).toBe("axis-older");
    expect(currentConversation(before.firstmate.placed)).toBe("render-1");
    await app.close();
    app = undefined;
    const recorded = savedRunningWork(userDataDir);

    const older = asSavedByOlderRelease(userDataDir);
    // Something was rewritten, or the journey would open this build's own profile.
    expect(older.policies).toEqual([RUNNING.waiting]);
    expect(older.execution).toEqual(
      expect.arrayContaining([
        { taskId: RUNNING.waiting, turn: ["captainWait", "checkBack"] },
        { taskId: RUNNING.legacy, turn: expect.any(Array) },
        { taskId: RUNNING.placed, turn: expect.any(Array) },
      ]),
    );
    const asOlder = savedRunningWork(userDataDir);
    expect(asOlder.execution).toBeUndefined();
    expect(asOlder.policies).toBeUndefined();
    const olderWaiting = asOlder.tasks.find((row) => row.id === RUNNING.waiting);
    expect(olderWaiting?.session_file).toContain("colors-1.jsonl");
    // The idle clock this build's launch kept, now on the task row.
    expect(olderWaiting?.idle_since).toEqual(expect.any(Number));
    expect(JSON.parse(String(olderWaiting?.delivery_json))).toMatchObject({
      captainWait: { reason: WAITING_REASON },
    });
    expect(JSON.parse(String(olderWaiting?.shape_json))).toMatchObject({
      delivery_ask: "local-only",
      autonomy_ask: false,
      policies: { delivery: null, autonomy: true },
    });

    await test.step("upgrade: the window and the first mate read all running work as before", async () => {
      app = await launch();
      expect(await runningWorkAsRead(app, keys)).toEqual(before);
      await app.close();
      app = undefined;
      const saved = savedRunningWork(userDataDir);
      // Each value moved as saved; an older token's binding names no conversation.
      expect(saved.execution).toEqual(recorded.execution);
      expect(saved.policies).toEqual(recorded.policies);
      for (const row of saved.tasks) {
        expect([row.session_file, row.device_id, row.idle_since, row.placement_json]).toEqual([
          null,
          null,
          null,
          null,
        ]);
        expect(String(row.delivery_json ?? "")).not.toMatch(/captainWait|checkBack/);
        expect(String(row.shape_json ?? "")).not.toMatch(/delivery_ask|autonomy_ask|rigor_ask/);
      }
    });

    await test.step("restart: the same running work reads the same", async () => {
      app = await launch();
      expect(await runningWorkAsRead(app, keys)).toEqual(before);
      await app.close();
      app = undefined;
    });

    await test.step("a policy edit and a new turn after the upgrade read back", async () => {
      const { db, tasks } = taskWriters(userDataDir, Date.now());
      try {
        tasks.updateFields(RUNNING.waiting, { policies: { rigor: "quick" } }, "firstmate");
        tasks.turns.recordReport(RUNNING.waiting, {
          text: "I used the first palette.",
          declared: { finished: true },
        });
      } finally {
        db.close();
      }
      app = await launch();
      const after = await runningWorkAsRead(app, keys);
      const policies = before.window[RUNNING.waiting]?.policies;
      expect(after.window[RUNNING.waiting]?.policies).toMatchObject({
        delivery: policies?.delivery,
        autonomy: policies?.autonomy,
        rigor: { requested: "quick", source: "task" },
        revision: (policies?.revision ?? 0) + 1,
      });
      expect(after.firstmate.legacy).toEqual(before.firstmate.legacy);
      expect(after.firstmate.placed).toEqual(before.firstmate.placed);
      await app.close();
      app = undefined;
      const saved = savedRunningWork(userDataDir);
      const turn = (saved.execution as { task_id: string; turn_json: string | null }[]).find(
        (row) => row.task_id === RUNNING.waiting,
      )?.turn_json;
      expect(JSON.parse(String(turn))).toEqual({ finishedAt: expect.any(Number) });
    });
  } finally {
    await app?.close();
  }
});

/** The tasks a profile's change evidence and permissions are seeded on, by role. */
const DELIVERED = {
  // Read only: what the window and the first mate read must not move.
  merged: "upgraded-merged-change",
  held: "upgraded-held-approval",
  // Effects: what a kept approval or a settle does at the upgraded boot.
  unanswered: "upgraded-unanswered-merge",
  moved: "upgraded-moved-version",
  pending: "upgraded-pending-settle",
} as const;
const CHART_REPO = "repo-chart";
const CHART_ORIGIN = { host: "github.com", owner: "octo", name: "chart" } as const;
/** The pull request each task's branch has on GitHub, by role. */
const CHART_PULLS = { merged: 61, held: 62, unanswered: 71, moved: 72, pending: 73 } as const;

/**
 * A project on GitHub with one working copy and branch per task, each
 * branch two commits past main: the change, then one more push.
 */
function seedChartProject(userDataDir: string) {
  const repoDir = join(userDataDir, "chart");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: start the chart");
  const branches = {} as Record<
    keyof typeof DELIVERED,
    { branch: string; worktreeDir: string; first: string; head: string }
  >;
  for (const [role, id] of Object.entries(DELIVERED)) {
    const branch = `fm/task-${id}`;
    const worktreeDir = join(userDataDir, "worktrees", id);
    git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
    writeFileSync(join(worktreeDir, `${role}.txt`), `The ${role} change.\n`);
    git("-C", worktreeDir, "add", ".");
    git("-C", worktreeDir, "commit", "-m", `feat: the ${role} change`);
    const first = git("-C", worktreeDir, "rev-parse", "HEAD");
    git(
      "-C",
      worktreeDir,
      "commit",
      "--allow-empty",
      "-m",
      `fix: the ${role} change, pushed again`,
    );
    branches[role as keyof typeof DELIVERED] = {
      branch,
      worktreeDir,
      first,
      head: git("-C", worktreeDir, "rev-parse", "HEAD"),
    };
  }
  const db = openDatabase(userDataDir);
  try {
    seedProject(db, {
      id: CHART_REPO,
      path: repoDir,
      name: "chart",
      setupKind: "clone",
      origin: `https://${CHART_ORIGIN.host}/${CHART_ORIGIN.owner}/${CHART_ORIGIN.name}.git`,
      runsOn: null,
      delivery: "direct-pr",
      rigor: "quick",
    });
    seedHostedOrigins(db, userDataDir);
  } finally {
    db.close();
  }
  return { repoDir, branches };
}

type ChartProject = ReturnType<typeof seedChartProject>;

/** The captain's kept merge approval of a task's pull request, at this version. */
function keptApproval(
  project: ChartProject,
  role: keyof typeof DELIVERED,
  approvedHead: string,
  extra: Partial<MergeAuthorization> = {},
): MergeAuthorization {
  return {
    version: 1,
    id: `approval-${role}`,
    generation: 1,
    issuer: "captain",
    at: Date.now() - 30 * 60_000,
    card: { id: `card-${role}`, offerId: `offer-${role}`, actionId: "merge" },
    target: {
      repoId: CHART_REPO,
      ...CHART_ORIGIN,
      prNumber: CHART_PULLS[role],
      branch: project.branches[role].branch,
      delivery: "direct-pr",
      method: "squash",
    },
    approvedHead,
    lineage: [],
    proceedWithOpen: false,
    status: "standing",
    ...extra,
  };
}

/** A task's change on GitHub as its crewmate opened it, its checks passed at this version. */
function changeOn(role: keyof typeof DELIVERED, head: string) {
  const number = CHART_PULLS[role];
  return {
    mode: "direct-pr" as const,
    prNumber: number,
    prUrl: `https://github.com/octo/chart/pull/${number}`,
    changeLabel: `#${number}`,
    headSha: head,
    ci: "green" as const,
    ciAt: Date.now() - 40 * 60_000,
  };
}

/**
 * Change evidence and permissions as this build writes them, through its
 * own writer, on two tasks nothing at boot acts on: a merged task with its
 * spent approval and receipt, its completion offer and risk, a Careful
 * live validation whose approved effect's outcome nobody knows, a sent
 * write ask, the captain's override and his confirmed required action;
 * and an open task whose approval he withdrew, holding its merge, beside
 * an unsent write ask and a refused completion card.
 */
function seedDeliveryReads(userDataDir: string, project: ChartProject) {
  const { db, tasks } = taskWriters(userDataDir);
  const merged = project.branches.merged;
  const held = project.branches.held;
  try {
    // The merged task's working copy is already gone, so no boot cleans it
    // up while the window reads it.
    seedTask(tasks, {
      id: DELIVERED.merged,
      title: "Label the chart's bars",
      status: "idle",
      repoId: CHART_REPO,
      repoDir: project.repoDir,
    });
    seedTask(tasks, {
      id: DELIVERED.held,
      title: "Color the chart's legend",
      status: "idle",
      repoId: CHART_REPO,
      repoDir: project.repoDir,
      worktreeDir: held.worktreeDir,
      branch: held.branch,
    });
    const requirement = {
      id: "reload-the-chart",
      target: "The chart page",
      title: "Reload the chart page",
      consequence: "The labels show only after a reload.",
      instructions: ["Reload the chart page once."],
      criterion: "The bars show their labels.",
      prerequisites: [],
      completion: { kind: "manual" as const, label: "Reloaded" },
    };
    seedDelivery(tasks, DELIVERED.merged, {
      ...changeOn("merged", merged.head),
      reviewVerdict: "pass",
      reviewSha: merged.head,
      completionOffers: [
        {
          cardId: "card-merged",
          offerId: "offer-merged",
          headSha: merged.head,
          prNumber: CHART_PULLS.merged,
          at: Date.now() - 35 * 60_000,
        },
      ],
      risk: {
        declared: {
          blast: { level: "low", why: "One chart" },
          behavior: { level: "low", why: "Labels a person reads" },
          undo: { level: "low", why: "Revert and done" },
          evidence: { level: "low", why: "Shown working" },
          sensitivity: { level: "low", why: "None" },
          novelty: { level: "low", why: "Well-trodden code" },
          deps: { level: "low", why: "None" },
        },
      },
      mergeAuthorization: keptApproval(project, "merged", merged.head, {
        status: "consumed",
        endedAt: Date.now() - 20 * 60_000,
        receipt: { head: merged.head, sha: `squash-${merged.head}`, at: Date.now() - 20 * 60_000 },
      }),
      writeAsks: [
        {
          id: "ask-label-issue",
          kind: "github",
          host: "github.com",
          place: "GitHub",
          via: "project",
          method: "POST",
          path: "/repos/octo/labels/issues",
          body: '{"title":"Label the bars"}',
          at: Date.now() - 33 * 60_000,
          sentAt: Date.now() - 32 * 60_000,
          outcome: { kind: "sent", status: 201 },
        } as unknown as WriteAsk,
      ],
      requiredActionOffer: {
        cardId: "card-merged",
        offerId: "offer-merged",
        head: merged.head,
        actions: [requirement],
      },
      captainAction: {
        requirements: [
          {
            source: DELIVERED.merged,
            offer: "offer-merged",
            head: merged.head,
            action: requirement,
          },
        ],
        generation: 1,
        state: "confirmed",
        cardId: "card-merged",
        presentedGeneration: 1,
        activatedAt: Date.now() - 20 * 60_000,
        completedAt: Date.now() - 10 * 60_000,
      },
      // An override on the review hold, as a release before INF-1876
      // retired that hold wrote it: the record keeps it and names it retired.
      override: {
        words: "Merge it, the review is late.",
        holds: ["review"],
        until: "version",
        head: merged.head,
        at: Date.now() - 36 * 60_000,
      } as unknown as TaskDelivery["override"],
      liveValidation: {
        stateRevision: 2,
        scenarioRevision: 1,
        scenarios: [],
        plans: [],
        runs: [],
        reviews: [],
        permissions: [
          {
            request: {
              kind: "effect",
              id: "post-preview",
              head: merged.head,
              scenario: "preview",
              action: "Post the preview link",
              destination: "the pull request",
              audience: "collaborators",
              visibility: "others",
              persistent: true,
              purpose: "Show the labels",
              lastingEffects: "A comment stays",
              cleanup: "Delete the comment",
              access: "Your GitHub sign-in",
              preChange: false,
              prerequisitePublication: false,
            },
            scenario: {
              id: "preview",
              source: "the captain's ask",
              importance: "required",
              action: "Open the preview",
              expected: "The labels draw",
              adverse: "No labels",
              environment: "The preview site",
              signal: "The bars' labels",
              boundary: "Read-only",
            },
            state: "unknown",
            at: Date.now() - 34 * 60_000,
            decision: { card: "card-validate", offer: "offer-validate", action: "approve" },
          },
        ],
      } as unknown as TaskDelivery["liveValidation"],
      validationHead: merged.head,
    });
    tasks.close(DELIVERED.merged, { status: "done", reason: "merged", actor: "captain" });

    seedDelivery(tasks, DELIVERED.held, {
      ...changeOn("held", held.head),
      completionOffers: [
        {
          cardId: "card-held",
          offerId: "offer-held",
          headSha: held.first,
          prNumber: CHART_PULLS.held,
          at: Date.now() - 35 * 60_000,
        },
      ],
      mergeAuthorization: keptApproval(project, "held", held.first, {
        status: "revoked",
        reason: "the captain withdrew it",
        endedAt: Date.now() - 25 * 60_000,
        holds: true,
      }),
      writeAsks: [
        {
          id: "ask-legend-issue",
          kind: "github",
          host: "github.com",
          place: "GitHub",
          via: "project",
          method: "POST",
          path: "/repos/octo/legend/issues",
          body: '{"title":"Pick the legend colors"}',
          at: Date.now() - 24 * 60_000,
        } as WriteAsk,
      ],
      cardRefusal: {
        at: Date.now() - 23 * 60_000,
        title: "Color the chart's legend",
        reason: "checks",
        why: "The checks have not passed at this version.",
      },
    });
    const key = (id: string) => tasks.get(id)?.key ?? "";
    return { merged: key(DELIVERED.merged), held: key(DELIVERED.held) };
  } finally {
    db.close();
  }
}

/**
 * The tasks whose permissions act at boot, seeded while the app is stopped:
 * a kept merge whose request went out and whose answer never came, its
 * pull request merged by hand meanwhile; a kept merge of an earlier
 * version than the pull request now holds; and a merge the captain asked
 * for that a quit interrupted.
 */
function seedDeliveryEffects(userDataDir: string, project: ChartProject): void {
  const { db, tasks } = taskWriters(userDataDir);
  try {
    const titles = {
      unanswered: "Sort the chart's bars",
      moved: "Round the chart's corners",
      pending: "Space the chart's ticks",
    } as const;
    for (const role of ["unanswered", "moved", "pending"] as const)
      seedTask(tasks, {
        id: DELIVERED[role],
        title: titles[role],
        status: "idle",
        repoId: CHART_REPO,
        repoDir: project.repoDir,
        worktreeDir: project.branches[role].worktreeDir,
        branch: project.branches[role].branch,
      });
    const { unanswered, moved, pending } = project.branches;
    seedDelivery(tasks, DELIVERED.unanswered, {
      ...changeOn("unanswered", unanswered.head),
      mergeAuthorization: keptApproval(project, "unanswered", unanswered.head, {
        attempt: { token: "attempt-unanswered", head: unanswered.head, at: Date.now() - 60_000 },
      }),
    });
    seedDelivery(tasks, DELIVERED.moved, {
      ...changeOn("moved", moved.head),
      mergeAuthorization: keptApproval(project, "moved", moved.first),
    });
    seedDelivery(tasks, DELIVERED.pending, changeOn("pending", pending.head));
    tasks.delivery.setPendingSettle(DELIVERED.pending, {
      mode: "merge-pr",
      actor: "captain",
      requestedAt: Date.now() - 60_000,
      proceedWithOpen: false,
    });
  } finally {
    db.close();
  }
}

/** Each seeded task's delivery facts as the saved rows hold them. */
function savedDelivery(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const has = (table: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      );
    const ids = JSON.stringify(Object.values(DELIVERED));
    const rows = (table: string) =>
      has(table)
        ? db
            .prepare(
              `SELECT * FROM ${table} WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id`,
            )
            .all(ids)
        : undefined;
    return {
      // An older release's profile has neither table.
      evidence: rows("task_delivery_evidence") as Record<string, unknown>[] | undefined,
      permissions: rows("task_permissions") as Record<string, unknown>[] | undefined,
      tasks: db
        .prepare(
          `SELECT id, delivery_json, pending_settle_json FROM ${taskReadTable(db)}
           WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        )
        .all(ids) as {
        id: string;
        delivery_json: string | null;
        pending_settle_json: string | null;
      }[],
      records: Object.fromEntries(
        new TaskStore(db)
          .list()
          .filter((record) => (Object.values(DELIVERED) as string[]).includes(record.id))
          .map((record) => [
            record.id,
            {
              status: record.status,
              closedReason: record.closedReason,
              delivery: record.delivery,
              pendingSettle: record.pendingSettle,
            },
          ]),
      ),
    };
  });
}

/** The delivery fields the first mate reads of each read-only task, by role. */
const DELIVERY_FIELDS = {
  merged: ["status", "change", "required_action", "live_validation"],
  held: ["status", "change"],
} as const;

/** What the window and the first mate read of the read-only tasks' change and permissions. */
async function deliveryAsRead(
  app: LaunchedApp,
  keys: Record<keyof typeof DELIVERY_FIELDS, string>,
) {
  const details = await app.page.evaluate(
    (ids) => Promise.all(ids.map((id) => window.infinitary.tasks.detail(id))),
    [DELIVERED.merged, DELIVERED.held],
  );
  const shown = Object.fromEntries(
    details.map((detail: TaskDetail) => [
      detail.id,
      {
        status: detail.status,
        closedReason: detail.closedReason,
        flags: detail.flags,
        delivery: detail.delivery,
        requiredAction: detail.requiredAction,
        liveValidation: detail.liveValidation,
        hold: detail.hold,
        asks: detail.asks,
        events: detail.events.map((event) => event.id),
      },
    ]),
  );
  const firstmate: Record<string, Record<string, unknown>> = {};
  for (const [role, fields] of Object.entries(DELIVERY_FIELDS))
    firstmate[role] = await firstmateFields(
      app,
      keys[role as keyof typeof DELIVERY_FIELDS],
      fields,
    );
  return { window: shown, firstmate };
}

/**
 * INF-1296 piece 4, the captain's "i want to make sure this gets good e2e
 * test coverage to ensure exsiting users don't get regressed during this
 * migration". Promised result: change evidence and permissions an older
 * release kept in a task's delivery facts and its settle that had not run
 * on the task row - a spent approval with its receipt, completion offers,
 * risk, live validation with an effect of unknown outcome, write asks, an
 * override, a required action, a withdrawn approval holding the merge and
 * a refused card - read the same in the window and through the first
 * mate's `tasks` reads after the upgrade moves them into their own records
 * and after a restart; and at the upgraded boot a kept merge whose answer
 * never came is read back from GitHub and never sent again, a kept merge
 * of an earlier version than the pull request holds waits for its repair,
 * and the interrupted settle merges exactly once. Data: tasks written
 * through the app's own writer on a real git project with a working copy
 * per task, rewritten into the older release's form
 * (`asSavedByOlderRelease`), and a disposable GitHub (`githubStub`).
 * Completion: the first mate's answers after its reads, the merges GitHub
 * recorded, and the saved rows read back after the app quits.
 * Prerequisites: the hermetic launcher and local git. Shared resources: none.
 */
test("change evidence and permissions an older release saved read the same after the upgrade, and no kept merge is sent twice", async () => {
  const userDataDir = scratchDir("infinitary-upgraded-delivery-");
  const project = seedChartProject(userDataDir);
  const github = await startGitHubStub();
  for (const [role, number] of Object.entries(CHART_PULLS)) {
    const branch = project.branches[role as keyof typeof DELIVERED];
    github.serveNumbered({
      number,
      branch: branch.branch,
      title: `feat: the ${role} change`,
      headSha: branch.head,
    });
  }
  github.mergeByHand(CHART_PULLS.merged);
  seedGitHubSignIn(userDataDir);
  const keys = seedDeliveryReads(userDataDir, project);
  const launch = () =>
    launchApp({
      withMockProvider: true,
      scenarios: [upgradedRelationshipsRead],
      userDataDir,
      env: github.env,
    });
  const mergesOf = (role: keyof typeof DELIVERED) =>
    github.merges().filter((merge) => merge.number === CHART_PULLS[role]);

  let app: LaunchedApp | undefined = await launch();
  try {
    const before = await deliveryAsRead(app, keys);
    // The reads name what was seeded, or a match below would compare nothing.
    expect(before.window[DELIVERED.merged]).toMatchObject({
      status: "done",
      requiredAction: { state: "confirmed" },
    });
    expect(before.firstmate.merged?.live_validation).toMatchObject({
      permissions: [{ state: "unknown" }],
    });
    expect(before.firstmate.held?.change).toEqual({
      label: `#${CHART_PULLS.held}`,
      url: `https://github.com/octo/chart/pull/${CHART_PULLS.held}`,
    });
    await app.close();
    app = undefined;
    const readOnly = savedDelivery(userDataDir);
    expect(readOnly.records[DELIVERED.held]?.delivery?.mergeAuthorization).toMatchObject({
      status: "revoked",
      holds: true,
    });

    seedDeliveryEffects(userDataDir, project);
    github.mergeByHand(CHART_PULLS.unanswered);
    const recorded = savedDelivery(userDataDir);
    const older = asSavedByOlderRelease(userDataDir);
    // Something was rewritten, or the journey would open this build's own profile.
    expect(older.delivery).toEqual(
      expect.arrayContaining(
        Object.values(DELIVERED).map((taskId) => ({
          taskId,
          evidence: true,
          permissions: true,
        })),
      ),
    );
    const asOlder = savedDelivery(userDataDir);
    expect(asOlder.evidence).toBeUndefined();
    expect(asOlder.permissions).toBeUndefined();
    // The older release's rows hold every fact this build read, and the settle on the row.
    expect(asOlder.records).toEqual(recorded.records);
    expect(
      JSON.parse(
        String(asOlder.tasks.find((row) => row.id === DELIVERED.pending)?.pending_settle_json),
      ),
    ).toMatchObject({ mode: "merge-pr" });

    await test.step("upgrade: the window and the first mate read every change and permission as before", async () => {
      app = await launch();
      expect(await deliveryAsRead(app, keys)).toEqual(before);
    });

    await test.step("upgrade: the unanswered merge is read back, never sent again", async () => {
      const task = () =>
        app?.page.evaluate((id) => window.infinitary.tasks.detail(id), DELIVERED.unanswered);
      await expect.poll(task).toMatchObject({ status: "done", closedReason: "merged" });
      expect(mergesOf("unanswered")).toEqual([]);
      expect(
        github
          .requests()
          .filter((request) => request.includes(`/pulls/${CHART_PULLS.unanswered}/merge`)),
      ).toEqual([]);
    });

    await test.step("upgrade: the interrupted settle merges once, and the moved version waits", async () => {
      await expect.poll(() => mergesOf("pending").length).toBe(1);
      expect(mergesOf("pending")[0]?.sha).toBe(project.branches.pending.head);
      await expect
        .poll(() =>
          app?.page.evaluate((id) => window.infinitary.tasks.detail(id), DELIVERED.pending),
        )
        .toMatchObject({ status: "done", closedReason: "merged" });
      await expect
        .poll(
          () =>
            savedDelivery(userDataDir).records[DELIVERED.moved]?.delivery?.mergeAuthorization
              ?.waiting?.on,
        )
        .toBe("repair");
      expect(mergesOf("moved")).toEqual([]);
      await app?.close();
      app = undefined;
      const saved = savedDelivery(userDataDir);
      expect(saved.records[DELIVERED.unanswered]?.delivery?.mergeAuthorization).toMatchObject({
        status: "consumed",
        approvedHead: project.branches.unanswered.head,
        // The pull request read back: its merge, never one this app sent.
        receipt: {
          head: project.branches.unanswered.head,
          sha: `squash-${project.branches.unanswered.head}`,
        },
      });
      expect(
        saved.records[DELIVERED.unanswered]?.delivery?.mergeAuthorization?.attempt,
      ).toBeUndefined();
      expect(saved.records[DELIVERED.moved]?.delivery?.mergeAuthorization).toMatchObject({
        status: "standing",
        approvedHead: project.branches.moved.first,
      });
      expect(saved.records[DELIVERED.pending]?.pendingSettle).toBeNull();
      // The read-only tasks' rows moved as saved, and the column keeps only history.
      for (const id of [DELIVERED.merged, DELIVERED.held]) {
        expect(saved.records[id]).toEqual(readOnly.records[id]);
        expect(saved.evidence?.find((row) => row.task_id === id)).toEqual(
          recorded.evidence?.find((row) => row.task_id === id),
        );
        expect(saved.permissions?.find((row) => row.task_id === id)).toEqual(
          recorded.permissions?.find((row) => row.task_id === id),
        );
      }
      for (const row of saved.tasks) {
        expect(row.pending_settle_json).toBeNull();
        expect(Object.keys(JSON.parse(row.delivery_json ?? "{}"))).toEqual(
          expect.not.arrayContaining(["mergeAuthorization", "completionOffers", "headSha", "ci"]),
        );
      }
    });

    await test.step("restart: the same reads, and no merge is sent again", async () => {
      const merges = github.merges();
      app = await launch();
      expect(await deliveryAsRead(app, keys)).toEqual(before);
      await expect
        .poll(
          () =>
            savedDelivery(userDataDir).records[DELIVERED.moved]?.delivery?.mergeAuthorization
              ?.waiting?.on,
        )
        .toBe("repair");
      await app.close();
      app = undefined;
      expect(github.merges()).toEqual(merges);
    });
  } finally {
    await app?.close();
    await github.close();
  }
});
