import { CREWMATE_TAB_LABEL } from "@shared/crewTranscript";
import { browserTabLabel, INFO_TAB_LABEL, type TaskBrowserFact } from "@shared/taskBrowser";
import type { TaskView } from "@shared/tasks";
import { taskEntryFrom, useShellStore } from "../app/store";

/**
 * The tabs of a task's card (docs/task-card-tabs.md): Info first, then
 * Crewmate once a crewmate has run it, then one Browser tab per page the
 * task's browser holds, each reading Browser and the page's title. A task
 * with neither has no tabs to switch between.
 */
export type TaskTab =
  | { kind: "info"; label: typeof INFO_TAB_LABEL }
  | { kind: "crewmate"; label: typeof CREWMATE_TAB_LABEL }
  | { kind: "browser"; label: string; page: number };

/** Which of a task's tabs is the one on the stage. */
export type ShownTab = TaskTab["kind"];

export const INFO_TAB: TaskTab = { kind: "info", label: INFO_TAB_LABEL };
export const CREWMATE_TAB: TaskTab = { kind: "crewmate", label: CREWMATE_TAB_LABEL };

/** Whether a task has a Crewmate tab: a crewmate has started on it, so it has a session to read. */
export const hasCrewmateTab = (task: Pick<TaskView, "startedAt">): boolean =>
  task.startedAt !== null;

/** The tabs a task's card draws, or none while it has nothing but Info to show. */
export function taskTabsOf(
  browser: TaskBrowserFact | undefined | null,
  crewmate = false,
): TaskTab[] {
  const head = crewmate ? [INFO_TAB, CREWMATE_TAB] : [INFO_TAB];
  if (!browser) return crewmate ? head : [];
  if (browser.state === "stopped") return [...head, { kind: "browser", label: "Browser", page: 1 }];
  const pages = browser.pages && browser.pages.length > 1 ? browser.pages : null;
  if (!pages) return [...head, { kind: "browser", label: browserTabLabel(browser.title), page: 1 }];
  return [
    ...head,
    ...pages.map(
      (page, index): TaskTab => ({
        kind: "browser",
        label: browserTabLabel(page.title),
        page: index + 1,
      }),
    ),
  ];
}

/** The index of the tab shown: Info, Crewmate, or the Browser tab of the browser's current page. */
export function shownTabIndex(
  tabs: readonly TaskTab[],
  shown: ShownTab,
  browser: TaskBrowserFact | undefined | null,
): number {
  if (shown !== "browser")
    return Math.max(
      0,
      tabs.findIndex((tab) => tab.kind === shown),
    );
  const page = browser?.state === "open" ? (browser.page ?? 1) : 1;
  const at = tabs.findIndex((tab) => tab.kind === "browser" && tab.page === page);
  if (at >= 0) return at;
  return Math.max(
    0,
    tabs.findIndex((tab) => tab.kind === "browser"),
  );
}

/**
 * The enabled tab `step` places from `from`, wrapping, or null with nowhere
 * to go. A tab that is not `enabled` is skipped.
 */
export function steppedTab(
  tabs: readonly TaskTab[],
  from: number,
  step: 1 | -1,
  enabled: (tab: TaskTab) => boolean,
): number | null {
  for (let n = 1; n < tabs.length; n++) {
    const at = (((from + step * n) % tabs.length) + tabs.length) % tabs.length;
    const tab = tabs[at];
    if (tab && enabled(tab)) return at;
  }
  return null;
}

/**
 * What the shown task card lends the window's commands while its strip is
 * mounted: the way to a tab, by place.
 */
export type TaskTabsHandle = {
  taskId: string;
  /** The tab whose view draws this strip. */
  shown: ShownTab;
  tabs: readonly TaskTab[];
  selected: number;
  enabled: (tab: TaskTab) => boolean;
  go: (index: number) => void;
};

/** Every strip a task's views have mounted, by the tab whose view draws it: the outgoing view's is still there during a swap. */
const lent = new Map<string, Map<ShownTab, TaskTabsHandle>>();
/** The newest strip a task lent, kept a moment after its view leaves. */
const recent = new Map<string, { handle: TaskTabsHandle; at: number }>();
/** How long a strip that left still tells the task's tabs, while the shown view's own read answers. */
const RECENT_MS = 3000;
/** How long a key's choice of a tab waits for the strip the swap draws to be shown. */
const TAB_FOCUS_MS = 1500;
/** When a key chose the tab, so the strip the swap draws takes focus with its ring; 0 for none. */
let focusTabUntil = 0;

export function lendTaskTabs(handle: TaskTabsHandle): () => void {
  const strips = lent.get(handle.taskId) ?? new Map<ShownTab, TaskTabsHandle>();
  strips.set(handle.shown, handle);
  lent.set(handle.taskId, strips);
  recent.set(handle.taskId, { handle, at: performance.now() });
  return () => {
    if (strips.get(handle.shown) === handle) strips.delete(handle.shown);
    if (strips.size === 0) lent.delete(handle.taskId);
    const last = recent.get(handle.taskId);
    if (last?.handle === handle) last.at = performance.now();
  };
}

/** The strip a task's views lent most recently, or none. */
export const lentTaskTabs = (taskId: string): TaskTabsHandle | undefined => {
  const strips = lent.get(taskId);
  if (!strips) return undefined;
  const newest = recent.get(taskId)?.handle;
  return newest && strips.get(newest.shown) === newest ? newest : [...strips.values()].pop();
};

/**
 * The tabs a command acts on for the card `shown` of `taskId`: that view's
 * own strip, or, while it has not drawn one yet (its read has not answered),
 * the task's tabs from another view's strip, with the place and the way to a
 * tab worked out from the shown view. A strip of an outgoing view never
 * speaks for the shown one.
 */
export function shownTaskTabs(taskId: string, shown: ShownTab): TaskTabsHandle | undefined {
  const own = lent.get(taskId)?.get(shown);
  if (own) return own;
  const last = recent.get(taskId);
  const other =
    lentTaskTabs(taskId) ??
    (last && performance.now() - last.at < RECENT_MS ? last.handle : undefined);
  if (!other) return undefined;
  const first = other.tabs.findIndex((tab) => tab.kind === shown);
  return {
    ...other,
    shown,
    selected: Math.max(0, first),
    go: (index) => {
      const tab = other.tabs[index];
      if (!tab || index === first || !other.enabled(tab)) return;
      goToTab(taskId, tab, shown, true);
    },
  };
}

/**
 * Shows `tab` of a task from the view `shown`; a key's choice has the strip
 * the swap draws take focus. The task's entry keeps the card it was opened
 * from, so Hide on the next tab still returns to that card.
 */
export function goToTab(taskId: string, tab: TaskTab, shown: ShownTab, byKey: boolean): void {
  const shell = useShellStore.getState();
  const from = taskEntryFrom(shell, taskId);
  if (byKey && tab.kind !== shown) askTabFocus();
  if (tab.kind === "info") shell.openRecord(taskId, from);
  else if (tab.kind === "crewmate") shell.openCrewmateView(taskId, from);
  else if (shown !== "browser") shell.openBrowserView(taskId, from);
  else void window.infinitary.browser.input(taskId, { kind: "page", page: tab.page });
}

export function askTabFocus(): void {
  focusTabUntil = performance.now() + TAB_FOCUS_MS;
}

/** Whether a key's choice of a tab still waits for a strip to take focus. */
export const tabFocusAsked = (): boolean => performance.now() < focusTabUntil;

/** A strip took the focus a key asked for. */
export function tabFocusDone(): void {
  focusTabUntil = 0;
}

/** The tab commands, which act on the shown task card's strip. */
export type TabCommand =
  | "cards.show-info"
  | "cards.show-crewmate"
  | "cards.show-browser"
  | "cards.next-tab"
  | "cards.previous-tab";

/** The tab a Show command names; null for Next tab and Previous tab. */
export function tabKindOf(command: TabCommand): ShownTab | null {
  if (command === "cards.show-info") return "info";
  if (command === "cards.show-crewmate") return "crewmate";
  if (command === "cards.show-browser") return "browser";
  return null;
}

/** Where a tab command goes on `handle`'s strip, or null when it has nowhere to go. */
export function tabTargetOf(command: TabCommand, handle: TaskTabsHandle): number | null {
  const { tabs, selected, enabled } = handle;
  if (command === "cards.next-tab") return steppedTab(tabs, selected, 1, enabled);
  if (command === "cards.previous-tab") return steppedTab(tabs, selected, -1, enabled);
  const wanted = tabKindOf(command);
  const shown = tabs[selected];
  if (shown?.kind === wanted) return null;
  const at = tabs.findIndex((tab) => tab.kind === wanted && enabled(tab));
  return at < 0 ? null : at;
}

/** The task whose card is the entry `entry`: its record, browser view or Crewmate tab. */
export const tabTaskOf = (entry: {
  recordTaskId?: string | undefined;
  browserTaskId?: string | undefined;
  crewmateTaskId?: string | undefined;
}): string | undefined => entry.recordTaskId ?? entry.browserTaskId ?? entry.crewmateTaskId;

/** Which tab the entry `entry` is: the record, the browser view or the Crewmate tab. */
export const tabShownOf = (entry: {
  recordTaskId?: string | undefined;
  browserTaskId?: string | undefined;
  crewmateTaskId?: string | undefined;
}): ShownTab | undefined =>
  entry.recordTaskId
    ? "info"
    : entry.browserTaskId
      ? "browser"
      : entry.crewmateTaskId
        ? "crewmate"
        : undefined;
