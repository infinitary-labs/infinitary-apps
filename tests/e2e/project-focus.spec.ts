import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { ensureRepoProject } from "../../src/core/storage/projectStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { elsewhereWords } from "../../src/shared/projectFocus";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { seedHostedOrigins } from "./projectSeed";
import { activityFrame, expandDock, nowFrame } from "./rails";
import { pager, showCard } from "./stack";
import { pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

/**
 * Focusing the window on one project from the top bar (INF-1091, the
 * captain's approved plan and answers, docs/project-focus.md), driven by
 * keys as a person with a keyboard drives it: Focus on a project opens the
 * pill's row to the right with focus on the checked pill, the arrows move
 * through it and light the project they rest on, Enter picks and folds the
 * row, Esc folds it back, the Tasks panel lists only the focused project's
 * tasks while the pill's tail says what waits elsewhere, other projects'
 * crew dim on the stage, the focus survives a restart, and Show all
 * projects lets it go. Under focus the card stack holds other projects'
 * cards back and Activity hides their lines (INF-1098, the captain's
 * answers to INF-1091's questions 2 and 3).
 */

const PROJECTS = [
  { repoId: "repo-inf", name: "infinitary", key: "INF" },
  { repoId: "repo-web", name: "website", key: "WEB" },
  { repoId: "repo-lab", name: "quota-lab", key: "LAB" },
] as const;

/** Four finished crewmates across three projects, each kept on the stage. */
const WORK = [
  { id: "inf-1", title: "Fix the Linux window buttons", repoId: "repo-inf" },
  { id: "inf-2", title: "Add the retry probe", repoId: "repo-inf" },
  { id: "web-1", title: "Refresh the pricing page", repoId: "repo-web" },
  { id: "lab-1", title: "Read the quota ledger again", repoId: "repo-lab" },
] as const;

/** The tasks that wait on the captain: one in infinitary, one in quota-lab. */
const WAITS_ON = ["inf-1", "lab-1"] as const;

function repo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

function seed(
  userDataDir: string,
  projects: readonly (typeof PROJECTS)[number][] = PROJECTS,
): void {
  const db = openDatabase(userDataDir);
  const now = Date.now();
  const repos = db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
  );
  for (const project of projects)
    repos.run(
      project.repoId,
      repo(join(userDataDir, project.name)),
      project.name,
      now,
      `https://github.com/o/${project.name}.git`,
    );
  seedHostedOrigins(db, userDataDir);
  for (const project of projects)
    ensureRepoProject(db, { id: project.repoId, name: project.name }, now, project.key);
  const tasks = new TaskService({ db, strict: true });
  const repoIds = new Set<string>(projects.map((project) => project.repoId));
  for (const work of WORK.filter((w) => repoIds.has(w.repoId))) {
    const worktreeDir = join(userDataDir, "worktrees", work.id);
    mkdirSync(worktreeDir, { recursive: true });
    // A crewmate that finished and went idle: on the stage, with its model's name.
    seedTask(tasks, {
      ...work,
      status: "completed",
      worktreeDir,
      model: { provider: "fm-mock", id: "mock-1" },
    });
  }
  // A step only the captain can take, set aside: its row waits on the captain.
  for (const source of WAITS_ON.filter((id) =>
    WORK.some((w) => w.id === id && repoIds.has(w.repoId)),
  )) {
    tasks.declareRequiredActions(
      source,
      {
        cardId: `card-${source}`,
        offerId: `offer-${source}`,
        actions: [
          {
            id: "install",
            target: "the Mac mini",
            title: "Install the new version on the Mac mini",
            consequence: "Until then the Mac mini keeps the old version.",
            instructions: ["Open Infinitary on the Mac mini."],
            criterion: "The Mac mini reports the new version.",
            prerequisites: [],
            completion: { kind: "manual", label: "I installed it" },
          },
        ],
      },
      true,
    );
  }
  for (const row of tasks.listOpen().filter((r) => r.delivery?.captainAction)) {
    tasks.presentCaptainAction(row.id);
    tasks.deferCaptainAction(row.id);
  }
  db.close();
}

/** A decision on a task in each project, and one about no task, raised before the window opens. */
const CARDS = [
  { id: "card-inf", taskId: "inf-2", title: "Which test owns the flaky retry?" },
  { id: "card-web", taskId: "web-1", title: "Merge the new pricing page?" },
  { id: "card-lab", taskId: "lab-1", title: "Which ledger row is right?" },
  { id: "card-mate", title: "Read the release notes before the alpha?" },
] as const;

function seedCards(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  const cards = new CardStore(db);
  const now = Date.now();
  CARDS.forEach((card, order) => {
    cards.upsert({
      ...card,
      author: "taskId" in card ? "crewmate" : "firstmate",
      priority: 50,
      meta: "taskId" in card ? "crewmate" : "Firstmate",
      body: `<p>${card.title}</p>`,
      actions: [
        { id: "yes", label: "Yes", default: true },
        { id: "no", label: "Not yet" },
      ],
      status: "ready",
      createdAt: now + order,
    });
  });
  db.close();
}

/** The projects whose task keys Activity's lines name, each once, by key prefix. */
function feedProjects(page: Page): Promise<(string | undefined)[]> {
  return activityFrame(page)
    .locator("[data-feed-row] [data-feed-key]")
    .evaluateAll((keys) =>
      [...new Set(keys.map((key) => key.getAttribute("data-feed-key")?.split("-")[0]))].sort(),
    );
}

/** The keys of the rows the Tasks panel paints, in its order. */
function listedKeys(page: Page): Promise<(string | null)[]> {
  return nowFrame(page)
    .locator("[data-now-row]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-now-key")).sort());
}

/** How lit a crewmate's model name is on the stage: its anchor's opacity. */
function crewLight(page: Page, taskId: string): Promise<number> {
  return page
    .locator(`[data-crew-model-anchor="${taskId}"]`)
    .evaluate((anchor) => Number((anchor as HTMLElement).style.opacity || "1"));
}

const pill = (page: Page): Locator => page.locator("[data-project-focus-pill]");
const row = (page: Page): Locator => page.locator("[data-project-focus-row]");
const option = (page: Page, key: string): Locator =>
  page.locator(`[data-project-focus-option="${key}"]`);

test("the top bar's pill focuses the window on one project by keys, keeps it across a restart, and lets it go", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-project-focus-");
  seed(userDataDir);
  let launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    let { app, page } = launched;
    const board = () => page.evaluate(() => window.infinitary.tasks.board());
    await expect.poll(async () => (await board()).tasks.length).toBe(WORK.length + WAITS_ON.length);
    const projectOf = new Map((await board()).projects.map((project) => [project.id, project.key]));
    const keysOf = async (key: string | null) =>
      (await board()).tasks
        .filter((task) => key === null || projectOf.get(task.projectId) === key)
        .map((task) => task.key)
        .sort();
    const everyKey = await keysOf(null);
    const infKeys = await keysOf("INF");
    await expandDock(page, "now");
    await expect.poll(() => listedKeys(page)).toEqual(everyKey);
    await expect(pill(page)).toContainText("All projects");
    await expect(pill(page)).toHaveAttribute("aria-expanded", "false");
    // Every crewmate is lit while every project is shown.
    for (const work of WORK) await expect.poll(() => crewLight(page, work.id)).toBeGreaterThan(0.6);

    await test.step("Focus on a project opens the row on the checked pill, and the arrows light the project they rest on", async () => {
      await pressWindowKey(app, "p", ["meta", "shift"]);
      await expect(row(page)).toBeVisible();
      await expect(option(page, "all")).toBeFocused();
      await expect(option(page, "all")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("ArrowRight");
      await expect(option(page, "INF")).toBeFocused();
      // Resting on infinitary lights its crew and dims the others before any pick.
      await expect.poll(() => crewLight(page, "lab-1")).toBeLessThan(0.4);
      await expect.poll(() => crewLight(page, "inf-2")).toBeGreaterThan(0.6);
      await expect.poll(() => listedKeys(page)).toEqual(everyKey);
    });

    await test.step("Esc folds the row back to the pill, and nothing is picked", async () => {
      await page.keyboard.press("Escape");
      await expect(row(page)).toHaveCount(0);
      await expect(pill(page)).toBeFocused();
      await expect(pill(page)).toContainText("All projects");
      await expect.poll(() => crewLight(page, "lab-1")).toBeGreaterThan(0.6);
    });

    await test.step("Enter on a project picks it: the row folds, Tasks lists only its tasks and the others' crew dim", async () => {
      await pressKey(pill(page), "Enter");
      await expect(row(page)).toBeVisible();
      await expect(option(page, "all")).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(option(page, "INF")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(row(page)).toHaveCount(0);
      await expect(pill(page)).toContainText("infinitary");
      await expect(pill(page)).toHaveAttribute("data-pf-focused", "");
      await expect.poll(() => listedKeys(page)).toEqual(infKeys);
      await expect(page.locator("[data-project-focus-elsewhere]")).toHaveText(elsewhereWords(1));
      await expect.poll(() => crewLight(page, "lab-1")).toBeLessThan(0.4);
      await expect.poll(() => crewLight(page, "web-1")).toBeLessThan(0.4);
      await expect.poll(() => crewLight(page, "inf-1")).toBeGreaterThan(0.6);
    });

    await test.step("the focus survives a restart", async () => {
      await launched.close();
      launched = await launchApp({ userDataDir, withMockProvider: true });
      ({ app, page } = launched);
      await expect(pill(page)).toContainText("infinitary");
      await expandDock(page, "now");
      await expect.poll(() => listedKeys(page)).toEqual(infKeys);
    });

    await test.step("Show all projects lets the focus go", async () => {
      await runFromSearch(app, page, "project-focus.clear");
      await expect(pill(page)).toContainText("All projects");
      await expect(pill(page)).not.toHaveAttribute("data-pf-focused", "");
      await expect.poll(() => listedKeys(page)).toEqual(everyKey);
      await expect.poll(() => crewLight(page, "lab-1")).toBeGreaterThan(0.6);
    });
  } finally {
    await launched.close();
  }
});

test("under focus the stack holds other projects' cards back and Activity hides their lines, and letting focus go brings both back", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-project-focus-hold-");
  seed(userDataDir);
  seedCards(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    const openCards = () =>
      page.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.id));
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(WORK.length + WAITS_ON.length);
    await expect(pager(page, CARDS.length)).toBeVisible();
    await expandDock(page, "activity");
    await expect.poll(() => feedProjects(page)).toEqual(["INF", "LAB", "WEB"]);

    await test.step("focusing on infinitary holds the other projects' cards back and hides their lines", async () => {
      await pressWindowKey(app, "p", ["meta", "shift"]);
      await expect(option(page, "all")).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(option(page, "INF")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(row(page)).toHaveCount(0);
      // infinitary's card and the first mate's own stay; nothing was closed.
      await expect(pager(page, 2)).toBeVisible();
      await showCard(page, CARDS[0].title);
      await showCard(page, CARDS[3].title);
      expect((await openCards()).sort()).toEqual(CARDS.map((card) => card.id).sort());
      await expect.poll(() => feedProjects(page)).toEqual(["INF"]);
    });

    await test.step("Show all projects brings the held cards and the hidden lines back", async () => {
      await runFromSearch(app, page, "project-focus.clear");
      await expect(pill(page)).toContainText("All projects");
      await expect(pager(page, CARDS.length)).toBeVisible();
      await showCard(page, CARDS[1].title);
      await showCard(page, CARDS[2].title);
      await expect.poll(() => feedProjects(page)).toEqual(["INF", "LAB", "WEB"]);
    });
  } finally {
    await launched.close();
  }
});

test("with one project and an idle workspace the top bar shows no pill, and a workspace task gives the workspace one", async () => {
  // INF-1292: one project of yours plus the app's own workspace showed the
  // pill; the captain chose "while it has a task the Tasks panel lists, as
  // Scratch does".
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-project-focus-one-");
  seed(userDataDir, [PROJECTS[0]]);
  let launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    let { app, page } = launched;
    const board = () => page.evaluate(() => window.infinitary.tasks.board());
    await expect.poll(async () => (await board()).tasks.length).toBe(3);
    // The app registered its own workspace, and the board says which it is.
    const workspace = (await board()).projects.find((p) => p.repo?.kind === "personal");
    expect(workspace?.repo?.name).toBe("personal");
    await expect(page.locator("[data-crew-model-anchor]")).toHaveCount(2);
    await expect(pill(page)).toHaveCount(0);

    await test.step("a task in the workspace's backlog gives it a pill beside the project's", async () => {
      await launched.close();
      const db = openDatabase(userDataDir);
      const { repo_id: repoId } = db
        .prepare("SELECT repo_id FROM projects WHERE id = ?")
        .get(workspace?.id) as { repo_id: string };
      seedTask(new TaskService({ db, strict: true }), {
        id: "per-1",
        title: "Make the stage quieter at night",
        repoId,
        status: "queued",
        startPolicy: "on-request",
      });
      db.close();
      launched = await launchApp({ userDataDir, withMockProvider: true });
      ({ app, page } = launched);
      await expect(pill(page)).toContainText("All projects");
      await pressWindowKey(app, "p", ["meta", "shift"]);
      await expect(row(page)).toBeVisible();
      await expect(option(page, workspace?.key ?? "")).toBeVisible();
      await expect(option(page, "INF")).toBeVisible();
      await expect(page.locator("[data-project-focus-option]")).toHaveCount(3);
    });
  } finally {
    await launched.close();
  }
});

test("a still click opens the row without dimming any crew, and moving onto a pill lights its project", async () => {
  // INF-1292: the row opens under the pointer that pressed the pill, and the
  // pill it lands on lit its project with no movement, dimming the rest.
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-project-focus-pointer-");
  seed(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.tasks.board())).tasks.length)
      .toBe(WORK.length + WAITS_ON.length);
    for (const work of WORK) await expect.poll(() => crewLight(page, work.id)).toBeGreaterThan(0.6);
    // Which row pill the browser says the pointer entered.
    await page.evaluate(() => {
      const entered: string[] = [];
      (window as unknown as { entered: string[] }).entered = entered;
      window.addEventListener(
        "pointerover",
        (event) => {
          const option = (event.target as Element).closest("[data-project-focus-option]");
          if (option) entered.push(option.getAttribute("data-project-focus-option") ?? "");
        },
        true,
      );
    });
    const entered = () => page.evaluate(() => (window as unknown as { entered: string[] }).entered);
    const box = await pill(page).boundingBox();
    if (!box) throw new Error("the pill has no box");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await test.step("a click with the pointer held still opens the row and every crewmate stays lit", async () => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.click(at.x, at.y);
      await expect(row(page)).toBeVisible();
      // The row's pills glide out under the still pointer, and the browser
      // reports a project's pill entered, as the reporter's did.
      await expect.poll(async () => (await entered()).some((key) => key !== "all")).toBe(true);
      // The stage drew frames enough for the light's ease after that pill was
      // entered, and no crewmate dimmed.
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            let left = 30;
            const tick = () => (--left === 0 ? done() : requestAnimationFrame(tick));
            requestAnimationFrame(tick);
          }),
      );
      for (const work of WORK) expect(await crewLight(page, work.id)).toBeGreaterThan(0.6);
    });

    await test.step("moving onto a project's pill lights it, and onto All projects lights everyone", async () => {
      const lab = await option(page, "LAB").boundingBox();
      if (!lab) throw new Error("the quota-lab pill has no box");
      await page.mouse.move(lab.x + lab.width / 2, lab.y + lab.height / 2, { steps: 3 });
      await expect.poll(() => crewLight(page, "inf-1")).toBeLessThan(0.4);
      await expect.poll(() => crewLight(page, "lab-1")).toBeGreaterThan(0.6);
      const all = await option(page, "all").boundingBox();
      if (!all) throw new Error("the All projects pill has no box");
      await page.mouse.move(all.x + all.width / 2, all.y + all.height / 2, { steps: 3 });
      for (const work of WORK)
        await expect.poll(() => crewLight(page, work.id)).toBeGreaterThan(0.6);
    });
  } finally {
    await launched.close();
  }
});
