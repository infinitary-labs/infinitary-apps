import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { UNREADABLE_SUMMARY } from "../../src/panels/knowledge/words";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { knowledgePanel, linkedReferences, OPEN_KNOWLEDGE } from "./knowledgeBrowser";
import { mateBubble } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import {
  FM_SYSTEM_MARKER,
  KNOWLEDGE_FACT_PROMPT_MARKER,
  type MockProviderServer,
  startMockProvider,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { latestContext, requestToolNames } from "./providerRequest";
import { linkedTaskKeys, recordCard, recordFrame } from "./rails";
import { clickInBody, showCard, shownCardFrame } from "./stack";
import { commandSearch, pressWindowKey } from "./windowKeys";

/**
 * The knowledge gate (docs/knowledge.md, "Who has it") through installed
 * builds of one profile: an alpha records, a stable build of the same data
 * offers no knowledge, reads none and leaves the collection's files exactly
 * as they were - through its own purge too - and the next alpha finds what
 * the first one kept. The emulated installed build reports the version the
 * launcher stamps (`launchApp` `version`), the one fact the gate reads.
 */

const STABLE = "0.1.30";
const ALPHA = "0.1.31-alpha.4";

/** Every file of the collection's folder, byte for byte. */
function folder(dir: string): Record<string, string> | null {
  if (!existsSync(dir)) return null;
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
  );
}

/** One captain message, answered; the Firstmate requests it caused. */
async function say(app: LaunchedApp, words: string): Promise<string[]> {
  const before = app.mockProvider?.requestBodies().length ?? 0;
  const input = promptInput(app.page);
  await input.click();
  await input.fill(words);
  await input.press("Enter");
  await expect
    .poll(() => (app.mockProvider?.requestBodies().length ?? 0) > before, { timeout: 30_000 })
    .toBe(true);
  await waitForFirstmateIdle(app.page);
  return (app.mockProvider?.requestBodies() ?? [])
    .slice(before)
    .filter((body) => body.includes(FM_SYSTEM_MARKER));
}

function purgeScope(page: Page) {
  return page.evaluate(() => window.infinitary.retention.scope());
}

/** Whether the build keeps knowledge and has some to show: what the window asks before it registers the Knowledge panel. */
function knowledgeOn(page: Page) {
  return page.evaluate(() => window.infinitary.knowledge.enabled());
}

/** A browser read asked directly, past every surface: its answer, or the refusal's words. */
function readKnowledge(page: Page) {
  return page.evaluate(() =>
    window.infinitary.plugins.read("knowledge.collections", {}).then(
      (value) => ({ answered: value.state }),
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    ),
  );
}

/** Whether command search offers Open Knowledge for the word "knowledge". */
async function offersOpenKnowledge(app: LaunchedApp): Promise<boolean> {
  const search = commandSearch(app.page);
  await pressWindowKey(app.app, "k", ["meta"]);
  await expect(search.dialog).toBeVisible();
  await search.field.fill("knowledge");
  const offered = (await search.row(OPEN_KNOWLEDGE).count()) > 0;
  await app.page.keyboard.press("Escape");
  await expect(search.dialog).toHaveCount(0);
  return offered;
}

const CITING = "Deploys go out on Tuesdays";

/**
 * Written while no app runs: Firstmate's answer citing the entry `id` the
 * alpha recorded, and naming a task whose record it opens. Answers the
 * task's key.
 */
function seedAnswer(userDataDir: string, id: string): string {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    const task =
      tasks.get("deploy-check") ??
      seedTask(tasks, {
        id: "deploy-check",
        title: "Check the deploy day",
        status: "queued",
        startPolicy: "on-request",
      });
    new CardStore(db).upsert({
      id: "card-fm-deploy",
      author: "firstmate",
      priority: 30,
      title: CITING,
      meta: "firstmate",
      body: `<p>Deploys go out on Tuesdays <span class="inf-mono">${id}</span>, as ${task.key} checks.</p>`,
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
    return task.key;
  } finally {
    db.close();
  }
}

/**
 * The cited answer as a build shows it, once it links the references a
 * build with knowledge links: whether the record of the task it names reads
 * what the task's work used.
 */
async function answerAsShown(app: LaunchedApp, taskKey: string, references: number) {
  await showCard(app.page, CITING);
  const body = shownCardFrame(app.page);
  await expect(linkedTaskKeys(body)).toHaveText([taskKey]);
  await expect(linkedReferences(body)).toHaveCount(references);
  await clickInBody(linkedTaskKeys(body).first());
  await expect(recordCard(app.page)).toBeVisible();
  const record = recordFrame(app.page).locator("[data-record]");
  await expect(record).toBeAttached();
  return {
    recordReadsKnowledge: await record.getAttribute("data-knowledge"),
    knowledgeUsed: await recordFrame(app.page)
      .locator('[data-record-section="knowledge"]')
      .isVisible(),
  };
}

async function launch(userDataDir: string, version: string, mockProvider: MockProviderServer) {
  return launchApp({ packaged: true, version, userDataDir, reuseMockProvider: mockProvider });
}

test("stable and alpha share Knowledge reads, tools, citations and purge", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-gate-");
  const knowledgeDir = join(userDataDir, "knowledge");
  const mockProvider = await startMockProvider();
  try {
    // An alpha records a fact the captain states, as knowledge.
    let deployDay = "";
    const alpha = await launch(userDataDir, ALPHA, mockProvider);
    try {
      const requests = await say(alpha, KNOWLEDGE_FACT_PROMPT_MARKER);
      expect(requestToolNames(requests[0] ?? "")).toEqual(
        expect.arrayContaining(["knowledge", "record_knowledge"]),
      );
      expect(await purgeScope(alpha.page)).toEqual({ knowledge: true });
      // The browser's surfaces are there: its panel, its command, its reads.
      expect(await knowledgeOn(alpha.page)).toEqual({ enabled: true, held: true });
      await expect(knowledgePanel(alpha.page)).toBeAttached({ timeout: 30_000 });
      expect(await offersOpenKnowledge(alpha)).toBe(true);
      expect(await readKnowledge(alpha.page)).toEqual({ answered: "ready" });
      const concepts = await alpha.page.evaluate(() =>
        window.infinitary.plugins.read("knowledge.concepts", { scope: "captain" }),
      );
      deployDay = concepts.state === "ready" ? (concepts.rows[0]?.id ?? "") : "";
    } finally {
      await alpha.close();
    }
    const taskKey = seedAnswer(userDataDir, deployDay);
    const kept = folder(knowledgeDir);
    expect(kept && Object.keys(kept)).toContain("knowledge.db");

    // Stable serves the same Knowledge and directions as alpha.
    const stable = await launch(userDataDir, STABLE, mockProvider);
    try {
      const requests = await say(stable, "what do we know about deploy day?");
      const tools = requestToolNames(requests[0] ?? "");
      expect(tools).not.toContain("remember");
      expect(tools).not.toContain("forget");
      expect(tools).toEqual(expect.arrayContaining(["knowledge", "record_knowledge"]));
      expect(latestContext(requests[0] ?? "")).toHaveProperty("knowledge");
      expect(await purgeScope(stable.page)).toEqual({ knowledge: true });
      expect(await knowledgeOn(stable.page)).toEqual({ enabled: true, held: true });
      expect(await offersOpenKnowledge(stable)).toBe(true);
      await expect(knowledgePanel(stable.page)).toBeAttached();
      expect(await readKnowledge(stable.page)).toEqual({ answered: "ready" });
      expect(await answerAsShown(stable, taskKey, 1)).toEqual({
        recordReadsKnowledge: "on",
        knowledgeUsed: false,
      });
    } finally {
      await stable.close();
    }

    // The next alpha finds what the first one kept, from the captain's words,
    // and links it where an answer cites it.
    const againKey = seedAnswer(userDataDir, deployDay);
    const again = await launch(userDataDir, ALPHA, mockProvider);
    try {
      await expect(knowledgePanel(again.page)).toBeAttached({ timeout: 30_000 });
      expect(await answerAsShown(again, againKey, 1)).toEqual({
        recordReadsKnowledge: "on",
        knowledgeUsed: false,
      });
      const requests = await say(again, "what do we know about deploy day?");
      const context = latestContext(requests[0] ?? "") as unknown as {
        knowledge?: { candidates?: string[] };
      };
      expect(context.knowledge?.candidates?.join("\n")).toMatch(
        /c-[a-z0-9]{6} concept "Deploy day"/,
      );
      // Its purge, which says so beforehand, clears the collection.
      await again.page.evaluate(() => window.infinitary.retention.purge());
      expect(folder(knowledgeDir)).toBeNull();
    } finally {
      await again.close();
    }
  } finally {
    await mockProvider.close();
  }
});

test("unreadable directions pause new Firstmate work and leave the collection alone", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-unreadable-");
  const knowledgeDir = join(userDataDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(join(knowledgeDir, "knowledge.db"), "written by something else");
  const before = folder(knowledgeDir);
  const mockProvider = await startMockProvider();
  try {
    const alpha = await launch(userDataDir, ALPHA, mockProvider);
    try {
      const beforeRequests = mockProvider.requestBodies().length;
      const input = promptInput(alpha.page);
      await input.fill(KNOWLEDGE_FACT_PROMPT_MARKER);
      await input.press("Enter");
      await expect(mateBubble(alpha.page)).toHaveAttribute("data-state", "problem");
      expect(mockProvider.requestBodies()).toHaveLength(beforeRequests);
      // The Knowledge panel stays on its rail and says the collection cannot be read.
      await expect(knowledgePanel(alpha.page)).toBeAttached({ timeout: 30_000 });
      await expect(knowledgePanel(alpha.page).locator("[data-panel-summary]")).toContainText(
        UNREADABLE_SUMMARY,
      );
      expect(await readKnowledge(alpha.page)).toEqual({ answered: "unavailable" });
    } finally {
      await alpha.close();
    }
    expect(folder(knowledgeDir)).toEqual(before);
  } finally {
    await mockProvider.close();
  }
});
