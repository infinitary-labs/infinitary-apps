import type { TaskBrowserFact } from "@shared/taskBrowser";
import { describe, expect, it } from "vitest";
import {
  hasCrewmateTab,
  NO_TAB_FACTS,
  shownTabIndex,
  steppedTab,
  type TaskTab,
  type TaskTabsHandle,
  tabKindOf,
  tabTargetOf,
  taskTabFactsOf,
  taskTabsOf,
} from "./taskTabs";

const crewmate = { ...NO_TAB_FACTS, crewmate: true };

const identity = { session: "run-1", generation: 1 };
const open = (
  over: Partial<Extract<TaskBrowserFact, { state: "open" }>> = {},
): TaskBrowserFact => ({
  state: "open",
  site: "localhost:5173",
  url: "http://localhost:5173/settings",
  title: "Settings",
  ...identity,
  ...over,
});
const stopped: TaskBrowserFact = {
  state: "stopped",
  site: "localhost:5173",
  url: "http://localhost:5173/",
  stopped: "captain",
  at: 1,
  ...identity,
};

describe("the task card's tabs", () => {
  it("draws none while the task has no browser", () => {
    expect(taskTabsOf(undefined)).toEqual([]);
  });

  it("reads Info, then Browser and the page's title, never the site", () => {
    expect(taskTabsOf(open()).map((tab) => tab.label)).toEqual(["Info", "Browser · Settings"]);
    expect(taskTabsOf(open({ title: "" })).map((tab) => tab.label)).toEqual(["Info", "Browser"]);
  });

  it("gives each page of a browser that holds two its own Browser tab", () => {
    const fact = open({
      page: 2,
      pages: [
        { site: "localhost:5173", title: "Settings" },
        { site: "localhost:5173", title: "Theme preview" },
      ],
    });
    const tabs = taskTabsOf(fact);
    expect(tabs.map((tab) => tab.label)).toEqual([
      "Info",
      "Browser · Settings",
      "Browser · Theme preview",
    ]);
    expect(shownTabIndex(tabs, "browser", fact)).toBe(2);
    expect(shownTabIndex(tabs, "info", fact)).toBe(0);
  });

  it("adds Crewmate after Info once a crewmate has run the task, with or without a browser", () => {
    expect(taskTabsOf(undefined, crewmate).map((tab) => tab.label)).toEqual(["Info", "Crewmate"]);
    const tabs = taskTabsOf(open(), crewmate);
    expect(tabs.map((tab) => tab.label)).toEqual(["Info", "Crewmate", "Browser · Settings"]);
    expect(shownTabIndex(tabs, "crewmate", open())).toBe(1);
    expect(shownTabIndex(tabs, "browser", open())).toBe(2);
    expect(hasCrewmateTab({ startedAt: null })).toBe(false);
    expect(hasCrewmateTab({ startedAt: 1 })).toBe(true);
  });

  // INF-2261, the captain's picks: "Info, Cards, Activity, Crewmate, then
  // Browser" and "Cards shows how many, Activity none".
  it("orders Info, Cards with its count, Activity, Crewmate, then Browser, each once it has something", () => {
    const all = { crewmate: true, cards: 2, activity: true };
    const tabs = taskTabsOf(open(), all);
    expect(tabs.map((tab) => tab.kind)).toEqual([
      "info",
      "cards",
      "activity",
      "crewmate",
      "browser",
    ]);
    expect(tabs[1]).toEqual({ kind: "cards", label: "Cards", count: 2 });
    expect(tabs[2]).toEqual({ kind: "activity", label: "Activity" });
    expect(shownTabIndex(tabs, "activity", open())).toBe(2);
    expect(
      taskTabsOf(undefined, { ...NO_TAB_FACTS, activity: true }).map((tab) => tab.kind),
    ).toEqual(["info", "activity"]);
    expect(
      taskTabFactsOf({ startedAt: null, cards: [], activityLog: [], timeline: undefined }),
    ).toEqual(NO_TAB_FACTS);
  });

  it("keeps a Browser tab for a stopped browser, which says so as the view does", () => {
    const tabs = taskTabsOf(stopped);
    expect(tabs.map((tab) => tab.label)).toEqual(["Info", "Browser"]);
    expect(shownTabIndex(tabs, "browser", stopped)).toBe(1);
  });

  it("steps to the next enabled tab, wrapping, and skips one that is not the viewer's to pick", () => {
    const tabs: TaskTab[] = [
      { kind: "info", label: "Info" },
      { kind: "browser", label: "Browser · A", page: 1 },
      { kind: "browser", label: "Browser · B", page: 2 },
    ];
    const watching = (tab: TaskTab) => tab.kind !== "browser" || tab.page === 2;
    expect(steppedTab(tabs, 0, 1, watching)).toBe(2);
    expect(steppedTab(tabs, 2, 1, watching)).toBe(0);
    expect(steppedTab(tabs, 0, -1, watching)).toBe(2);
    expect(steppedTab(tabs, 0, 1, (tab) => tab.kind === "info")).toBeNull();
  });
});

describe("the tab commands", () => {
  const tabs = taskTabsOf(open());
  const handle = (selected: number): TaskTabsHandle => ({
    taskId: "t1",
    shown: "info",
    tabs,
    selected,
    enabled: () => true,
    go: () => {},
  });

  it("show a tab only when it is not the one shown", () => {
    expect(tabTargetOf("cards.show-browser", handle(0))).toBe(1);
    expect(tabTargetOf("cards.show-browser", handle(1))).toBeNull();
    expect(tabTargetOf("cards.show-info", handle(1))).toBe(0);
    expect(tabTargetOf("cards.show-info", handle(0))).toBeNull();
  });

  it("show the Crewmate tab, and refuse one the card does not have", () => {
    const three = taskTabsOf(open(), crewmate);
    const on = (selected: number): TaskTabsHandle => ({ ...handle(selected), tabs: three });
    expect(tabTargetOf("cards.show-crewmate", on(0))).toBe(1);
    expect(tabTargetOf("cards.show-crewmate", on(1))).toBeNull();
    expect(tabTargetOf("cards.next-tab", on(1))).toBe(2);
    expect(tabTargetOf("cards.show-crewmate", handle(0))).toBeNull();
    expect(tabKindOf("cards.show-crewmate")).toBe("crewmate");
    expect(tabKindOf("cards.next-tab")).toBeNull();
  });

  it("show the Cards and Activity tabs, and refuse them where the card has none", () => {
    const all = taskTabsOf(open(), { crewmate: true, cards: 1, activity: true });
    const on = (selected: number): TaskTabsHandle => ({ ...handle(selected), tabs: all });
    expect(tabTargetOf("cards.show-cards", on(0))).toBe(1);
    expect(tabTargetOf("cards.show-activity", on(0))).toBe(2);
    expect(tabTargetOf("cards.show-activity", on(2))).toBeNull();
    expect(tabTargetOf("cards.show-cards", handle(0))).toBeNull();
    expect(tabKindOf("cards.show-cards")).toBe("cards");
    expect(tabKindOf("cards.show-activity")).toBe("activity");
  });

  it("move to the next and previous tab, wrapping", () => {
    expect(tabTargetOf("cards.next-tab", handle(0))).toBe(1);
    expect(tabTargetOf("cards.next-tab", handle(1))).toBe(0);
    expect(tabTargetOf("cards.previous-tab", handle(0))).toBe(1);
  });
});
