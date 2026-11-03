import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { MOVES_WORDS } from "../../src/core/plugins/consentWords";
import { openDatabase } from "../../src/core/storage/db";
import { ensureRepoProject } from "../../src/core/storage/projectStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { MOVE_NOT_ASKED } from "../../src/renderer/src/plugins/panelTasks";
import { scratchDir } from "../helpers/scratchDirs";
import { frameIn, panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  panelHeaderButton,
  shownPanelCard,
  shownPanelCardBody,
  shownPanelCardFrame,
} from "./panelCards";
import { seedPersonalWorkspace } from "./personalFixtures";
import { seedHostedOrigins } from "./projectSeed";
import { promptInput } from "./prompt";
import { recordCard } from "./rails";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";
import { clickInBody, SHOWN_ENTRY, shownCardFrame } from "./stack";
import { pressWindowKey } from "./windowKeys";

/**
 * What a panel can do with the captain's tasks on the shared way
 * (docs/ui-plugins.md, "A panel's cards"; FI3-1014 pieces 2 to 6), driven
 * through the task-desk fixture under tests/fixtures/panel-cards/: its own
 * code says whether it shows and what it holds while collapsed, it points
 * at tasks and marks the ones open, it queues one on the captain's click,
 * its card keeps its place while it pages and aims his next message, and
 * it draws with the app's own task marks and a stylesheet of its own. Once
 * as a panel of his own, once added from elsewhere, walled off, after he
 * agrees to its moves - where a move its code makes while his focus is
 * elsewhere writes nothing. Both draw in frames of their own (INF-2205
 * piece C), where a move counts only while the panel's frame holds the
 * captain's focus; plugins/panelTasks.test.ts holds the refusal.
 */

const PANEL = "task-desk";
const FIXTURE = join(process.cwd(), "tests", "fixtures", "panel-cards", PANEL);
const TITLE = "Task desk";

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** One project and three pieces of open work, written through the one writer. */
function seedDesk(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const now = Date.now();
  let clock = now - 60 * 60_000;
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  ).run("repo-fm", repo(join(userDataDir, "fm")), "firstmate", now, "https://github.com/o/fm.git");
  seedHostedOrigins(db, userDataDir);
  ensureRepoProject(db, { id: "repo-fm", name: "firstmate" }, now, "FM3K");
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const seed = (seedValue: Parameters<typeof seedTask>[1]) => {
    clock += 60_000;
    seedTask(tasks, { repoId: "repo-fm", ...seedValue });
  };
  // FM3K-1: in the backlog, held until next month, so a queue starts nothing.
  seed({
    id: "alpha",
    title: "Ship the alpha",
    status: "queued",
    startPolicy: "on-request",
    gate: { kind: "at-time", until: now + 30 * 24 * 60 * 60_000 },
  });
  // FM3K-2: in the backlog.
  seed({ id: "beta", title: "Search task history", status: "queued", startPolicy: "on-request" });
  // FM3K-3: working, its crewmate idle with its work kept.
  const worktree = join(userDataDir, "worktrees", "setup");
  mkdirSync(worktree, { recursive: true });
  seed({
    id: "setup",
    title: "Simplify project setup",
    status: "completed",
    worktreeDir: worktree,
  });
  clock = now;
  db.close();
}

const detail = (page: Page, id: string) =>
  page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);

/** Whether the task's record names the panel in the Activity line of a move it made. */
const namesThePanel = async (page: Page, id: string) =>
  (await detail(page, id)).activityLog.some((row) => row.text.includes(`From the ${TITLE} panel.`));

test.describe("a panel of the captain's own works with his tasks", () => {
  let launched: LaunchedApp;

  test.beforeEach(async () => {
    const userDataDir = scratchDir("infinitary-e2e-panel-tasks-");
    seedDesk(userDataDir);
    seedPersonalWorkspace(userDataDir, FIXTURE, PANEL);
    launched = await launchApp({ scenarios: [installPanel], userDataDir, withMockProvider: true });
    await resizeWindow(launched.app, launched.page, { width: 1600, height: 900 });
  });

  test.afterEach(async () => {
    await launched.close();
  });

  test("shows and summarizes itself, moves on a click only, points, keeps its card's place and aims the turn", async () => {
    test.setTimeout(120_000);
    const { app, page } = launched;
    const panel = page.locator(`[data-side-panel="${PANEL}"]`);
    // Its body and its card draw in frames of their own (INF-2205 piece C).
    const desk = panelBody(page, PANEL).locator("[data-fixture-desk]");

    await test.step("its own code puts it on its rail and, collapsed, says what it holds while its page runs on", async () => {
      await expect(desk.locator("[data-desk-row]")).toHaveCount(3, { timeout: 30_000 });
      await expect(panel).not.toHaveAttribute("hidden", /.*/);
      // The app's own status mark, from the panel library.
      await expect(desk.locator('[data-desk-row="FM3K-3"] [data-task-mark]')).toHaveCount(1);
      await panel.getByRole("button", { name: `Collapse ${TITLE}` }).click();
      await expect(panel.locator("[data-panel-summary]")).toHaveText("3 open");
      await expect(desk).toHaveAttribute("data-collapsed", "");
      await expect(desk).toBeHidden();
      await panel.getByRole("button", { name: `Expand ${TITLE}` }).click();
      await expect(desk).toBeVisible();
    });

    await test.step("a move from the captain's click runs the record's own path and names the panel", async () => {
      const queue = desk.locator('[data-desk-queue="FM3K-1"]');
      await expect(queue).toBeEnabled();
      // A row says why a move is closed to it, from the record's own rule.
      await expect(desk.locator('[data-desk-queue="FM3K-3"]')).toBeDisabled();
      // e2e-frame-actions: native -- This journey proves a real pointer grants permission to move a task.
      await queue.click();
      await expect.poll(async () => (await detail(page, "alpha")).startPolicy).toBe("when-ready");
      await expect.poll(() => namesThePanel(page, "alpha")).toBe(true);
      await expect(desk.locator("[data-desk-said]")).toHaveText("FM3K-1 queued");
      await expect(desk.locator('[data-desk-open-task="FM3K-1"]')).toHaveAttribute(
        "data-desk-policy",
        "when-ready",
      );
    });

    await test.step("resting on a task opens its summary beside it, and a click opens its record, which the panel then marks", async () => {
      const row = desk.locator('[data-desk-open-task="FM3K-2"]');
      // e2e-frame-actions: native -- This journey proves native pointer routing from the panel to its summary.
      await row.hover();
      await expect(page.locator("[data-point-summary]")).toHaveAttribute(
        "data-point-summary",
        "beta",
      );
      // e2e-frame-actions: native -- This journey proves a real pointer in the panel opens its task record.
      await row.click();
      await expect(recordCard(page)).toBeVisible();
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute("data-stage-entry-id", "record:beta");
      await expect(row).toHaveAttribute("data-open", "");
    });

    await test.step("its card keeps its place while the captain pages away, and lets it go on Hide", async () => {
      await panelHeaderButton(page, PANEL, "open").click();
      const card = shownPanelCardBody(page, PANEL, "desk");
      const find = card.locator("[data-desk-find]");
      await find.fill("search");
      await expect(card.locator("[data-desk-aim]")).toHaveCount(1);
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute("data-stage-entry-id", "record:beta");
      await pressWindowKey(app, "[", ["meta", "shift"]);
      await expect(card.locator("[data-desk-find]")).toHaveValue("search");
      await expect(card.locator("[data-desk-aim]")).toHaveCount(1);
    });

    await test.step("a task the card aims at is the turn's hint while the card is shown", async () => {
      const card = shownPanelCardBody(page, PANEL, "desk");
      await clickInBody(card.locator('[data-desk-aim="FM3K-2"]'));
      await expect(card.locator('[data-desk-aim="FM3K-2"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await pressWindowKey(app, "l", ["meta"]);
      await promptInput(page).fill("is the history search still needed?");
      await promptInput(page).press("Enter");
      await expect
        .poll(async () => (await detail(page, "beta")).asks.map((ask) => ask.text), {
          timeout: 20_000,
        })
        .toContain("is the history search still needed?");
    });

    await test.step("Hide lets the card's place go: the next one starts fresh", async () => {
      await page
        .locator(`${SHOWN_ENTRY} [data-panel-card-chrome]`)
        .getByRole("button", { name: "Hide", exact: true })
        .click();
      await expect(shownPanelCard(page, PANEL, "desk")).toHaveCount(0);
      await panelHeaderButton(page, PANEL, "open").click();
      await expect(shownPanelCardBody(page, PANEL, "desk").locator("[data-desk-find]")).toHaveValue(
        "",
      );
    });
  });
});

test.describe("a panel from elsewhere moves tasks only after the captain agrees", () => {
  let launched: LaunchedApp;
  let source: string;

  test.beforeEach(async () => {
    const userDataDir = scratchDir("infinitary-e2e-panel-tasks-added-");
    seedDesk(userDataDir);
    source = join(scratchDir("infinitary-e2e-panel-tasks-source-"), PANEL);
    cpSync(FIXTURE, source, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({ ...manifest, name: "Acme", version: "1.0.0" }),
    );
    launched = await launchApp({ scenarios: [installPanel], userDataDir, withMockProvider: true });
    await resizeWindow(launched.app, launched.page, { width: 1600, height: 900 });
  });

  test.afterEach(async () => {
    await launched.close();
  });

  test("asks once in his words, then moves on a click in its frame, summarizes itself and keeps its card's place", async () => {
    test.setTimeout(120_000);
    const { app, page } = launched;
    const panel = page.locator(`[data-side-panel="${PANEL}"]`);
    const frame = panelBody(page, PANEL);

    await test.step("the consent card says it can move his tasks, and only his click adds it", async () => {
      const input = promptInput(page);
      await input.click();
      await input.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
      await input.press("Enter");
      const add = page.getByRole("button", { name: "Add it", exact: true });
      await add.waitFor({ timeout: 30_000 });
      await expect(shownCardFrame(page).locator("body")).toContainText(MOVES_WORDS);
      await add.click();
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator("[data-side-panel-attribution]")).toHaveText("Acme");
      await expect(frame.locator("[data-desk-row]")).toHaveCount(3, { timeout: 15_000 });
    });

    await test.step("a click inside its frame queues a task through the record's own path, naming it", async () => {
      // e2e-frame-actions: native -- This journey proves a real pointer grants permission to move a task.
      await frame.locator('[data-desk-queue="FM3K-1"]').click();
      await expect.poll(async () => (await detail(page, "alpha")).startPolicy).toBe("when-ready");
      await expect.poll(() => namesThePanel(page, "alpha")).toBe(true);
    });

    await test.step("a move it makes on its own, while focus is elsewhere, writes nothing", async () => {
      await pressWindowKey(app, "l", ["meta"]);
      await expect(promptInput(page)).toBeFocused();
      await page.evaluate(
        (extensionId) =>
          window.infinitary.plugins.db.request({
            op: "set",
            extensionId,
            key: "sneak",
            value: "beta",
          }),
        PANEL,
      );
      await expect(frame.locator("[data-desk-said]")).toContainText(MOVE_NOT_ASKED);
      expect((await detail(page, "beta")).startPolicy).toBe("on-request");
    });

    await test.step("collapsed, its page runs on and its header says what it holds", async () => {
      await panel.getByRole("button", { name: `Collapse ${TITLE}` }).click();
      await expect(panel.locator("[data-panel-summary]")).toHaveText("3 open");
      await expect(frameIn(panel)).toHaveCount(1);
      await panel.getByRole("button", { name: `Expand ${TITLE}` }).click();
    });

    await test.step("its card, walled off in a frame of its own, keeps its place while it pages", async () => {
      await panelHeaderButton(page, PANEL, "open").click();
      const card = shownPanelCardFrame(page);
      await card.locator("[data-desk-find]").fill("ship");
      await expect(card.locator("[data-desk-aim]")).toHaveCount(1);
      // Resting on a task in its frame opens the summary beside the panel.
      // e2e-frame-actions: native -- This journey proves native pointer routing from the panel to its summary.
      await frame.locator('[data-desk-open-task="FM3K-2"]').hover();
      await expect(page.locator("[data-point-summary]")).toHaveAttribute(
        "data-point-summary",
        "beta",
      );
      // e2e-frame-actions: native -- This journey proves a real pointer in the panel opens its task record.
      await frame.locator('[data-desk-open-task="FM3K-2"]').click();
      await expect(page.locator(SHOWN_ENTRY)).toHaveAttribute("data-stage-entry-id", "record:beta");
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await expect(shownPanelCard(page, PANEL, "desk")).toBeVisible();
      await expect(shownPanelCardFrame(page).locator("[data-desk-find]")).toHaveValue("ship", {
        timeout: 15_000,
      });
    });
  });
});
