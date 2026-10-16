import { describe, expect, it } from "vitest";
import { type NavGroup, nowNavItems, nowNavMove, rovingKey } from "./nav";

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
      "row:waiting:w1",
      "row:working:u1",
      "row:working:u2",
      "group:backlog",
      "group:landed",
      "row:landed:l1",
    ]);
  });

  it("keep one Tab stop: the last one focus was on while it is listed, or else the first", () => {
    expect(rovingKey(ITEMS, "row:working:u2")).toBe("row:working:u2");
    expect(rovingKey(ITEMS, "row:backlog:c1")).toBe("row:waiting:w1");
    expect(rovingKey(ITEMS, null)).toBe("row:waiting:w1");
    expect(rovingKey([], null)).toBeNull();
  });
});

describe("a key in the Tasks list", () => {
  it("moves down and up one stop and stops at the ends", () => {
    expect(nowNavMove(ITEMS, "row:working:u1", "ArrowDown")).toEqual({
      focus: "row:working:u2",
    });
    expect(nowNavMove(ITEMS, "row:working:u1", "ArrowUp")).toEqual({ focus: "row:waiting:w1" });
    expect(nowNavMove(ITEMS, "row:waiting:w1", "ArrowUp")).toBeNull();
    expect(nowNavMove(ITEMS, "row:landed:l1", "ArrowDown")).toBeNull();
  });

  it("goes to the first and the last stop with Home and End", () => {
    expect(nowNavMove(ITEMS, "group:backlog", "Home")).toEqual({ focus: "row:waiting:w1" });
    expect(nowNavMove(ITEMS, "row:waiting:w1", "End")).toEqual({ focus: "row:landed:l1" });
    expect(nowNavMove(ITEMS, "row:landed:l1", "End")).toBeNull();
  });

  it("opens a closed group with →, then steps into it, and closes an open one with ←", () => {
    expect(nowNavMove(ITEMS, "group:backlog", "ArrowRight")).toEqual({ toggle: "backlog" });
    expect(nowNavMove(ITEMS, "group:landed", "ArrowRight")).toEqual({ focus: "row:landed:l1" });
    expect(nowNavMove(ITEMS, "group:landed", "ArrowLeft")).toEqual({ toggle: "landed" });
    expect(nowNavMove(ITEMS, "group:backlog", "ArrowLeft")).toBeNull();
  });

  it("goes up from a row to its group's header with ←, where the group has one", () => {
    expect(nowNavMove(ITEMS, "row:landed:l1", "ArrowLeft")).toEqual({ focus: "group:landed" });
    expect(nowNavMove(ITEMS, "row:working:u1", "ArrowLeft")).toBeNull();
    expect(nowNavMove(ITEMS, "row:working:u1", "ArrowRight")).toBeNull();
  });

  it("leaves every other key, and a stop the list no longer has, to the browser", () => {
    expect(nowNavMove(ITEMS, "row:working:u1", "Enter")).toBeNull();
    expect(nowNavMove(ITEMS, "row:working:u1", "a")).toBeNull();
    expect(nowNavMove(ITEMS, "row:gone:x", "ArrowDown")).toBeNull();
  });
});
