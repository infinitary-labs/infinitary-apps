import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import type { FmEvent } from "../../src/shared/events";
import { feedLineFrom } from "../../src/shared/feed";
import type { NowGroup } from "../../src/shared/nowPanel";
import { type RecordBar, recordBarOf } from "../../src/shared/recordBar";
import { HIDE_RECORD_LABEL } from "../../src/shared/recordDrop";
import type { RecordFact } from "../../src/shared/recordFacts";
import type { TaskFactId } from "../../src/shared/taskFacts";
import { taskStatusLabel, taskStatusOf } from "../../src/shared/taskPresentation";
import type { TaskEventKind } from "../../src/shared/tasks";
import { recordAttentionWaits, taskWaitStatus, taskWaitText } from "../../src/shared/taskWaits";
import { nextFrame } from "./crew";
import { drawnFrame, frameElement, railFrame } from "./frames";
import { takeTurn } from "./inputQueue";
import { slidePointer } from "./layout";
import { SHOWN_ENTRY } from "./stack";

/**
 * The rails' built-in panels (docs/ui-plugins.md, "The app's own panels
 * are ordinary folders"; task-system P4). The activity feed and the Tasks
 * panel are panel folders drawn in frames of their own, so a feed line or
 * task row lives inside `iframe[title="Activity"]` / `iframe[title="Tasks"]`
 * and page-level locators do not see it; the task-record card's body is a
 * frame too. Every spec that reads one goes through here, so the vehicle
 * is named in one place.
 *
 * Both docks start COLLAPSED (`DEFAULT_COLLAPSED_PANELS` in the rail
 * store). A collapsed dock keeps its page running out of sight - so it can
 * say what it holds in its header (`[data-panel-summary]`) - but nothing in
 * it shows until the dock is expanded.
 */

type DockId = "activity" | "now";

const DOCK_TITLES: Record<DockId, string> = { activity: "Activity", now: "Tasks" };

/** A built-in dock's title: its section's name, and its header's words while no line stands in. */
export function dockTitle(dock: DockId): string {
  return DOCK_TITLES[dock];
}

/** A built-in dock's section, named by its title whether the header shows the title or a summary line. */
export function dockRegion(page: Page, dock: DockId): Locator {
  return page.getByRole("region", { name: DOCK_TITLES[dock] });
}

/** In-flight expands per page, so overlapping calls share one click. */
const expanding = new WeakMap<Page, Map<DockId, Promise<void>>>();

/**
 * Expand a collapsed built-in dock so its frame is mounted, and return once
 * it is. Idempotent: an expanded dock is left alone, and two overlapping
 * calls share one click - the chevron is a toggle, so a second click would
 * collapse it again. Waits for the dock to exist first (it docks only once
 * its source has content), so this may be called before the first row.
 * Presses on two docks of one page take turns with each other and with
 * the input helpers (`takeTurn`, tests/e2e/inputQueue.ts): a dock is often
 * expanded in the background while a spec expands the other one or presses
 * a key, and two overlapping presses can swallow one while it reports
 * success, leaving its dock collapsed and its frame unpainted.
 */
export async function expandDock(page: Page, dock: DockId): Promise<void> {
  let pending = expanding.get(page);
  if (!pending) {
    pending = new Map();
    expanding.set(page, pending);
  }
  const inFlight = pending.get(dock);
  if (inFlight) return inFlight;
  const map = pending;
  const run = (async () => {
    const panel = page.locator(`[data-side-panel="${dock}"]`);
    await panel.waitFor({ state: "attached", timeout: 30_000 });
    await takeTurn(page, async () => {
      if ((await panel.getAttribute("data-side-panel-collapsed")) === null) return;
      await panel.getByRole("button", { name: `Expand ${DOCK_TITLES[dock]}` }).click();
      await expect(panel).not.toHaveAttribute("data-side-panel-collapsed", "");
    });
  })().finally(() => {
    map.delete(dock);
  });
  map.set(dock, run);
  return run;
}

/** Expand in the background so a frame locator can be handed back at once. */
function revealIfCollapsed(page: Page, dock: DockId): void {
  void expandDock(page, dock).catch(() => {
    // The dock never appeared within the wait: the locator's own timeout
    // reports that, with the assertion that wanted it.
  });
}

// A board card can also be titled Tasks; a dock read names its owning side panel.
const dockFrameSelector = (dock: DockId) =>
  `[data-side-panel="${dock}"] iframe[title="${DOCK_TITLES[dock]}"]`;

/** A dock's frame as an element: it runs while the dock is collapsed, and shows only while it is expanded. */
export function dockFrameElement(page: Page, dock: DockId): Locator {
  return page.locator(dockFrameSelector(dock));
}

/** A dock's page once drawn, whether the dock is expanded or not: a journey about the shortcut that opens it reads it as it stands. */
export function dockBody(page: Page, dock: DockId): FrameLocator {
  return railFrame(page, dockFrameSelector(dock));
}

/**
 * A dock's page once drawn, expanded first if it was collapsed. While a
 * card folds the rails the dock is out of sight and cannot draw, so it is
 * read as it stands (`railFrame`).
 */
export function activityFrame(page: Page): FrameLocator {
  revealIfCollapsed(page, "activity");
  return railFrame(page, dockFrameSelector("activity"));
}

/** The Tasks dock's page, as `activityFrame` reads the Activity dock's. */
export function nowFrame(page: Page): FrameLocator {
  revealIfCollapsed(page, "now");
  return railFrame(page, dockFrameSelector("now"));
}

/**
 * One now-panel row by its task key, as a selector: for a measuring script
 * that must find the row inside one synchronous read of the frame.
 */
export function nowRowSelector(key: string): string {
  return `[data-now-row][data-now-key="${key}"]`;
}

/** One now-panel row by its task key, as the frame paints it. */
export function nowRow(page: Page, key: string): Locator {
  return nowFrame(page).locator(nowRowSelector(key));
}

/**
 * Presses a Tasks row as the captain's click does: the click gives the
 * panel's page the window's focus - opening a task counts only from his own
 * click or key in it (`point.openTask`) - and lands on the row. The press is
 * dispatched in the page itself, since Chromium hands a hidden window's
 * native click to a sandboxed frame unreliably. The page finds the row and
 * presses it in one go: a row that moves to another group is drawn anew
 * there (a queued task's row moves to Working once its crewmate begins),
 * and a press on the row as it was drawn before lands on nothing.
 *
 * A card that folds the side panels puts them out of sight and out of
 * reach, so the press first gives them back with the card's edge tab where
 * it offers one, as his click would; where none does, the Tasks panel stays
 * out of sight and the press fails here rather than land nowhere.
 */
export async function pressRow(page: Page, key: string): Promise<void> {
  const showPanels = page.locator("[data-rail-tab]");
  if ((await showPanels.count()) > 0) {
    await showPanels.first().click();
    await expect(showPanels).toHaveCount(0);
  }
  await expandDock(page, "now");
  const tasks = dockFrameElement(page, "now");
  await expect(tasks).toBeVisible();
  await nowRow(page, key).waitFor({ state: "attached" });
  await tasks.focus();
  const pressed = await nowFrame(page)
    .locator(":root")
    .evaluate((root, selector) => {
      const row = root.querySelector<HTMLElement>(selector);
      row?.click();
      return row !== null;
    }, nowRowSelector(key));
  expect(pressed, `the Tasks row ${key} is drawn to press`).toBe(true);
}

/**
 * Opens a collapsed Tasks group with a press inside its frame, and waits
 * until it is open. A group the panel always shows (`OPEN_BY_DEFAULT` in
 * `src/panels/now/rows.ts`) has a label for a header, with no
 * `aria-expanded` and nothing to press, so it is open already.
 */
export async function openGroup(page: Page, group: NowGroup): Promise<void> {
  const header = nowFrame(page).locator(`[data-now-group-header="${group}"]`);
  await expect(header).toBeAttached();
  if ((await header.getAttribute("aria-expanded")) === null) return;
  // In the frame itself: a press at screen coordinates can land on the list
  // while the group above is still opening and moving this header.
  await header.evaluate((element) => (element as HTMLElement).click());
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

/**
 * Waits until a Tasks row has stopped moving. The panel lets go of a row
 * that moves under a still pointer (`panel.tsx`), so a hover taken while a
 * group is opening or a search is landing would be let go of at once and
 * open nothing.
 */
export async function rowAtRest(page: Page, key: string): Promise<void> {
  await atRest(page, nowRow(page, key));
}

/** Rests the pointer on a Tasks row once the list under it has stopped moving. */
export async function restOnRow(page: Page, key: string): Promise<void> {
  await restOnStill(page, nowRow(page, key));
}

/**
 * Waits until `target` has stopped moving: a card still settling after a
 * resize, like a list still opening, lets go of what moved under a still
 * pointer.
 */
export async function atRest(page: Page, target: Locator): Promise<void> {
  let last = "";
  await expect
    .poll(async () => {
      await nextFrame(page);
      const box = await target.boundingBox();
      const now = box ? [box.x, box.y, box.width, box.height].map(Math.round).join(",") : "";
      const still = now !== "" && now === last;
      last = now;
      return still;
    })
    .toBe(true);
}

/** Rests the pointer on `target` once it has stopped moving. */
export async function restOnStill(page: Page, target: Locator): Promise<void> {
  await atRest(page, target);
  await target.hover();
}

/**
 * Brings a task key into view as it is drawn now. A record draws every key
 * it linked anew with each push (FI3-1279), and an opening record's reads
 * arrive one after another; a scroll holds the key it found until that key
 * is still, and refuses once it is drawn anew (FI3-1303). The scroll then
 * goes to the key drawn in its place; any other refusal stands.
 */
async function keyIntoView(key: Locator): Promise<void> {
  for (;;) {
    const drawn = await key.elementHandle();
    try {
      await drawn.scrollIntoViewIfNeeded();
      return;
    } catch (error) {
      const drawnAnew = await drawn.evaluate((node) => !node.isConnected).catch(() => true);
      if (!drawnAnew) throw error;
    } finally {
      await drawn.dispose();
    }
  }
}

/**
 * Rests the pointer on a task key link the window or a panel drew
 * (FI3-1271) once it is in view and still: a scroll that carries a key lets
 * its summary go, so the key is brought into view before the pointer lands,
 * never by the landing. The pointer only moves there, and it is Chromium's
 * routed pointer (`slidePointer`, `launchApp({ gpuBenchmarking: true })`),
 * which moves no focus, as a real mouse moves none. Playwright's mouse takes
 * the window's focus out of a frame onto the window's own page; the app
 * gives it back to that frame (docs/keyboard.md, "Cards and frames"), the
 * window losing focus to the frame lets the summary go, and a Tasks row the
 * keyboard rests on opens its own.
 */
export async function restOnTaskKey(page: Page, key: Locator): Promise<void> {
  await keyIntoView(key);
  await atRest(page, key);
  const box = await key.boundingBox();
  if (!box) throw new Error("The task key is not on screen");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await slidePointer(page, at, at, 1);
}

/**
 * Rests on a key a card body's or a record's frame linked, the way the
 * bridge hears a pointer arrive: a pointerover in the frame itself, once the
 * key is in view and still. A native hover may first hand the window's
 * focus between pages, and the window losing focus lets a summary go.
 */
export async function restOnFramedKey(page: Page, key: Locator): Promise<void> {
  await keyIntoView(key);
  await atRest(page, key);
  await key.dispatchEvent("pointerover");
}

/** The attribute a panel task's summary names its task by (`point.peekTask`). */
export const POINT_SUMMARY = "data-point-summary";

/**
 * The crew summary a task a panel rests on opens - a Tasks row beside the
 * panel, a task board tile beside its card (FI3-565 piece 3; a panel's
 * `point.peekTask`) - in the window rather than the frame; the summary
 * inside is the same `[data-crew-summary]` a crewmate opens.
 */
export function rowSummary(page: Page): Locator {
  return page.locator(`[${POINT_SUMMARY}]`);
}

/** The actual summary panel, excluding the full-window tie drawing around it. */
export function rowSummaryBody(page: Page): Locator {
  return rowSummary(page).locator("[data-crew-summary]");
}

/**
 * The panel task's summary while it is open: one still fading out after its
 * rest ended is hidden (`aria-hidden`) and is not it, so a new rest's
 * summary is never mistaken for the last one on the same task as it leaves.
 */
export function openRowSummary(page: Page): Locator {
  return page.locator(`[${POINT_SUMMARY}]:not([aria-hidden])`);
}

/** The hairline that ties a panel task's summary to its panel or its card. */
export function rowSummaryTie(page: Page): Locator {
  return rowSummary(page).locator("[data-point-summary-tie]");
}

/**
 * What a collapsed dock says it holds, as the app draws it in its header
 * (`rail.summarize`): its short parts together, and in order.
 */
export function dockSummary(page: Page, dock: DockId): Locator {
  return page.locator(`[data-side-panel="${dock}"] [data-panel-summary]`);
}
/**
 * The line a collapsed dock said in its title's place (`PanelSummaryLine`):
 * a button that opens the dock, the whole line its description.
 */
export function dockSummaryLine(page: Page, dock: DockId): Locator {
  return page.locator(`[data-side-panel="${dock}"] [data-panel-summary-line]`);
}
export function dockSummaryParts(page: Page, dock: DockId): Promise<string[]> {
  return dockSummary(page, dock)
    .locator("[data-panel-summary-part]")
    .evaluateAll((parts) => parts.map((part) => part.textContent ?? ""));
}

/**
 * The same summary a task key in a card body opens beside its card while
 * the pointer rests on the key (FI3-594), in the window.
 */
export function keySummary(page: Page): Locator {
  return page.locator("[data-key-summary]");
}

/**
 * The task keys a card body's or a task record's frame linked, in the order
 * the body writes them - in the whole frame, or in one part of it.
 */
export function linkedTaskKeys(scope: FrameLocator | Locator): Locator {
  return scope.locator("a[data-inf-task]");
}

/**
 * The task keys the window or a panel drew as links (FI3-1271): a thread
 * line, a card's title, the record's Now line, an Activity line, a Settings
 * row - in the window, in one part of it, or in a panel's frame.
 */
export function taskKeyLinks(scope: Page | FrameLocator | Locator): Locator {
  return scope.locator("[data-task-key]");
}

/** The group the row actually paints in, independent of its displayed words. */
export function nowRowGroup(page: Page, key: string): Promise<string | null> {
  return nowRow(page, key).evaluate(
    (row) => row.closest("[data-now-group]")?.getAttribute("data-now-group") ?? null,
  );
}

/**
 * The shown task-record card and its body frame, as selectors a measuring
 * script resolves itself: the shown stack entry's, never a record the stage
 * keeps drawn while it leaves.
 */
export const RECORD_CARD_SELECTOR = `${SHOWN_ENTRY} [data-task-record]`;
export function recordCard(page: Page): Locator {
  return page.locator(RECORD_CARD_SELECTOR);
}
export const RECORD_FRAME_SELECTOR = `${SHOWN_ENTRY} iframe[title="Task record body"]`;

/** The open task-record card's body frame. */
export function recordFrame(page: Page): FrameLocator {
  return drawnFrame(page, RECORD_FRAME_SELECTOR);
}

/**
 * The shown record's body has drawn. The host reveals the record once its
 * own facts are on screen, before this frame draws (FI3-948), and the frame
 * then grows the card. The card holds still only once a press is down, so
 * a press aimed at the record's controls in that gap can go down beside the
 * control. A journey waits here inside the open, not at the press. A record
 * that could not be read never draws this body.
 */
export async function expectRecordBody(page: Page): Promise<void> {
  // INF-1629: the live Use row can place the body below the record's viewport.
  // Chromium cannot paint that frame until it is scrolled into view. Keep an
  // already drawn record's reading position; reveal only its undrawn body.
  const element = frameElement(page, RECORD_FRAME_SELECTOR);
  await expect(element).toBeAttached();
  if ((await element.getAttribute("data-frame-drawn")) === null)
    await element.scrollIntoViewIfNeeded();
  await expect(recordFrame(page).locator("[data-record-content]")).toBeVisible();
}

/**
 * INF-100: after a record section opens, wait for the host to size its
 * unbounded frame before native Tab decides what to scroll into view.
 * Inner visibility alone precedes that cross-frame height acknowledgment.
 */
export async function expectRecordSized(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        recordFrame(page)
          .locator("body")
          .evaluate((body) => innerHeight >= body.getBoundingClientRect().height),
      { message: "the host has sized the opened task record before the next key" },
    )
    .toBe(true);
}

/** A detail fact's value, by stable identity rather than its displayed label. */
export function recordFact(page: Page, fact: RecordFact): Locator {
  return recordFrame(page).locator(`[data-record-fact="${fact}"]`);
}

/**
 * One shared task fact (FI3-565 piece 2) on a surface that shows a task -
 * the crew summary or the task record - by its identity, never its label.
 */
export function taskFact(scope: Locator, fact: TaskFactId): Locator {
  return scope.locator(`[data-task-fact="${fact}"]`);
}

/** The Checks value, excluding the recorded watch schedules and finished age beside it (INF-2359). */
export function taskCheckWords(scope: Locator): Locator {
  return taskFact(scope, "checks").locator("[data-task-fact-checks]");
}

/**
 * Every shared task fact a surface shows, in its order: each identity with
 * its words, the status as its mark reads it, and each age as the time it
 * stands for, so two surfaces read a moment apart still compare equal.
 */
export function shownTaskFacts(scope: Locator): Promise<[string, string][]> {
  return scope.evaluate((root) => {
    const status = root.querySelector("[data-task-mark]")?.getAttribute("aria-label") ?? "";
    const aged = (el: Element) => {
      let text = el.textContent ?? "";
      for (const age of el.querySelectorAll("[data-task-fact-age]"))
        text = text.replace(age.textContent ?? "", ` @${age.getAttribute("datetime")}`);
      return text;
    };
    return [...root.querySelectorAll("[data-task-fact]")].map((el): [string, string] => {
      const id = el.getAttribute("data-task-fact") ?? "";
      if (id === "status") return [id, status];
      if (id !== "now") return [id, aged(el)];
      const age = el.parentElement?.querySelector("[data-task-fact-age]");
      return [id, `${el.textContent} @${age?.getAttribute("datetime") ?? ""}`];
    });
  });
}

/** The control that closes the shown record entry. It does not drop the task. */
export function hideRecord(page: Page): Locator {
  return recordCard(page).getByRole("button", { name: HIDE_RECORD_LABEL, exact: true });
}

/**
 * Every drawing of a task's record on the stage: the shown entry, and the
 * one the stage holds, inert, while the next card gets ready or as it drops
 * away (docs/renderer.md, "Replacement presentation and the prepared
 * successor"). None is left once the record's Hide has finished, so a
 * journey waits until there is none before it goes on.
 */
export function recordDrawings(page: Page, taskId: string): Locator {
  return page.locator(`[data-stage-entry] [data-task-record="${taskId}"]`);
}

/**
 * The shown record's action bar (FI3-565 piece 4; FI3-948 layout B): the end
 * slot at its left edge and the next slot at its right, each holding at most
 * one button, and between them the confirm sentence while Drop task asks.
 */
export function recordBar(page: Page): Locator {
  return recordCard(page).locator("[data-record-footer]");
}

export function recordBarButton(page: Page, slot: "end" | "next"): Locator {
  return recordBar(page).locator(`[data-record-slot="${slot}"]`).getByRole("button");
}

/** What the shown bar draws, in the terms `recordBarOf` reads: null when there is none. */
async function shownBar(page: Page) {
  const bar = recordBar(page);
  if ((await bar.count()) === 0) return null;
  return bar.evaluate((el) => {
    const buttons = (slot: string) =>
      [...el.querySelectorAll(`[data-record-slot="${slot}"] button`)].map(
        (button) => (button as HTMLButtonElement).disabled,
      );
    return {
      state: el.getAttribute("data-record-footer"),
      end: el.getAttribute("data-record-end"),
      next: el.getAttribute("data-record-next"),
      endButtons: buttons("end"),
      nextButtons: buttons("next"),
    };
  });
}

/**
 * The shown record's bar is the one its typed task calls for, through the
 * shared `recordBarOf`: Drop task when the task can be ended, the next step
 * (Start disabled while blocked), and no bar on closed work or on a row with
 * no button. The task and the bar are read together until they agree, so a
 * crewmate that moves on mid-read does not race the check. Returns the
 * reading.
 */
export async function expectRecordBar(page: Page): Promise<RecordBar | null> {
  const id = await recordCard(page).getAttribute("data-task-record");
  if (!id) throw new Error("No shown task record");
  let reading: RecordBar | null = null;
  await expect
    .poll(
      async () => {
        const task = await page.evaluate((id) => window.infinitary.tasks.detail(id), id);
        const bar = recordBarOf(task);
        reading = bar;
        const expected =
          bar && (bar.end || bar.next)
            ? {
                state: "bar",
                end: bar.end ?? "none",
                next: bar.next ?? "none",
                endButtons: bar.end ? [false] : [],
                nextButtons: bar.next ? [bar.next === "start" && bar.blocked] : [],
              }
            : null;
        const shown = await shownBar(page);
        return JSON.stringify(shown) === JSON.stringify(expected)
          ? "agrees"
          : JSON.stringify({ expected, shown });
      },
      { timeout: 15_000 },
    )
    .toBe("agrees");
  return reading;
}

/** One feed row by its text, as the frame paints it. */
export function feedLine(page: Page, text: string | RegExp): Locator {
  return activityFrame(page).locator("[data-feed-row]").getByText(text);
}

/** Activity's newest line: the list's last row, wherever the list or its panel is scrolled. */
export function newestFeedLine(page: Page): Locator {
  return activityFrame(page).locator("[data-feed-row]").last();
}

/**
 * The feed row a task-less event writes, by the words `feedLineFrom` gives
 * it - the feed's own composition, never re-typed.
 */
export function feedLineOf(page: Page, event: FmEvent): Locator {
  const line = feedLineFrom(event);
  if (!line) throw new Error(`A ${event.type} event writes no feed line`);
  return feedLine(page, line.text);
}

/**
 * A task's key by its title, once the board holds it. The title is the
 * spec's own words (what it asked for, or the mock's constant), never the
 * product's, and names one task in the app: a spec that gives two tasks one
 * title reads their keys some other way, since this one cannot tell which
 * of them was meant.
 */
export async function taskKey(page: Page, title: string): Promise<string> {
  const find = () =>
    page.evaluate(
      async (wanted) =>
        (await window.infinitary.tasks.board()).tasks.find((task) => task.title === wanted)?.key ??
        null,
      title,
    );
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  return (await find()) as string;
}

/**
 * A task's feed lines authored from the given timeline events, oldest
 * first, found by what happened and whose it is (`data-feed-event`,
 * `data-feed-key`), never by the line's words: those are `taskFeedLine`'s,
 * which its unit tests own.
 */
export function taskLine(page: Page, key: string, ...events: TaskEventKind[]): Locator {
  return activityFrame(page).locator(
    events
      .map((event) => `[data-feed-row][data-feed-event="${event}"]:has([data-feed-key="${key}"])`)
      .join(", "),
  );
}

/** A task's report lines; the summary words are `reportSummary`'s. */
export function reportLine(page: Page, key: string): Locator {
  return taskLine(page, key, "report");
}

/** A task's started line: the feed's word for its dispatch. */
export function startedLine(page: Page, key: string): Locator {
  return taskLine(page, key, "dispatched");
}

/** A task's lines for its change going in: landed here, or merged where it lives. */
export function putInLine(page: Page, key: string): Locator {
  return taskLine(page, key, "landed", "merged");
}

/** A task's lines for a change of status: stopped, finished, answered, built in place. */
export function statusLine(page: Page, key: string): Locator {
  return taskLine(page, key, "status");
}

/**
 * A task's own notes - a settle's one line (the captain's click, then what
 * became of it) or a card the captain closed - found by what they are and
 * whose they are, never by their words: those are their writers', which
 * their unit tests own (INF-1845).
 */
export function noteLines(page: Page, key: string): Locator {
  return taskLine(page, key, "note");
}

/** The feed's failure lines, task or not, by their kind. */
export function failureLines(page: Page): Locator {
  return activityFrame(page).locator('[data-feed-row][data-feed-kind="danger"]');
}

/** The row renders the shared lifecycle reading, not a second posture/color rule. */
export async function expectTaskMark(page: Page, key: string): Promise<void> {
  const task = await page.evaluate(
    async (key) => (await window.infinitary.tasks.board()).tasks.find((t) => t.key === key),
    key,
  );
  if (!task) throw new Error(`Missing task ${key}`);
  await expect(nowRow(page, key).locator("[data-task-mark]")).toHaveAttribute(
    "data-task-mark",
    taskStatusOf(task).mark,
  );
  // The row's name keeps the status. The preview carries it; the row has no second tooltip.
  await expect(nowRow(page, key)).toHaveAttribute(
    "aria-label",
    new RegExp(taskStatusOf(task).word),
  );
  await expect(nowRow(page, key)).not.toHaveAttribute("title", /.+/);
}

/** Compare the record's mark and relocated waits with their surface-specific owners. */
export async function expectRecordTaskStatus(page: Page): Promise<void> {
  const pane = recordCard(page);
  const id = await pane.getAttribute("data-task-record");
  if (!id) throw new Error("No shown task record");
  const task = await page.evaluate((id) => window.infinitary.tasks.detail(id), id);
  // INF-2362: the record moves owned waits to its attention box, unlike a list row.
  const reading = taskWaitStatus(task, taskStatusOf(task), Date.now());
  await expect(pane.locator("[data-task-mark]")).toHaveAttribute("data-task-mark", reading.mark);
  await expect(pane.locator("[data-task-mark]")).toHaveAttribute(
    "aria-label",
    taskStatusLabel(reading),
  );
  for (const wait of recordAttentionWaits(task)) {
    await expect(recordFrame(page).locator("[data-record-attention]")).toContainText(
      taskWaitText(wait, Date.now()),
    );
  }
}
