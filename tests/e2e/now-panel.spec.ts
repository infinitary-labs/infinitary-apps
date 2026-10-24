import { expect, type Locator, type Page, test } from "@playwright/test";
import { reportSummary } from "../../src/shared/feed";
import { DROP_TASK_LABEL } from "../../src/shared/recordDrop";
import type { TaskBoard } from "../../src/shared/tasks";
import { CARE_WORDS } from "../../src/shared/vocabulary";
import { waitForFirstmateIdle } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, overflows, resizeWindow, settled, within } from "./layout";
import { MOCK_COMPLETION_TEXT, MOCK_FOLLOWUP_TITLE, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { measured, PERF_TAG } from "./perf";
import { promptInput } from "./prompt";
import {
  dockSummaryParts,
  expandDock,
  expectRecordBar,
  expectRecordBody,
  expectRecordTaskStatus,
  expectTaskMark,
  feedLineOf,
  hideRecord,
  nowFrame,
  nowRow,
  pressRow,
  recordBarButton,
  recordCard,
  recordFact,
  recordFrame,
  reportLine,
  taskFact,
  taskKey,
} from "./rails";
import {
  EMIT_CARDS_PROMPT_MARKER,
  everyCardKind,
  MOCK_QUOTA_NOTE_TITLE,
} from "./scenarios/everyCardKind";
import {
  FILE_FOLLOWUP_PROMPT_MARKER,
  fileFollowup,
  MOCK_FOLLOWUP_WHY,
} from "./scenarios/fileFollowup";
import { closeOpenCards, pager, showCard, shownCard, shownEntry } from "./stack";
import { setThemeViaSettings } from "./theme";
import { pressKey } from "./windowKeys";

/**
 * The now panel and the task-record card against the built app
 * (task-system design section 10, P4). The right rail carries what IS: a
 * Tier-2 frame that paints the board the core pushes, minimal by default,
 * absent while the board holds nothing - and a plain turn, which files a
 * question task, docks it collapsed with no row (FI3-1164: Tasks shows from
 * the first ask's record on). A row painting within one coalescing window of the
 * core's write is the measurement this phase was accepted on; the numbers
 * come from two User Timing measures the frame script records (`now:lag`:
 * the newest row's own write time to its paint; `now:render`: one paint of
 * the groups), read back from inside the frame and printed. The dock starts
 * collapsed, with no frame, so the row that docks it is never measurable
 * from inside; the lag is read on the next crewmate's rows, written while
 * the expanded frame is alive.
 *
 * A click is a pointing gesture: a row opens the record as the PANE docked
 * beside this rail (the captain's detail-pane call), anchored to the row it
 * came from, which the panel paints as selected. Its only controls are
 * close and the action bar - Drop task with an empty next slot, for the idle
 * crewmate here; the bar's other states are record-controls.spec.ts. While the
 * pane is open the turn carries the task as its hint; a row waiting on you
 * brings its decision card to the front instead. Both themes and the
 * narrowest window are checked.
 */

/**
 * From the core writing a row to the frame having painted it. Local paints
 * land ~40-55ms; this is a stall ceiling. Graded only on a perf run
 * (./perf.ts): on a loaded host the number measures the host.
 */
const LAG_BUDGET_MS = 1_000;
/** One paint of the groups, graded the same way. */
const RENDER_BUDGET_MS = 50;

type Measures = { lag: number[]; render: number[] };

function measures(page: Page): Promise<Measures> {
  return nowFrame(page)
    .locator("body")
    .evaluate(() => ({
      lag: performance.getEntriesByName("now:lag").map((entry) => entry.duration),
      render: performance.getEntriesByName("now:render").map((entry) => entry.duration),
    }));
}

function board(page: Page): Promise<TaskBoard> {
  return page.evaluate(() => window.infinitary.tasks.board());
}

/** The window's own box, which a card must stay inside to be read whole. */
function windowBox(page: Page) {
  return page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
}

/** Chromium drops native clicks into a hidden window's sandboxed frames. */
async function clickInFrame(target: ReturnType<Page["locator"]>): Promise<void> {
  await target.evaluate((el) => (el as HTMLElement).click());
}

async function send(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The task the captain commissions. */
const STATUS_NOTE = "write a short status note";
/** The captain's plain turn while its record is open. */
const ASK = "how is this going?";
/** The plain turn that files a closed question and docks the panel. */
const GREETING = "hello there";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ scenarios: [everyCardKind, fileFollowup], withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("Tasks panel, record hints, stack navigation, sizing and filings", {
  tag: PERF_TAG,
}, async () => {
  test.setTimeout(180_000);
  await test.step("an empty board docks nothing, and a plain turn's record docks the panel collapsed with no row", async () => {
    const { page } = launched;
    // Its page runs, off its rail until its own code says it holds something.
    await expect(page.locator('[data-side-panel="now"]')).toBeHidden();
    await send(page, GREETING);
    await expect(feedLineOf(page, { type: "user_turn", text: GREETING })).toBeVisible({
      timeout: 10_000,
    });
    // The turn's ask is filed as a standalone question (P1) - a closed row the
    // panel never lists, whose record docks it collapsed: one header row
    // where the panel says what it holds, waiting and working.
    await expect
      .poll(async () => (await board(page)).tasks.map((task) => [task.kind, task.status]), {
        timeout: 20_000,
      })
      .toEqual([["question", "done"]]);
    const panel = page.locator('[data-side-panel="now"]');
    await expect(panel).toHaveAttribute("data-side-panel-collapsed");
    await expect.poll(() => dockSummaryParts(page, "now")).toEqual(["0 waiting", "0 working"]);
  });

  await test.step("the first row counts under the collapsed panel, and expanding paints the board", async () => {
    const { page } = launched;
    await send(page, `${SPAWN_PROMPT_MARKER} ${STATUS_NOTE}`);
    // A row on the board counts in the collapsed header.
    const panel = page.locator('[data-side-panel="now"]');
    await expect
      .poll(() => dockSummaryParts(page, "now"), { timeout: 30_000 })
      .toEqual(["0 waiting", "1 working"]);

    // Search is a button of the panel's header, pressed into the panel: its
    // click opens the list's search with the caret in it, and closes it again.
    await expandDock(page, "now");
    const frame = nowFrame(page);
    const panelHeader = panel.locator("header");
    await expect(frame.locator("[data-now-filters]")).toBeHidden();
    const filterButton = panelHeader.getByRole("button", { name: "Search tasks" });
    await filterButton.click();
    await expect(frame.locator("[data-now-filters]")).toBeVisible();
    await expect(frame.locator("[data-now-query]")).toBeFocused();
    await filterButton.click();
    await expect(frame.locator("[data-now-filters]")).toBeHidden();

    // The crewmate reports and goes idle.
    await expect(reportLine(page, await taskKey(page, STATUS_NOTE))).toBeVisible({
      timeout: 30_000,
    });
    const { render } = await measures(page);
    expect(render.length).toBeGreaterThanOrEqual(1);
    measured("now:render", render, RENDER_BUDGET_MS);

    // Underway is open by default, so the row is already on screen with its
    // title and project.
    const row = nowRow(page, "SCR-2");
    await expect(row.locator("[data-now-title-text]")).toHaveText(STATUS_NOTE);
    await expect(row).toHaveAttribute("aria-label", /Scratch/);
    await expectTaskMark(page, "SCR-2");
  });

  await test.step("a row opens the record in the normal card stack and stays selected", async () => {
    const { page } = launched;
    const row = nowRow(page, "SCR-2");
    await pressRow(page, "SCR-2");
    await expectRecordTaskStatus(page);
    await expect(recordCard(page).getByText(STATUS_NOTE, { exact: false })).toBeVisible();
    await expect(recordCard(page).getByText("SCR-2", { exact: true })).toBeVisible();
    const task = (await board(page)).tasks.find((task) => task.key === "SCR-2");

    const pane = recordCard(page);
    await expect(pane).toHaveCount(1);
    const paneBox = await pane.boundingBox();
    if (!paneBox) throw new Error("record has no box");
    // The panel marks the open row, and only that row, as selected.
    await expect(row).toHaveAttribute("data-now-selected", "");
    await expect(nowFrame(page).locator("[data-now-row][data-now-selected]")).toHaveCount(1);

    const body = recordFrame(page);
    // Care is its own Details row, read from the task's live policies: the
    // spawn asked for quick, and nothing has been delivered yet.
    const careFact = recordFact(page, "care");
    const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), task?.id ?? "");
    expect(detail).toMatchObject({ delivery: null, policies: { rigor: { value: "quick" } } });
    await expect(careFact).toContainText(CARE_WORDS.quick);
    // Now, the crewmate's own newest doing, leads the record: the report's headline.
    await expect(taskFact(pane, "now")).toHaveText(reportSummary(MOCK_COMPLETION_TEXT));
    // Each section opens on its own; native disclosure is keyboard accessible
    // even inside the sandbox.
    const words = body.locator('[data-record-section="words"] > summary');
    await pressKey(words, "Enter");
    await expect(body.locator("[data-record-goal]")).toBeVisible();
    await clickInFrame(body.locator('[data-record-section="timeline"] > summary'));
    // The report's Activity line opens to the whole report (FI3-901).
    const reportLine = body.locator('[data-record-event="report"] > summary');
    await clickInFrame(reportLine);
    await clickInFrame(body.locator('[data-record-section="details"] > summary'));
    await expect(careFact).toBeVisible();
    await careFact.evaluate((node) => node.scrollIntoView());
    await page.screenshot({ path: test.info().outputPath("dark-task-record-care.png") });
    // The record holds the task's goal, the captain's own words and the whole report.
    await expect(body.locator("[data-record-goal]")).toContainText(STATUS_NOTE);
    await expect(body.locator("[data-record-words]")).toHaveText(
      `${SPAWN_PROMPT_MARKER} ${STATUS_NOTE}`,
    );
    await expect(reportLine).toContainText(reportSummary(MOCK_COMPLETION_TEXT));
    await expect(body.locator('[data-record-event="report"] > [data-record-whole]')).toHaveText(
      MOCK_COMPLETION_TEXT,
    );
    await expect(recordFact(page, "crewmate")).toBeVisible();

    // The action bar (the captain's 4A, 2026-09-28; FI3-565 piece 4): an idle
    // crewmate's record offers Drop task and nothing needs the captain next.
    expect(await expectRecordBar(page)).toMatchObject({ end: "stop-task", next: null });
    await expect(recordBarButton(page, "end")).toHaveAccessibleName(DROP_TASK_LABEL);

    // Stage clicks do nothing; Hide alone removes the entry and selection.
    await page.mouse.click(paneBox.x - 8, paneBox.y + 8);
    await expect(recordCard(page)).toHaveCount(1);
    await expect(row).toHaveAttribute("data-now-selected", "");
    await hideRecord(page).click();
    await expect(recordCard(page)).toHaveCount(0);
    await expect(nowFrame(page).locator("[data-now-row][data-now-selected]")).toHaveCount(0);
    await pressRow(page, "SCR-2");
    await expect(recordCard(page)).toHaveCount(1);
  });

  await test.step("the open record is the turn's hint: a plain turn attaches to its task, and closing reveals the character", async () => {
    const { page } = launched;
    const taskId = (await board(page)).tasks.find((task) => task.key === "SCR-2")?.id as string;
    // Keyboard entry keeps the open record as the turn hint; a pointer click
    // outside the pane dismisses it.
    const record = recordFrame(page);
    // Reopening starts compact, and a live update preserves the rows it opened.
    await expect(record.locator('[data-record-section="words"]')).not.toHaveAttribute("open", "");
    await clickInFrame(record.locator('[data-record-section="words"] > summary'));
    await clickInFrame(record.locator('[data-record-section="timeline"] > summary'));
    const input = promptInput(page);
    await input.fill(ASK);
    await input.press("Enter");
    await expect(feedLineOf(page, { type: "user_turn", text: ASK })).toBeVisible({
      timeout: 10_000,
    });
    // The ask lands on the record, filed by the host on the hinted task.
    await expect
      .poll(
        () =>
          page.evaluate(
            async (id) => (await window.infinitary.tasks.detail(id)).asks.map((ask) => ask.text),
            taskId,
          ),
        { timeout: 20_000 },
      )
      .toContain(ASK);
    // The record's timeline grew by the ask, live, while the card stayed open
    // with the sections the captain had opened.
    await expect(recordFrame(page).locator("[data-record-ask]")).toHaveText(
      new RegExp(escapeRegExp(ASK)),
      {
        timeout: 10_000,
      },
    );
    await expect(record.locator('[data-record-section="words"]')).toHaveAttribute("open", "");
    await expect(record.locator('[data-record-section="timeline"]')).toHaveAttribute("open", "");
    // Now is the crewmate's own newest doing (INF-557; docs/task-record.md,
    // "The Now line"): the captain's ask, the newest row now on the record,
    // stays Activity's, and Now still reads the report's headline.
    await expect(taskFact(recordCard(page), "now")).toHaveText(reportSummary(MOCK_COMPLETION_TEXT));

    await hideRecord(page).click();
    await expect(recordCard(page)).toHaveCount(0);
    await expect(page.locator("[data-character-frame]")).toBeVisible();
    // The panel is untouched by the pane: still one working row.
    await expect(nowRow(page, "SCR-2")).toBeVisible();
  });

  await test.step("with the panel open, the next crewmate's row reaches the frame, its lag from the core's write measured", async () => {
    const { page } = launched;
    // The dock has been open since the first row, so every write from here
    // on lands in a living frame: the lag from the core writing the new
    // crewmate's row to the frame painting it is the number this phase was
    // accepted on, and the frame counts only measures newer than what it had.
    const seen = (await measures(page)).lag.length;
    await send(page, `${SPAWN_PROMPT_MARKER} ${EMIT_CARDS_PROMPT_MARKER}`);
    await expect(nowRow(page, "SCR-3")).toBeVisible({ timeout: 30_000 });
    const { lag, render } = await measures(page);
    const fresh = lag.slice(seen);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    measured("now:lag", fresh, LAG_BUDGET_MS);
    measured("now:render", render, RENDER_BUDGET_MS);
  });

  await test.step("a row waiting on you brings its decision card to the front of the stack", async () => {
    const own = await launchApp({
      scenarios: [everyCardKind, fileFollowup],
      withMockProvider: true,
    });
    const { page } = own;
    try {
      // Own both rows, independent of the panel suite's earlier commissions.
      const otherTitle = "keep the record open";
      await send(page, `${SPAWN_PROMPT_MARKER} ${otherTitle}`);
      const otherKey = await taskKey(page, otherTitle);
      await waitForFirstmateIdle(page);
      await expect
        .poll(async () => (await board(page)).tasks.find((task) => task.key === otherKey)?.activity)
        .toBe("idle");
      await expandDock(page, "now");
      await send(page, `${SPAWN_PROMPT_MARKER} ${EMIT_CARDS_PROMPT_MARKER}`);
      const key = await taskKey(page, EMIT_CARDS_PROMPT_MARKER);
      await expect(pager(page, 3)).toBeVisible({ timeout: 30_000 });
      const frame = nowFrame(page);
      const row = nowRow(page, key);
      await expect(row).toBeVisible();
      await expect(frame.locator('[data-now-group="waiting"] [data-now-row]')).toHaveCount(1);
      await expectTaskMark(page, key);

      const selected = (await board(page)).tasks.find((task) => task.key === key)?.waitingCardId;
      const card = await page.evaluate(
        (id) =>
          window.infinitary.cards.list().then((cards) => cards.find((card) => card.id === id)),
        selected,
      );
      if (!card) throw new Error("The waiting row has no reachable choice.");
      expect(card.status).toBe("ready");
      expect(card.awaiting).toBeUndefined();
      expect(card.actions.length).toBeGreaterThan(0);
      // The row selects the first eligible shown offer, not the first stored one.
      await showCard(page, MOCK_QUOTA_NOTE_TITLE);
      await expect(shownCard(page, card.title)).toHaveCount(0);
      await pressRow(page, key);
      await expect(shownCard(page, card.title)).toBeVisible();
      // The card appears once its body has drawn, and only then takes the
      // window's focus (`focusCard`); until then the card it replaces stays
      // in sight. The captain presses the next row once it has appeared: a
      // press before then loses its click when the card takes focus between
      // the press's focus and its click, so no record opens (INF-532).
      await expect(shownEntry(page)).toHaveCSS("opacity", "1");
      await expect(recordCard(page)).toHaveCount(0);

      // Unrelated work still opens its record without disturbing the choices.
      await pressRow(page, otherKey);
      await expect(recordCard(page).getByText(otherKey, { exact: true })).toBeVisible();
      await expect(pager(page, 4)).toBeVisible();
    } finally {
      await own.app.close();
    }
  });

  await test.step("both themes and the narrowest window: the frames follow the theme and nothing overflows the stage", async () => {
    const { page, app } = launched;
    // Layout needs a non-immersive card, not a previous navigation's choice.
    await showCard(page, MOCK_QUOTA_NOTE_TITLE);
    await pressRow(page, "SCR-2");
    const themeOf = (frame: ReturnType<typeof nowFrame>) =>
      frame.locator("html").evaluate((el) => el.getAttribute("data-theme"));
    await setThemeViaSettings(page, "light");
    await expect.poll(() => themeOf(nowFrame(page))).toBe("light");
    await expect(recordCard(page)).toHaveCount(1);
    await expect.poll(() => themeOf(recordFrame(page))).toBe("light");
    await setThemeViaSettings(page, "dark");
    await expect.poll(() => themeOf(nowFrame(page))).toBe("dark");
    await expect(recordCard(page)).toHaveCount(1);
    await expect.poll(() => themeOf(recordFrame(page))).toBe("dark");

    // The narrowest window the app allows. Both docked rails leave the open
    // record under the room it asks for, so they fold and the record takes
    // the window instead of sitting under either rail; its expanded source
    // content still wraps rather than overflowing its frame.
    const restore = await resizeWindow(app, page, await minimumWindowSize(app));
    const boxOf = async (locator: Locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`${locator} has no box`);
      return box;
    };
    expect(
      within(await settled(page, () => boxOf(recordCard(page))), await windowBox(page)),
    ).toEqual([]);
    await recordFrame(page)
      .locator("details")
      .evaluateAll((nodes) => {
        for (const node of nodes) (node as HTMLDetailsElement).open = true;
      });
    expect(await overflows(recordFrame(page).locator(":root"))).toBe(0);

    // With no card up, the input and panel content stay reachable:
    // the stage is what lies between them, the task prompt fits inside the
    // stage with its empty hint whole on its one line, and the panel's rows
    // ellipsize rather than overflow.
    await hideRecord(page).click();
    await closeOpenCards(page);
    const fit = await settled(page, async () => ({
      left: await boxOf(page.locator('[data-rail="left"]')),
      right: await boxOf(page.locator('[data-rail="right"]')),
      stage: await boxOf(page.locator("[data-stage]")),
      shell: await boxOf(
        page.locator("[data-voice-input-shell]").filter({ has: promptInput(page) }),
      ),
      prompt: await boxOf(promptInput(page)),
      height: await page.evaluate(() => window.innerHeight),
    }));
    const between = {
      x: fit.left.x + fit.left.width,
      y: 0,
      width: fit.right.x - (fit.left.x + fit.left.width),
      height: fit.height,
    };
    expect(within(fit.stage, between)).toEqual([]);
    expect(within(fit.shell, fit.stage)).toEqual([]);
    expect(within(fit.prompt, fit.stage)).toEqual([]);
    // Chromium counts a wrapped hint's lines in the empty field's scroll height.
    await expect(promptInput(page)).toHaveValue("");
    await expect
      .poll(() => promptInput(page).evaluate((field) => field.scrollHeight - field.clientHeight))
      .toBe(0);
    expect(await overflows(nowFrame(page).locator("[data-now-groups]"))).toBe(0);
    await page.screenshot({ path: test.info().outputPath("now-panel-narrow-stage.png") });

    // Restore the record pane for the next check's starting state.
    await pressRow(page, "SCR-2");
    await expect(recordCard(page)).toBeVisible();

    await resizeWindow(app, page, restore);
    // The body may only draw once the record is in view again.
    await expectRecordBody(page);
  });

  await test.step("new Tasks rows remain reachable at the smallest window", async () => {
    const { page } = launched;
    // Reach the growing task list without an open card.
    await hideRecord(page).click();
    await closeOpenCards(page);
    await resizeWindow(launched.app, page, await minimumWindowSize(launched.app));
    const openCount = (await board(page)).tasks.filter((task) => task.status !== "done").length;

    // Real board updates, rather than synthetic frame content, grow the dock.
    for (let i = 0; i < 8; i += 1) {
      await send(page, `${SPAWN_PROMPT_MARKER} grow the Tasks dock ${i + 1}`);
      await expect
        .poll(
          () =>
            board(page).then(
              (value) => value.tasks.filter((task) => task.status !== "done").length,
            ),
          {
            timeout: 20_000,
          },
        )
        .toBe(openCount + i + 1);
    }

    // Every crewmate commissioned above reports and goes idle; wait for that,
    // so the record opened below holds still while its frames are sampled. A
    // report landing mid-sample grows the record, and the pane then rightly
    // moves up to stay clamped - a content change, not the placement below.
    await expect
      .poll(
        () =>
          board(page).then(
            (value) =>
              value.tasks.filter(
                (task) =>
                  task.status === "active" &&
                  (task.activity === "starting" || task.activity === "running"),
              ).length,
          ),
        { timeout: 30_000 },
      )
      .toBe(0);

    const lowestKey = await nowFrame(page)
      .locator("[data-now-row]")
      .last()
      .getAttribute("data-now-key");
    if (!lowestKey) throw new Error("No Tasks row to open");
    await pressRow(page, lowestKey);
    await expect(recordCard(page)).toBeVisible();
    const box = await recordCard(page).boundingBox();
    if (!box) throw new Error("record has no box");
    expect(within(box, await windowBox(page))).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("task-record-stack.png") });
  });

  await test.step("a record that grows uses the normal card cap and outer scroller", async () => {
    const { page } = launched;
    const record = recordCard(page);
    const body = record.locator("[data-card-body]");
    await expect(record).toBeVisible();
    await recordFrame(page)
      .locator("body")
      .evaluate((node) => {
        const grown = document.createElement("div");
        grown.style.height = "1200px";
        node.appendChild(grown);
      });
    await expect
      .poll(() => body.evaluate((node) => node.scrollHeight - node.clientHeight))
      .toBeGreaterThan(0);
    const box = await record.boundingBox();
    if (!box) throw new Error("record has no box");
    expect(within(box, await windowBox(page))).toEqual([]);
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  });

  await test.step("collapsing an expanded group shrinks the Tasks dock", async () => {
    const { page } = launched;
    // The preceding test leaves its record pane open.
    await hideRecord(page).click();
    const panel = page.locator('[data-side-panel="now"]');
    const frame = nowFrame(page);
    const dockHeight = async () => (await panel.boundingBox())?.height ?? 0;

    // A crewmate files a follow-up: an on-request row, so the panel gains its
    // first collapsed group - the backlog, a header carrying only its count. The
    // crew's late reports keep repainting the groups meanwhile; a real group
    // keeps its state through every repaint, which is why the test uses one.
    await send(page, `${SPAWN_PROMPT_MARKER} ${FILE_FOLLOWUP_PROMPT_MARKER}`);
    await expect
      .poll(
        async () => (await board(page)).tasks.some((task) => task.title === MOCK_FOLLOWUP_TITLE),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    const header = frame.locator('[data-now-group-header="backlog"]');
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(header.locator("[data-now-count]")).toHaveText("1");
    await expect(header.locator("[data-now-new]")).toHaveCount(1);
    const backlogRows = frame.locator('[data-now-group="backlog"] [data-now-row]');
    await expect(backlogRows).toHaveCount(0);
    // The filing crewmate's own row is working too; let it report so the
    // dock's height below is a settled one.
    await expect(reportLine(page, await taskKey(page, FILE_FOLLOWUP_PROMPT_MARKER))).toBeVisible({
      timeout: 30_000,
    });
    const collapsed = await dockHeight();

    // Expanding the group shows its row and grows the dock; collapsing it
    // again takes both back.
    await clickInFrame(header);
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(backlogRows).toHaveCount(1);
    await expect(backlogRows.locator("[data-now-title-text]")).toHaveText(MOCK_FOLLOWUP_TITLE);
    await expect.poll(dockHeight).toBeGreaterThan(collapsed);
    const expanded = await dockHeight();
    await clickInFrame(header);
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(backlogRows).toHaveCount(0);
    await expect.poll(dockHeight).toBeLessThan(expanded);
  });

  await test.step("opening a filing clears its new mark, and the record shows why", async () => {
    const { page } = launched;
    const frame = nowFrame(page);
    const header = frame.locator('[data-now-group-header="backlog"]');
    await clickInFrame(header);
    const row = frame.locator('[data-now-group="backlog"] [data-now-row]');
    await pressRow(page, (await row.getAttribute("data-now-key")) ?? "");
    const pane = recordCard(page);
    await expect(pane.getByRole("button", { name: DROP_TASK_LABEL })).toHaveCount(1);
    const body = recordFrame(page);
    await expect(body.locator("[data-record-why]")).toHaveText(MOCK_FOLLOWUP_WHY);
    await expect(header.locator("[data-now-new]")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("quiet-ledger-pane.png") });
  });
});
