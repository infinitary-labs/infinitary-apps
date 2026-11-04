import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { CREW_HOVER } from "../../src/renderer/src/character/crew/hoverMeasures";
import { MODEL_WHY_WORDS } from "../../src/shared/modelChoice";
import { modelDisplayName } from "../../src/shared/modelDisplayName";
import { modelReasonLine } from "../../src/shared/modelReason";
import type { NowGroup } from "../../src/shared/nowPanel";
import { type Reasoning, reasoningNote, reasoningWord } from "../../src/shared/reasoning";
import type { TaskFactId } from "../../src/shared/taskFacts";
import type { PlanItem } from "../../src/shared/taskPlan";
import {
  type TaskStatusInput,
  taskStatusLabel,
  taskStatusOf,
} from "../../src/shared/taskPresentation";
import { BOARD_RECENT_MS } from "../../src/shared/tasks";
import {
  crewFormation,
  crewInspecting,
  crewModelName,
  crewModelNames,
  crewSummary,
  nextFrame,
  pointAtCrewmate,
} from "./crew";
import { type CrewRouting, crewRoster } from "./crewRoster";
import { launchApp } from "./launch";
import { expectClearOf, type Point, slidePointer } from "./layout";
import {
  expandDock,
  expectRecordBody,
  hideRecord,
  nowFrame,
  nowRow,
  openGroup,
  POINT_SUMMARY,
  recordCard,
  recordTab,
  restOnRow,
  rowAtRest,
  rowSummary,
  shownTaskFacts,
  taskFact,
} from "./rails";
import { clickInBody } from "./stack";
import { focusOn } from "./windowKeys";

/** The crewmate's summary and task record share the task's facts.
 * Pointer and keyboard journeys protect access; stage-clock easing and
 * placement arithmetic belong in their focused tests. */

/**
 * Every crewmate fixes a bug the finished basis task reproduced, served at
 * medium as asked.
 */
const ROUTING = {
  shape: { kind: "fix", basis: "hover-crew-basis", basis_verified: true },
  rule: "R6",
  asked: "medium",
  served: "medium",
} satisfies CrewRouting;

/** The second crewmate has opened a pull request whose checks have run for 15 minutes. */
const CHANGE = { prNumber: 612, ci: "pending", startedAgo: 15 * 60_000 } as const;

/** The second crewmate's plan, sent with its note (FI3-734): two done, one current, one next. */
const PLAN: PlanItem[] = [
  { label: "Reproduce the failure locally", short: "Reproduce", state: "done" },
  { label: "Find the cause", short: "Find cause", state: "done" },
  { label: "Fix it and add a regression test", short: "Fix + test", state: "current" },
  { label: "Open the pull request and get the checks green", short: "Pull request", state: "next" },
];

const roster = (count: number) =>
  crewRoster(count, {
    idPrefix: "hover-crew",
    title: (index) => `Hover example ${index + 1}`,
    note: (index) => `Checked example ${index + 1}.`,
    routing: () => ROUTING,
    change: (index) => (index === 1 ? CHANGE : undefined),
    plan: (index) => (index === 1 ? PLAN : undefined),
  });

/**
 * The readout under a crewmate's model: the level the fixture's decision
 * served, the reasoning its dispatch recorded, and the footnote, which says
 * only why that reasoning is lower and is absent when it is not. Why the
 * model was chosen is the full record's alone (INF-1714, the captain's
 * ruling: "don't show this in the hover preview of a task. only show in the
 * full task card").
 */
function readoutOf(reasoning: Reasoning | undefined): {
  tier: string;
  reasoning: string;
  reason: string | null;
} {
  if (!reasoning) throw new Error("The fixture recorded no reasoning for this crewmate");
  return {
    tier: ROUTING.served,
    reasoning: reasoningWord(reasoning),
    reason: reasoningNote(reasoning),
  };
}

/**
 * INF-2528, the captain's direction B: the preview's status keeps the
 * Tasks dot's own short words; every wait's wording is the task card's.
 */
function stateOf(task: TaskStatusInput): string {
  return taskStatusLabel(taskStatusOf(task));
}

/** The summary's facts as it shows them, and whether its state line is cut off. */
function summaryFacts(page: Page) {
  return crewSummary(page).evaluate((panel) => {
    // The shared task facts by identity (FI3-565 piece 2); the key is the summary's own.
    const selectors: Record<string, string> = {
      key: "[data-crew-summary-key]",
      state: '[data-task-fact="status"]',
      title: '[data-task-fact="task"]',
      note: '[data-task-fact="now"]',
      plan: '[data-task-fact="plan"]',
      model: '[data-task-fact="model"]',
      tier: '[data-task-fact="intelligence"]',
      reasoning: '[data-task-fact="reasoning"]',
      reason: '[data-task-fact="reason"]',
      change: '[data-task-fact="change"]',
      checks: '[data-task-fact="checks"]',
    };
    const fact = (name: string) => panel.querySelector(selectors[name] ?? "none");
    const text = (name: string) => fact(name)?.textContent ?? null;
    const state = fact("state");
    return {
      id: panel.getAttribute("data-crew-summary"),
      key: text("key"),
      state: text("state"),
      stateCut: state ? state.scrollWidth > state.clientWidth : true,
      title: text("title"),
      note: text("note"),
      plan: text("plan"),
      // The plan's dots, each item's state in its order (FI3-734).
      dots: [...panel.querySelectorAll("[data-task-plan-dots] [data-plan-item]")].map((dot) =>
        dot.getAttribute("data-plan-item"),
      ),
      model: text("model"),
      tier: fact("tier")?.getAttribute("data-slot") ?? null,
      reasoning: text("reasoning"),
      reason: text("reason"),
      change: text("change"),
      checks: text("checks"),
      checksDot: fact("checks")?.getAttribute("data-dot") ?? null,
    };
  });
}

test("pointing at a crewmate opens its summary, Escape closes it and clicking opens its record", async () => {
  const fixture = await roster(3);
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    mkdirSync(test.info().outputPath("crew-hover"), { recursive: true });
    await expect(crewModelNames(page)).toHaveCount(3);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const task = board.tasks.find((row) => row.id === "hover-crew-1");
    if (!task) throw new Error("The seeded task is missing");
    const { x, y } = await crewFormation(page);
    // Inside the zone but beyond every crewmate, and outside the zone on the bare stage.
    const inside = { x: x + 190, y };

    let pointer = { x: 0, y: 0 };
    let shown: [string, string][] = [];
    const readout = readoutOf(fixture.openings[task.id]);
    await test.step("on a crewmate its summary opens", async () => {
      pointer = await pointAtCrewmate(page, task.id);

      await expect(crewSummary(page)).toBeVisible();
      // The note fills in when the record answers.
      await expect(taskFact(crewSummary(page), "now")).toHaveText("Checked example 2.");
      await expect(taskFact(crewSummary(page), "why")).toHaveCount(0);
      const summary = await summaryFacts(page);
      // INF-2528, the captain's direction B: the model and its level stay;
      // the reasoning and its footnote are the task card's, read below.
      expect(summary).toMatchObject({
        id: task.id,
        key: task.key,
        title: "Hover example 2",
        state: stateOf(task),
        note: "Checked example 2.",
        model: modelDisplayName(fixture.models[1]),
        tier: readout.tier,
        reasoning: null,
        reason: null,
      });
      // Its pull request with its checks as one state and how long they have
      // run by the host's own start (INF-587), on the model's row (INF-2528).
      expect(summary.change).toBe("#612");
      expect(summary.checks).toMatch(/^running for 1[56]m$/);
      expect(summary.checksDot).toBe("running");
      // One footer row: the change sits beside the model, not under it.
      const top = async (fact: TaskFactId) =>
        (await taskFact(crewSummary(page), fact).boundingBox())?.y ?? Number.NaN;
      expect(await top("change")).toBeCloseTo(await top("model"), 0);
      // Its plan (FI3-734): the count and the current item, and one dot per item.
      expect(summary.dots).toEqual(["done", "done", "current", "next"]);
      await expect
        .poll(async () => (await shownTaskFacts(crewSummary(page))).map(([id]) => id))
        .toContain("project");
      shown = await shownTaskFacts(crewSummary(page));
      // The state line is read whole.
      expect(summary.stateCut).toBe(false);
      await expect(page.locator(`[data-crew-target="${task.id}"]`)).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("crew-hover/paused-summary.png") });
    });

    await test.step("Esc closes the summary and lets the stage go until the pointer leaves that crewmate", async () => {
      await page.keyboard.press("Escape");
      await expect(crewSummary(page)).toHaveCount(0);

      expect(await crewInspecting(page)).toBeNull();
      // Still on it: a small move does not reopen what Esc closed.
      await page.mouse.move(pointer.x + 2, pointer.y);
      await nextFrame(page);
      expect(await crewInspecting(page)).toBeNull();
    });

    await test.step("a click on the crewmate opens its task record, and nothing opens under it", async () => {
      await pointAtCrewmate(page, task.id);
      await expect(crewSummary(page)).toBeVisible();
      await page.mouse.down();
      await page.mouse.up();
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expect(crewSummary(page)).toHaveCount(0);
      // The record shows the summary's facts: the same values, and Why this
      // model, which is the record's alone (INF-1714). The fixture's routing
      // row saved no comparison, so it says the model's reason and no list.
      const shared = shown.filter(([id]) => id !== "project");
      const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id);
      const reason = detail.modelReason ? modelReasonLine(detail.modelReason) : null;
      if (!reason) throw new Error("The fixture's routing decision has no wording");
      // The reasoning and its footnote the preview leaves out show here (INF-2528).
      await expect
        .poll(async () => Object.fromEntries(await shownTaskFacts(recordCard(page))))
        .toEqual({
          ...Object.fromEntries(shared),
          reasoning: readout.reasoning,
          ...(readout.reason ? { reason: readout.reason } : {}),
          why: `${MODEL_WHY_WORDS.summary}${reason}.${MODEL_WHY_WORDS.notRecorded}`,
        });
      // The record draws the same plan as the whole list, every item with its mark.
      await expect(recordCard(page).locator("[data-task-plan-list] [data-plan-label]")).toHaveText(
        PLAN.map((item) => item.label),
      );
      // The record's Activity is a tab of its own (INF-2261).
      await expect(recordTab(page, "activity")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("crew-hover/record-facts.png") });

      // Under the record the crew are not there to point at.
      await page.mouse.move(inside.x, inside.y);
      await page.mouse.move(inside.x - 2, inside.y);
      await nextFrame(page);
      expect(await crewInspecting(page)).toBeNull();

      await hideRecord(page).click();
      await expect(crewModelNames(page)).toHaveCount(3);
    });
  } finally {
    await app.close();
  }
});

/** A task that waits for the captain's Start, seeded beside the crew. */
function seedBacklog(userDataDir: string, id: string, title: string): void {
  const db = openDatabase(userDataDir);
  try {
    seedTask(new TaskService({ db, strict: true }), {
      id,
      title,
      status: "queued",
      startPolicy: "on-request",
    });
  } finally {
    db.close();
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** Done eight days ago: the board no longer lists it, and the filter finds it in earlier work. */
function seedEarlier(userDataDir: string, id: string, title: string): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true, now: () => Date.now() - 8 * DAY });
    tasks.create({ id, title, prompt: "p", repoId: null });
    tasks.close(id, { status: "done", reason: "settled", actor: "host" });
  } finally {
    db.close();
  }
}

test("resting on a backlog, an idle or a done Tasks row opens the same summary beside the row", async () => {
  const fixture = await roster(2);
  seedBacklog(fixture.userDataDir, "hover-backlog", "Backlog example");
  seedEarlier(fixture.userDataDir, "hover-earlier", "Reconcile walrus answers");
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    mkdirSync(test.info().outputPath("row-hover"), { recursive: true });
    await expect(crewModelNames(page)).toHaveCount(2);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const byId = (id: string) => {
      const task = board.tasks.find((row) => row.id === id);
      if (!task) throw new Error(`The seeded task ${id} is missing`);
      return task;
    };
    const idle = byId("hover-crew-1");
    const backlog = byId("hover-backlog");
    const done = byId("hover-crew-basis");
    await expandDock(page, "now");
    // The backlog and done are collapsed to their counts until opened.
    const collapsed: NowGroup[] = ["backlog", "landed"];
    for (const group of collapsed) await openGroup(page, group);
    for (const task of [idle, backlog, done]) await expect(nowRow(page, task.key)).toBeVisible();

    let onStage: [string, string][] = [];
    await test.step("the crewmate's own summary, read on the stage", async () => {
      await pointAtCrewmate(page, idle.id);
      await expect(crewSummary(page)).toBeVisible();
      // INF-2528: the reasoning and its footnote are the task card's alone.
      await expect(taskFact(crewSummary(page), "now")).toHaveText("Checked example 2.");
      await expect(taskFact(crewSummary(page), "reasoning")).toHaveCount(0);
      await expect(taskFact(crewSummary(page), "reason")).toHaveCount(0);
      await expect
        .poll(async () => (await shownTaskFacts(crewSummary(page))).map(([id]) => id))
        .toContain("project");
      onStage = await shownTaskFacts(crewSummary(page));
      await page.mouse.move(4, 400);
      await expect(crewSummary(page)).toHaveCount(0);
    });

    await test.step("resting on the idle row opens that same summary beside it, and the stage is untouched", async () => {
      await restOnRow(page, idle.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, idle.id);
      const summary = rowSummary(page).locator("[data-crew-summary]");
      await expect(summary).toHaveAttribute("data-crew-summary", idle.id);
      await expect(taskFact(summary, "now")).toHaveText("Checked example 2.");
      // The same facts, words and order as on the stage.
      await expect.poll(() => shownTaskFacts(summary)).toEqual(onStage);
      // Read once it has settled: the summary slides in from the row.
      await expectClearOf(
        page,
        rowSummary(page).locator("[data-crew-summary]"),
        nowRow(page, idle.key),
        page.locator("[data-prompt-dock]"),
      );
      // Pointing at a row points at no crewmate, and pauses nothing.
      expect(await crewInspecting(page)).toBeNull();
      await page.screenshot({ path: test.info().outputPath("row-hover/idle-row.png") });
    });

    await test.step("a backlog row and a done row each open theirs", async () => {
      for (const task of [backlog, done]) {
        await restOnRow(page, task.key);
        await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, task.id);
        const summary = rowSummary(page).locator("[data-crew-summary]");
        await expect(summary.locator("[data-crew-summary-key]")).toHaveText(task.key);
        await expect(taskFact(summary, "status")).toHaveText(stateOf(task));
        await expect(taskFact(summary, "task")).toHaveText(task.title);
        // Read once it has settled: the summary moves over from the row before.
        await expectClearOf(
          page,
          rowSummary(page).locator("[data-crew-summary]"),
          nowRow(page, task.key),
          page.locator("[data-prompt-dock]"),
        );
        await page.screenshot({
          path: test
            .info()
            .outputPath(`row-hover/${task.id === backlog.id ? "backlog" : "done"}-row.png`),
        });
      }
    });

    await test.step("a row the filter finds in earlier work opens its summary too", async () => {
      expect(BOARD_RECENT_MS).toBeLessThan(8 * DAY);
      const earlier = await page.evaluate(() => window.infinitary.tasks.detail("hover-earlier"));
      await page
        .locator('[data-side-panel="now"]')
        .getByRole("button", { name: "Search tasks" })
        .click();
      const query = nowFrame(page).locator("[data-now-query]");
      await query.fill("walrus");
      await expect(nowRow(page, earlier.key)).toHaveCount(1);
      await restOnRow(page, earlier.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, earlier.id);
      const summary = rowSummary(page).locator("[data-crew-summary]");
      await expect(summary.locator("[data-crew-summary-key]")).toHaveText(earlier.key);
      await expect(taskFact(summary, "task")).toHaveText(earlier.title);
      await expectClearOf(
        page,
        rowSummary(page).locator("[data-crew-summary]"),
        nowRow(page, earlier.key),
        page.locator("[data-prompt-dock]"),
      );
      await page.screenshot({ path: test.info().outputPath("row-hover/earlier-row.png") });
      await query.fill("");
      await expect(nowRow(page, earlier.key)).toHaveCount(0);
    });

    await test.step("leaving the row closes it", async () => {
      // Rest on a row first: the list that just changed under the pointer
      // may have opened whichever row slid under it.
      await restOnRow(page, idle.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, idle.id);
      await page.mouse.move(4, 400);
      await expect(rowSummary(page)).toHaveCount(0);
    });

    await test.step("Esc closes it until the pointer leaves that row", async () => {
      await restOnRow(page, backlog.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, backlog.id);
      await page.keyboard.press("Escape");
      await expect(rowSummary(page)).toHaveCount(0);
      const box = await nowRow(page, backlog.key).boundingBox();
      if (!box) throw new Error("The backlog row is not on screen");
      await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2);
      await nextFrame(page);
      await expect(rowSummary(page)).toHaveCount(0);
    });

    await test.step("a press closes it and still opens the task's record, where the row summary reads over it", async () => {
      await restOnRow(page, idle.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, idle.id);
      const row = nowRow(page, idle.key);
      await focusOn(row);
      // The row dismisses its summary on pointerdown, before its click opens the record.
      await row.dispatchEvent("pointerdown");
      await expect(rowSummary(page)).toHaveCount(0);
      await clickInBody(row);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", idle.id);
      await expect(rowSummary(page)).toHaveCount(0);
      // With the record open, another row still opens its summary over the stack.
      await restOnRow(page, done.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, done.id);
      await expect(rowSummary(page).locator("[data-crew-summary]")).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath("row-hover/over-record.png") });
      // Esc closes the summary over the record, not the record under it -
      // with the keyboard in the window itself, where Esc also hides a record.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await expect(rowSummary(page)).toHaveCount(0);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", idle.id);
      await page.mouse.move(4, 400);
      await expectRecordBody(page);
      await hideRecord(page).click();
    });
  } finally {
    await app.close();
  }
});

test("sliding into a Tasks row from either side opens its summary", async () => {
  const fixture = await roster(2);
  const app = await launchApp({ ...fixture, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { page } = app;
    await expect(crewModelNames(page)).toHaveCount(2);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const task = board.tasks.find((row) => row.id === "hover-crew-1");
    if (!task) throw new Error("The seeded task hover-crew-1 is missing");
    await expandDock(page, "now");
    await expect(nowRow(page, task.key)).toBeVisible();
    // Only the synthetic mouse from here on: Playwright's leaves the frame
    // believing the pointer is still on the last row it moved to.
    await rowAtRest(page, task.key);
    const [row, panel] = await Promise.all([
      nowRow(page, task.key).boundingBox(),
      page.locator('[data-side-panel="now"]').boundingBox(),
    ]);
    if (!row || !panel) throw new Error("The Tasks row is not on screen");
    const middle = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
    const starts: [string, Point][] = [
      // From the stage, crossing the panel's edge into the row.
      ["left", { x: panel.x - 150, y: middle.y }],
      // From the panel's own edge beyond the row.
      ["right", { x: panel.x + panel.width - 4, y: middle.y }],
    ];
    for (const [side, start] of starts) {
      await test.step(`from the ${side}`, async () => {
        await slidePointer(page, start, start, 1);
        await expect(rowSummary(page)).toHaveCount(0);
        await slidePointer(page, start, middle, 12);
        await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, task.id);
        await page.screenshot({ path: test.info().outputPath(`row-slide/from-${side}.png`) });
      });
    }
  } finally {
    await app.close();
  }
});

/**
 * INF-237 ("hover a task anywhere, highlight it everywhere"): a crewmate on
 * the stage and its Tasks row light each other, by the pointer and by the
 * keyboard, with the stage neither slowed nor paused by a rest on the row.
 */
test("a crewmate and its Tasks row light each other, and the stage keeps its speed", async () => {
  const fixture = await roster(2);
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    mkdirSync(test.info().outputPath("lit-task"), { recursive: true });
    await expect(crewModelNames(page)).toHaveCount(2);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const byId = (id: string) => {
      const task = board.tasks.find((row) => row.id === id);
      if (!task) throw new Error(`The seeded task ${id} is missing`);
      return task;
    };
    const first = byId("hover-crew-0");
    const second = byId("hover-crew-1");
    await expandDock(page, "now");
    const formation = page.locator("[data-crew-formation]");
    const stage = page.locator('canvas[data-crew-layer="near"]');

    await test.step("pointing at a crewmate lights its row at once, and moving off clears it", async () => {
      await pointAtCrewmate(page, second.id);
      await expect(nowRow(page, second.key)).toHaveAttribute("data-now-lit", "");
      await expect(nowRow(page, first.key)).not.toHaveAttribute("data-now-lit", "");
      await page.mouse.move(4, 400);
      await expect(nowRow(page, second.key)).not.toHaveAttribute("data-now-lit", "");
    });

    await test.step("resting on a row puts brackets on its crewmate, with no summary and no slowing", async () => {
      await restOnRow(page, second.key);
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, second.id);
      await expect(formation).toHaveAttribute("data-crew-lit", second.id);
      await expect(page.locator(`[data-crew-lit-target="${second.id}"]`)).toBeVisible();
      // The stage's own summary and its pause are for the pointer on a crewmate.
      await expect(page.locator("[data-crew-target]")).toHaveCount(0);
      expect(await crewInspecting(page)).toBeNull();
      await page.screenshot({ path: test.info().outputPath("lit-task/row-to-crewmate.png") });
      await page.mouse.move(4, 400);
      await expect(formation).not.toHaveAttribute("data-crew-lit", /.+/);
      await expect(page.locator("[data-crew-lit-target]")).toHaveCount(0);
    });

    await test.step("the keyboard lights the same: a focused name lights its row, a focused row its crewmate", async () => {
      await focusOn(crewModelName(page, first.id));
      await expect(nowRow(page, first.key)).toHaveAttribute("data-now-lit", "");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(nowRow(page, first.key)).not.toHaveAttribute("data-now-lit", "");
      await focusOn(nowRow(page, second.key));
      await expect(formation).toHaveAttribute("data-crew-lit", second.id);
      expect(await crewInspecting(page)).toBeNull();
    });
  } finally {
    await app.close();
  }
});

/**
 * INF-1146 (crew-hover.spec.ts:514 in run 40092988228: a crew target stayed
 * where none was expected): the summary's beat comes due just as the
 * pointer leaves its crewmate, and nothing opens. The beat's timer is held
 * in the page and comes due in the very task that lets the crewmate go,
 * before any later task, so the order the failing run met by chance is the
 * order of every run. The data: two crewmates. The completion signal: the
 * window has let the crewmate go and the held beat has had its turn.
 * Platform and shared resources: none beyond the hermetic launch.
 */
test("a pointer that leaves a crewmate as its summary's beat comes due opens no summary", async () => {
  const fixture = await roster(2);
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    await expect(crewModelNames(page)).toHaveCount(2);
    await page.evaluate((beat) => {
      type Held = { run: () => void; cleared: boolean };
      const held = new Map<number, Held>();
      const state = { held: 0, armed: false, letGo: false };
      Object.assign(window, { heldBeats: state });
      const setTimer = window.setTimeout.bind(window);
      const clearTimer = window.clearTimeout.bind(window);
      let next = -1;
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay !== beat || typeof handler !== "function")
          return setTimer(handler, delay, ...args);
        const id = next--;
        held.set(id, { run: () => handler(...args), cleared: false });
        state.held += 1;
        return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = ((id?: number) => {
        const timer = id === undefined ? undefined : held.get(id);
        if (timer) timer.cleared = true;
        else clearTimer(id);
      }) as typeof window.clearTimeout;
      // The window lets the crewmate go: every beat still held comes due now.
      const formation = document.querySelector("[data-crew-formation]");
      if (!formation) throw new Error("The crew formation is not drawn");
      new MutationObserver(() => {
        if (!state.armed || state.letGo || formation.hasAttribute("data-crew-inspecting")) return;
        state.letGo = true;
        for (const timer of held.values()) {
          if (timer.cleared) continue;
          timer.cleared = true;
          timer.run();
        }
      }).observe(formation, { attributes: true, attributeFilter: ["data-crew-inspecting"] });
    }, CREW_HOVER.dwellMs);
    type Beats = { held: number; armed: boolean; letGo: boolean };
    const read = () => page.evaluate(() => (window as unknown as { heldBeats: Beats }).heldBeats);

    await pointAtCrewmate(page);
    // The beat for the crewmate pointed at waits, held.
    expect((await read()).held).toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as unknown as { heldBeats: Beats }).heldBeats.armed = true;
    });
    await page.mouse.move(4, 400);
    await expect.poll(async () => (await read()).letGo).toBe(true);
    await nextFrame(page);
    expect(await crewInspecting(page)).toBeNull();
    await expect(page.locator("[data-crew-target]")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
