import type { TaskBrowserFact } from "@shared/taskBrowser";
import { useEffect, useMemo, useRef } from "react";
import { available } from "../app/focusRecovery";
import { focusWithRing } from "../design/focus";
import { useStageRole } from "./SurfaceReveal";
import {
  goToTab,
  lendTaskTabs,
  type ShownTab,
  shownTabIndex,
  type TaskTab,
  tabFocusAsked,
  tabFocusDone,
  taskTabsOf,
} from "./taskTabs";

/** The strip's height, which the browser view takes out of its page's room. */
export const TAB_STRIP_HEIGHT = 32;

/**
 * The tab strip under a task card's title (docs/task-card-tabs.md): Info,
 * Crewmate once a crewmate has run the task, then a Browser tab for each
 * page the task's browser holds. One tablist and one Tab stop; the arrows
 * move focus between tabs and Enter or Space picks the focused one. A task
 * with nothing but Info draws nothing.
 *
 * Picking Info shows the record, Crewmate the crewmate's session and
 * Browser the browser view, which replace each other on the stage as one
 * entry per task. Another page than the browser's current one is the
 * controller's to pick, as navigation is: it does nothing while the captain
 * only watches.
 */
export function TaskTabStrip({
  taskId,
  shown,
  browser,
  crewmate,
  captain,
}: {
  taskId: string;
  shown: ShownTab;
  browser: TaskBrowserFact | undefined;
  /** A crewmate has run the task: it has a Crewmate tab (`hasCrewmateTab`). */
  crewmate: boolean;
  /** The captain holds the browser: he may pick another page. */
  captain: boolean;
}) {
  const role = useStageRole();
  const tabs = useMemo(() => taskTabsOf(browser, crewmate), [browser, crewmate]);
  const selected = shownTabIndex(tabs, shown, browser);
  const current = browser?.state === "open" ? (browser.page ?? 1) : 1;
  const enabled = (tab: TaskTab) => tab.kind !== "browser" || tab.page === current || captain;
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
    // biome-ignore lint/a11y/useSemanticElements: a tablist is the pattern; the arrows are its keys.
    <div
      ref={list}
      role="tablist"
      aria-label="Task card"
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
        const disabled = !enabled(tab);
        return (
          <button
            key={tab.kind === "browser" ? `browser-${tab.page}` : tab.kind}
            type="button"
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            disabled={disabled}
            title={tab.label}
            data-task-tab={tab.kind}
            data-browser-page-tab={tab.kind === "browser" ? tab.page : undefined}
            // A click with no pointer (Enter, Space) is a key's.
            onClick={(event) => go(index, event.detail === 0)}
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
              cursor: disabled || isSelected ? "default" : "pointer",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
