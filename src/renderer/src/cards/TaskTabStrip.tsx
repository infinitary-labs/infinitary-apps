import * as m from "@shared/i18n/messages.generated";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import { useEffect, useMemo, useRef } from "react";
import { available } from "../app/focusRecovery";
import { useCommandKeys } from "../app/keyHints";
import { useRestLabel } from "../design";
import { focusWithRing } from "../design/focus";
import { useStageRole } from "./SurfaceReveal";
import {
  goToTab,
  lendTaskTabs,
  type ShownTab,
  shownTabIndex,
  type TabCommand,
  type TaskTab,
  type TaskTabFacts,
  tabFocusAsked,
  tabFocusDone,
  taskTabsOf,
} from "./taskTabs";

/** The strip's height, which the browser view takes out of its page's room. */
export const TAB_STRIP_HEIGHT = 32;

/**
 * The tab strip under a task card's title (docs/task-card-tabs.md; INF-2261):
 * Info, Cards with how many once the task showed one, Activity once it has a
 * line, Crewmate once a crewmate has run the task, then a Browser tab for
 * each page the task's browser holds. One tablist and one Tab stop; the
 * arrows move focus between tabs and Enter or Space picks the focused one. A
 * task with nothing but Info draws nothing.
 *
 * Info, Cards and Activity are the record's three views; Crewmate shows the
 * crewmate's session and Browser the browser view, which replace each other
 * on the stage as one entry per task. Another page than the browser's current one is the
 * controller's to pick, as navigation is: it does nothing while the captain
 * only watches, and is marked off with the reason while changes on the first
 * mate's computer are off (docs/view.md).
 */
export function TaskTabStrip({
  taskId,
  shown,
  browser,
  facts,
  captain,
  pagesOff = null,
}: {
  taskId: string;
  shown: ShownTab;
  browser: TaskBrowserFact | undefined;
  /** What decides the task's other tabs (`taskTabFactsOf`). */
  facts: TaskTabFacts;
  /** The captain holds the browser: they may pick another page. */
  captain: boolean;
  /** Why the captain cannot pick another page right now: changes there are off. */
  pagesOff?: string | null;
}) {
  const role = useStageRole();
  const { crewmate, cards, activity } = facts;
  const tabs = useMemo(
    () => taskTabsOf(browser, { crewmate, cards, activity }),
    [browser, crewmate, cards, activity],
  );
  const selected = shownTabIndex(tabs, shown, browser);
  const current = browser?.state === "open" ? (browser.page ?? 1) : 1;
  const enabled = (tab: TaskTab) =>
    tab.kind !== "browser" || tab.page === current || (captain && pagesOff === null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const list = useRef<HTMLDivElement>(null);

  const go = (index: number, byKey: boolean) => {
    const tab = tabs[index];
    if (!tab || index === selected || !enabledRef.current(tab)) return;
    goToTab(taskId, tab, shown, byKey);
  };
  const goRef = useRef(go);
  goRef.current = go;

  const present = tabs.length > 0;
  useEffect(() => {
    if (!present) return;
    return lendTaskTabs({
      taskId,
      shown,
      tabs,
      selected,
      enabled: (tab) => enabledRef.current(tab),
      go: (index) => goRef.current(index, true),
    });
  }, [present, taskId, shown, tabs, selected]);

  // A key chose this tab on the strip the swap replaced: focus follows it,
  // once the stage shows this strip.
  useEffect(() => {
    if (!present || role !== "shown" || !tabFocusAsked()) return;
    let frame = 0;
    let frames = 0;
    const take = () => {
      if (!tabFocusAsked()) return;
      // Command search opened since: its field keeps the focus.
      if (document.activeElement?.closest('[role="dialog"]')) {
        tabFocusDone();
        return;
      }
      const node = list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const shown = list.current?.closest("[data-stage-entry]")?.getAttribute("data-stage-entry");
      if (node && shown === "shown" && available(node)) {
        focusWithRing(node);
        tabFocusDone();
        return;
      }
      if (++frames < 90) frame = requestAnimationFrame(take);
    };
    take();
    return () => cancelAnimationFrame(frame);
  }, [present, role]);

  if (!present) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const nodes = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [],
    );
    const at = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? nodes.length - 1
          : (at + (event.key === "ArrowRight" ? 1 : -1) + nodes.length) % nodes.length;
    nodes[to]?.focus();
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={m.cardTabStripLabel()}
      data-task-tabs=""
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: "var(--space-1)",
        height: TAB_STRIP_HEIGHT,
        boxSizing: "border-box",
        padding: "0 var(--space-3)",
        borderBottom: "1px solid var(--line-1)",
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      {tabs.map((tab, index) => {
        const isSelected = index === selected;
        // Another page the captain could pick but for changes being off:
        // marked off with the reason, still reached by the arrows.
        const off = captain && pagesOff !== null && !enabled(tab) ? pagesOff : null;
        const disabled = !enabled(tab) && off === null;
        return (
          <StripTab
            key={tab.kind === "browser" ? `browser-${tab.page}` : tab.kind}
            tab={tab}
            command={
              tab.kind === "browser" && tabs.findIndex((t) => t.kind === "browser") !== index
                ? null
                : TAB_SHOW_COMMANDS[tab.kind]
            }
            isSelected={isSelected}
            disabled={disabled}
            off={off}
            onGo={(byKey) => go(index, byKey)}
          />
        );
      })}
    </div>
  );
}

/** The command that shows each tab, whose key its label names (docs/keyboard.md, "Key hints"). */
const TAB_SHOW_COMMANDS: Record<TaskTab["kind"], TabCommand> = {
  info: "cards.show-info",
  cards: "cards.show-cards",
  activity: "cards.show-activity",
  crewmate: "cards.show-crewmate",
  browser: "cards.show-browser",
};

/**
 * One tab: its words, and the key of the command that shows it, in the
 * app's label on rest (the browser's own title is never a tooltip). Show
 * Browser goes to the first page's tab, so only that tab names its key.
 */
function StripTab({
  tab,
  command,
  isSelected,
  disabled,
  off,
  onGo,
}: {
  tab: TaskTab;
  command: TabCommand | null;
  isSelected: boolean;
  disabled: boolean;
  /** Why it cannot be picked right now: shown on rest, and its description. */
  off: string | null;
  onGo: (byKey: boolean) => void;
}) {
  const { keys, "aria-keyshortcuts": ariaKeys } = useCommandKeys(command);
  const named = tab.kind === "cards" ? `${tab.label} ${tab.count}` : tab.label;
  const rest = useRestLabel(off ? `${named} · ${off}` : named, { keys });
  return (
    <button
      {...rest}
      type="button"
      role="tab"
      aria-selected={isSelected}
      aria-keyshortcuts={ariaKeys}
      tabIndex={isSelected ? 0 : -1}
      disabled={disabled}
      aria-disabled={off ? true : undefined}
      aria-description={off ?? undefined}
      data-task-tab={tab.kind}
      data-browser-page-tab={tab.kind === "browser" ? tab.page : undefined}
      // A click with no pointer (Enter, Space) is a key's.
      onClick={(event) => onGo(event.detail === 0)}
      style={{
        maxWidth: "45%",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: "var(--space-1) var(--space-2)",
        marginBottom: -1,
        border: 0,
        borderBottom: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
        background: "transparent",
        fontFamily: "inherit",
        fontSize: "var(--text-sm)",
        fontWeight: 400,
        color: isSelected ? "var(--fg-1)" : "var(--fg-3)",
        cursor: disabled || off || isSelected ? "default" : "pointer",
        opacity: off ? 0.4 : undefined,
      }}
    >
      {tab.label}
      {tab.kind === "cards" && (
        <span
          data-task-tab-count=""
          style={{
            marginInlineStart: "var(--space-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
          }}
        >
          {tab.count}
        </span>
      )}
    </button>
  );
}
