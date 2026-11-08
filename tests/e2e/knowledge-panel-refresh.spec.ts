import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { counted } from "../../src/panels/knowledge/words";
import {
  FRAME_WATCHDOG_INTERVAL_MS,
  FRAME_WATCHDOG_MISSES,
} from "../../src/renderer/src/plugins/frames/frameController";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { frameIn, panelBody, panelElement } from "./frames";
import { knowledgePanel, knowledgeSummary } from "./knowledgeBrowser";
import { seedKnowledge } from "./knowledgeSeed";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { dockSummary, dockSummaryLine } from "./rails";
import { readKnowledgeData } from "./savedData";
import { KNOWLEDGE_RETIRE_PROMPT_MARKER, knowledgeRetire } from "./scenarios/knowledgeRetire";

/**
 * A collapsed panel keeps refreshing after its page misses pings
 * (FI3-1293). The frame watchdog used to treat four missed pings as a
 * wedge, drop the page's reads, and leave the header on the last counts.
 * This journey pauses a collapsed page for longer than that, then records
 * knowledge: the header must say the new totals, with no Retry.
 */

/** Longer than the watchdog's unanswered pings take to stop a page, with two seconds to spare. */
const PAUSE_MS = FRAME_WATCHDOG_INTERVAL_MS * FRAME_WATCHDOG_MISSES + 2_000;

/** The panel's collapsed count of `n` concepts. */
const conceptsLine = (n: number) => counted(n, "concept", "concepts");

const RETIRED = [
  "lifecycle",
  "reuse",
  "retry",
  "identity",
  "delivery",
  "failures",
  "pins",
  "keeps",
  "returns",
  "retains",
] as const;

function revisions(userDataDir: string, ids: readonly string[]): Map<string, number> {
  return readKnowledgeData(userDataDir, (db) => {
    const read = db.prepare("SELECT revision FROM entries WHERE id = ?");
    return new Map(
      ids.map((id) => {
        const row = read.get(id) as { revision: number } | undefined;
        if (!row) throw new Error(`${id} is not in the collection`);
        return [id, row.revision];
      }),
    );
  });
}

function lifecycles(userDataDir: string, ids: readonly string[]): string[] {
  return readKnowledgeData(userDataDir, (db) => {
    const read = db.prepare("SELECT lifecycle FROM entries WHERE id = ?");
    return ids.map((id) => (read.get(id) as { lifecycle: string }).lifecycle);
  });
}

/** The panel page's process, matched by the iframe the window is showing. */
async function pagePid(app: ElectronApplication, page: Page, panelId: string): Promise<number> {
  const src = await panelElement(page, panelId).getAttribute("src");
  expect(src, `${panelId} has a page`).toBeTruthy();
  const frames = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().flatMap((win) =>
      win.webContents.mainFrame.framesInSubtree.map((frame) => ({
        url: frame.url,
        pid: frame.osProcessId,
        windowPid: win.webContents.getOSProcessId(),
      })),
    ),
  );
  const match = frames.find((frame) => src && frame.url.startsWith(src));
  expect(match, `${panelId} page process`).toBeTruthy();
  expect(match?.pid).not.toBe(match?.windowPid);
  return match?.pid ?? -1;
}

/** Holds the page's process, then lets it run. A gone process stays gone. */
async function pauseProcess(pid: number): Promise<void> {
  process.kill(pid, "SIGSTOP");
  try {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  } finally {
    try {
      process.kill(pid, "SIGCONT");
    } catch {
      // The watchdog already removed the page.
    }
  }
}

test("a collapsed panel paused past the watchdog still shows new knowledge, and Activity does too", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-knowledge-refresh-");
  const seeded = await seedKnowledge(userDataDir);
  const { app, page } = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [knowledgeRetire],
  });
  try {
    const knowledge = knowledgePanel(page);
    const activity = page.locator('[data-side-panel="activity"]');
    await expect(knowledge).toBeAttached({ timeout: 30_000 });
    await expect(knowledge).toHaveAttribute("data-side-panel-collapsed", "");
    await expect(activity).toHaveAttribute("data-side-panel-collapsed", "");
    const summary = knowledgeSummary(page);
    await expect(summary).toContainText(conceptsLine(seeded.concepts.length));
    const activityWords = dockSummaryLine(page, "activity").locator("[data-panel-summary-words]");
    await expect(activityWords).toBeVisible();
    const activityBefore = await activityWords.innerText();
    await waitForFirstmateIdle(page);

    const knowledgePid = await pagePid(app, page, "knowledge");
    const activityPid = await pagePid(app, page, "activity");
    await Promise.all([pauseProcess(knowledgePid), pauseProcess(activityPid)]);

    await expect(page.locator("[data-frame-mount-unresponsive]")).toHaveCount(0);
    await expect(frameIn(knowledge)).toHaveCount(1);
    await expect(frameIn(activity)).toHaveCount(1);

    const targets = RETIRED.map((name) => seeded[name]);
    const named = revisions(userDataDir, targets);
    const input = promptInput(page);
    await input.click();
    await input.fill(
      `${KNOWLEDGE_RETIRE_PROMPT_MARKER} ${targets.map((id) => `${id}@${named.get(id)}`).join(" ")}`,
    );
    await input.press("Enter");
    await expect
      .poll(() => lifecycles(userDataDir, targets), { timeout: 60_000 })
      .toEqual(targets.map(() => "retired"));
    await waitForFirstmateIdle(page);

    await expect(summary).toContainText(
      conceptsLine(seeded.concepts.filter((id) => !targets.includes(id)).length),
    );
    await expect(page.locator("[data-frame-mount-unresponsive]")).toHaveCount(0);
    await expect(activityWords).not.toHaveText(activityBefore);
    await expect(dockSummary(page, "activity")).not.toContainText("stopped responding");
  } finally {
    await app.close();
  }
});

// INF-935: every message between the window and a panel's page passes
// through the main process, so a main-process pause of four seconds or more
// stopped an idle, showing panel ("This panel stopped responding.").
test("an open panel keeps its page through a pause of the app's main process", async () => {
  test.setTimeout(90_000);
  const userDataDir = scratchDir("infinitary-knowledge-main-pause-");
  const seeded = await seedKnowledge(userDataDir);
  const { app, page } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const knowledge = knowledgePanel(page);
    await expect(knowledgeSummary(page)).toContainText(conceptsLine(seeded.concepts.length), {
      timeout: 30_000,
    });
    await knowledge.getByRole("button", { name: "Expand Knowledge" }).click();
    await expect(knowledge).not.toHaveAttribute("data-side-panel-collapsed", "");
    const frame = frameIn(knowledge);
    await expect(panelBody(page, "knowledge").locator("body")).toBeVisible();
    const src = await frame.getAttribute("src");
    expect(src).toBeTruthy();

    // The window's watchdog ticks on while the main process holds still.
    await app.evaluate((_electron, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {}
    }, PAUSE_MS);

    // The same page, neither stopped nor mounted again, and it still draws.
    await expect(knowledge.locator("[data-frame-mount-unresponsive]")).toHaveCount(0);
    await expect(frame).toHaveAttribute("src", src ?? "");
    await expect(panelBody(page, "knowledge").locator("body")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a panel the watchdog stops mounts again once, and a second stop does not keep its old counts in the header", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-knowledge-stopped-");
  const seeded = await seedKnowledge(userDataDir);
  const { app, page } = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [knowledgeRetire],
  });
  try {
    const knowledge = knowledgePanel(page);
    const summary = knowledgeSummary(page);
    const seededLine = conceptsLine(seeded.concepts.length);
    await expect(summary).toContainText(seededLine, { timeout: 30_000 });
    await knowledge.getByRole("button", { name: "Expand Knowledge" }).click();
    await expect(knowledge).not.toHaveAttribute("data-side-panel-collapsed", "");
    await expect(frameIn(knowledge)).toBeVisible();
    const first = await frameIn(knowledge).getAttribute("src");
    expect(first).toBeTruthy();

    // The first stop mounts a fresh page on its own, with no Retry (INF-936).
    await pauseProcess(await pagePid(app, page, "knowledge"));
    await expect(frameIn(knowledge)).not.toHaveAttribute("src", first ?? "", { timeout: 30_000 });
    await expect(panelBody(page, "knowledge").locator("body")).toBeVisible({ timeout: 30_000 });
    await expect(knowledge.locator("[data-frame-mount-unresponsive]")).toHaveCount(0);

    // A second stop of the fresh page is left to the captain's Retry.
    await pauseProcess(await pagePid(app, page, "knowledge"));
    await expect(knowledge.locator("[data-frame-mount-unresponsive]")).toBeVisible({
      timeout: 30_000,
    });
    await knowledge.getByRole("button", { name: "Collapse Knowledge" }).click();
    await expect(summary).toContainText("stopped responding");
    await expect(summary).not.toContainText(seededLine);
  } finally {
    await app.close();
  }
});
