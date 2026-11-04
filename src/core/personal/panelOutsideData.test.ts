import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openInMemoryDatabase } from "../storage/db";
import { PanelOutsideData } from "./panelOutsideData";
import { PersonalStore } from "./personalStore";

/**
 * INF-2334 piece 1: a panel that read words of a kind kept only for a while
 * (Google's 30 days) loses the store keys it has not rewritten within those
 * days, and the captain's delete of words from outside empties its store.
 */

const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  let now = 100 * DAY;
  const store = new PersonalStore(openInMemoryDatabase(), () => now);
  const dir = scratchDir("infinitary-panel-outside-");
  const outside = new PanelOutsideData(dir, store);
  return {
    store,
    outside,
    dir,
    at: (day: number) => {
      now = day * DAY;
    },
  };
}

describe("PanelOutsideData", () => {
  it("sweeps only a panel that read a kept kind, by when each key was written", () => {
    const f = fixture();
    f.at(10);
    f.store.set("mail-board", "old", "Lunch with Sam");
    f.store.set("clock", "old", "Tokyo");
    f.at(50);
    f.store.set("mail-board", "fresh", "Dentist on Thursday");
    f.outside.noted("workspace:mail-board", "Google", 50 * DAY);

    // Google keeps 30 days: the cutoff is day 20 when the sweep runs on day 50.
    const removed = f.outside.sweep(new Map([["Google", 20 * DAY]]));
    expect(removed).toBe(1);
    expect(f.store.list("mail-board").map((entry) => entry.key)).toEqual(["fresh"]);
    // A panel that read nothing kept is never swept.
    expect(f.store.list("clock").map((entry) => entry.key)).toEqual(["old"]);
    // A kind with no cutoff this sweep removes nothing.
    expect(f.outside.sweep(new Map())).toBe(0);
    // What a panel read outlives a restart.
    expect(new PanelOutsideData(f.dir, f.store).panels()).toEqual(["workspace:mail-board"]);
  });

  it("empties every panel that read a kept kind when the captain deletes words from outside", () => {
    const f = fixture();
    f.store.set("mail-board", "fresh", "Dentist on Thursday");
    f.store.set("clock", "zone", "Tokyo");
    f.outside.noted("installed:mail-board", "Google", 1);
    expect(f.outside.deleteAll()).toBe(1);
    expect(f.store.list("mail-board")).toEqual([]);
    expect(f.store.list("clock")).toHaveLength(1);
    expect(f.outside.panels()).toEqual([]);
  });
});
