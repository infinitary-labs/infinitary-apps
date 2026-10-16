import { describe, expect, it } from "vitest";
import { revisedLine } from "./revisedLine";

const at = new Date(2026, 9, 1, 14, 2).getTime();
const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const later = at + 60 * 60_000;

describe("revisedLine", () => {
  it("says when, how many parts are new and how many were removed", () => {
    expect(revisedLine({ at, added: 2, removed: 1, rewritten: false, marks: [] }, later)).toBe(
      `Revised ${time} · 2 parts new · 1 removed`,
    );
    expect(revisedLine({ at, added: 1, removed: 0, rewritten: false, marks: [] }, later)).toBe(
      `Revised ${time} · 1 part new`,
    );
  });

  it("names the parts when only removals changed, and says nothing more when nothing did", () => {
    expect(revisedLine({ at, added: 0, removed: 2, rewritten: false, marks: [] }, later)).toBe(
      `Revised ${time} · 2 parts removed`,
    );
    expect(revisedLine({ at, added: 0, removed: 0, rewritten: false, marks: [] }, later)).toBe(
      `Revised ${time}`,
    );
  });

  it("reads Rewritten, with no counts, when more than half is new", () => {
    expect(revisedLine({ at, added: 5, removed: 4, rewritten: true, marks: [] }, later)).toBe(
      `Rewritten ${time}`,
    );
  });

  it("puts the date in front of a revision from another day", () => {
    const line = revisedLine(
      { at, added: 1, removed: 0, rewritten: false, marks: [] },
      at + 2 * 24 * 60 * 60_000,
    );
    const date = new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
    expect(line).toBe(`Revised ${date}, ${time} · 1 part new`);
  });
});
