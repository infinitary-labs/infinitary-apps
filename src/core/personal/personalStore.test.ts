import {
  PERSONAL_STORE_MAX_BYTES,
  PERSONAL_STORE_VALUE_MAX_BYTES,
} from "@shared/personal/manifest";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { PersonalStore, PersonalStoreError } from "./personalStore";

function store(): { store: PersonalStore; changes: string[] } {
  const changes: string[] = [];
  const s = new PersonalStore(openInMemoryDatabase(), () => 1_000);
  s.subscribe((id, key) => changes.push(`${id}:${key}`));
  return { store: s, changes };
}

describe("PersonalStore", () => {
  it("keeps JSON values per extension slice and lists by prefix in key order", () => {
    const { store: s, changes } = store();
    s.set("clock", "zone", "Asia/Tokyo");
    s.set("clock", "items", [1, 2]);
    s.set("prs", "items", { open: 3 });
    expect(s.get("clock", "zone")).toBe("Asia/Tokyo");
    expect(s.get("prs", "items")).toEqual({ open: 3 });
    expect(s.get("prs", "zone")).toBeUndefined();
    expect(s.list("clock")).toEqual([
      { key: "items", value: [1, 2], updatedAt: 1_000 },
      { key: "zone", value: "Asia/Tokyo", updatedAt: 1_000 },
    ]);
    expect(s.list("clock", "it")).toEqual([{ key: "items", value: [1, 2], updatedAt: 1_000 }]);
    expect(changes).toEqual(["clock:zone", "clock:items", "prs:items"]);
  });

  it("notifies on delete only when a row went, and clears one slice without touching another", () => {
    const { store: s, changes } = store();
    s.set("clock", "a", 1);
    s.set("prs", "a", 2);
    changes.length = 0;
    s.delete("clock", "missing");
    expect(changes).toEqual([]);
    s.clearExtension("clock");
    expect(changes).toEqual(["clock:a"]);
    expect(s.get("clock", "a")).toBeUndefined();
    expect(s.get("prs", "a")).toBe(2);
    s.clear();
    expect(s.get("prs", "a")).toBeUndefined();
  });

  it("copies one slice over another in one write with no notice, and lists the slices that hold a key", () => {
    const { store: s, changes } = store();
    s.set("clock", "zone", "Asia/Tokyo");
    s.set("clock", "items", [1, 2]);
    s.set("clock#draft", "stale", true);
    changes.length = 0;
    s.copySlice("clock", "clock#draft");
    expect(changes).toEqual([]);
    expect(s.list("clock#draft")).toEqual(s.list("clock"));
    s.set("clock#draft", "zone", "Europe/Paris");
    expect(s.get("clock", "zone")).toBe("Asia/Tokyo");
    expect(s.slices()).toEqual(["clock", "clock#draft"]);
    s.clearExtension("clock#draft");
    expect(s.slices()).toEqual(["clock"]);
  });

  it("refuses a value or a slice over its cap with the cap named, changing nothing", () => {
    const { store: s } = store();
    const big = "x".repeat(PERSONAL_STORE_VALUE_MAX_BYTES);
    expect(() => s.set("clock", "big", big)).toThrow(PersonalStoreError);
    expect(() => s.set("clock", "big", big)).toThrow(String(PERSONAL_STORE_VALUE_MAX_BYTES));
    expect(s.get("clock", "big")).toBeUndefined();
    const chunk = "y".repeat(PERSONAL_STORE_VALUE_MAX_BYTES - 2);
    const fits = Math.floor(PERSONAL_STORE_MAX_BYTES / PERSONAL_STORE_VALUE_MAX_BYTES);
    for (let i = 0; i < fits; i += 1) s.set("clock", `chunk-${i}`, chunk);
    expect(() => s.set("clock", "one-more", chunk)).toThrow(String(PERSONAL_STORE_MAX_BYTES));
    // Overwriting an existing key counts the new value, not both.
    expect(() => s.set("clock", "chunk-0", chunk)).not.toThrow();
    expect(() => s.set("clock", "", 1)).toThrow(PersonalStoreError);
  });

  it("binds a server-side view to one extension", () => {
    const { store: s } = store();
    const db = s.forExtension("clock");
    db.set("zone", "UTC");
    expect(db.get("zone")).toBe("UTC");
    expect(s.get("clock", "zone")).toBe("UTC");
    expect(db.list()).toHaveLength(1);
    db.delete("zone");
    expect(db.get("zone")).toBeUndefined();
  });
});
