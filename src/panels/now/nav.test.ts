import { describe, expect, it } from "vitest";
import { groupNavKey, type NavGroup, nowNavItems, nowNavMove, rovingKey, rowNavKey } from "./nav";

/**
 * The Tasks list's keys (docs/keyboard.md, "Lists and Settings"): one Tab
 * stop, and the arrows move through rows and the headers that open and
 * close, the way a tree of groups moves.
 */

const GROUPS: NavGroup[] = [
  { group: "waiting", open: true, collapsible: false, taskIds: ["w1"] },
  { group: "working", open: true, collapsible: false, taskIds: ["u1", "u2"] },
  { group: "backlog", open: false, collapsible: true, taskIds: ["c1", "c2"] },
  { group: "landed", open: true, collapsible: true, taskIds: ["l1"] },
];
const ITEMS = nowNavItems(GROUPS);
const keys = ITEMS.map((item) => item.key);

describe("the Tasks list's stops", () => {
  it("are the rows of open groups and the headers that open and close, in the order painted", () => {
    expect(keys).toEqual([
      rowNavKey("w1"),
      rowNavKey("u1"),
      rowNavKey("u2"),
      groupNavKey("backlog"),
      groupNavKey("landed"),
      rowNavKey("l1"),
    ]);
  });

  it("keep one Tab stop: the last one focus was on while it is listed, or else the first", () => {
    expect(rovingKey(ITEMS, rowNavKey("u2"))).toBe(rowNavKey("u2"));
    expect(rovingKey(ITEMS, rowNavKey("gone"))).toBe(rowNavKey("w1"));
    expect(rovingKey(ITEMS, null)).toBe(rowNavKey("w1"));
    expect(rovingKey([], null)).toBeNull();
  });

  // INF-902: the task a row stands for moves to another group as its
  // crewmate begins, finishes or puts up a card, under the keyboard's rest.
  it("stay with a task that moves to another group: its row there, or the header of the closed group it moved into", () => {
    const queued: NavGroup = { group: "queued", open: true, collapsible: false, taskIds: ["q1"] };
    const resting = rowNavKey("q1");
    expect(rovingKey(nowNavItems([GROUPS[1] as NavGroup, queued]), resting)).toBe(resting);
    const started = nowNavItems([{ ...(GROUPS[1] as NavGroup), taskIds: ["u1", "q1", "u2"] }]);
    expect(rovingKey(started, resting)).toBe(resting);
    const finished = nowNavItems([
      GROUPS[1] as NavGroup,
      { group: "landed", open: false, collapsible: true, taskIds: ["l1", "q1"] },
    ]);
    expect(rovingKey(finished, resting)).toBe(groupNavKey("landed"));
    expect(rovingKey(ITEMS, rowNavKey("c1"))).toBe(groupNavKey("backlog"));
  });
});

describe("a key in the Tasks list", () => {
  it("moves down and up one stop and stops at the ends", () => {
    expect(nowNavMove(ITEMS, rowNavKey("u1"), "ArrowDown")).toEqual({
      focus: rowNavKey("u2"),
    });
    expect(nowNavMove(ITEMS, rowNavKey("u1"), "ArrowUp")).toEqual({ focus: rowNavKey("w1") });
    expect(nowNavMove(ITEMS, rowNavKey("w1"), "ArrowUp")).toBeNull();
    expect(nowNavMove(ITEMS, rowNavKey("l1"), "ArrowDown")).toBeNull();
  });

  it("goes to the first and the last stop with Home and End", () => {
    expect(nowNavMove(ITEMS, groupNavKey("backlog"), "Home")).toEqual({ focus: rowNavKey("w1") });
    expect(nowNavMove(ITEMS, rowNavKey("w1"), "End")).toEqual({ focus: rowNavKey("l1") });
    expect(nowNavMove(ITEMS, rowNavKey("l1"), "End")).toBeNull();
  });

  it("opens a closed group with →, then steps into it, and closes an open one with ←", () => {
    expect(nowNavMove(ITEMS, groupNavKey("backlog"), "ArrowRight")).toEqual({ toggle: "backlog" });
    expect(nowNavMove(ITEMS, groupNavKey("landed"), "ArrowRight")).toEqual({
      focus: rowNavKey("l1"),
    });
    expect(nowNavMove(ITEMS, groupNavKey("landed"), "ArrowLeft")).toEqual({ toggle: "landed" });
    expect(nowNavMove(ITEMS, groupNavKey("backlog"), "ArrowLeft")).toBeNull();
  });

  it("goes up from a row to its group's header with ←, where the group has one", () => {
    expect(nowNavMove(ITEMS, rowNavKey("l1"), "ArrowLeft")).toEqual({
      focus: groupNavKey("landed"),
    });
    expect(nowNavMove(ITEMS, rowNavKey("u1"), "ArrowLeft")).toBeNull();
    expect(nowNavMove(ITEMS, rowNavKey("u1"), "ArrowRight")).toBeNull();
  });

  it("leaves every other key, and a stop the list no longer has, to the browser", () => {
    expect(nowNavMove(ITEMS, rowNavKey("u1"), "Enter")).toBeNull();
    expect(nowNavMove(ITEMS, rowNavKey("u1"), "a")).toBeNull();
    expect(nowNavMove(ITEMS, rowNavKey("x"), "ArrowDown")).toBeNull();
  });
});
