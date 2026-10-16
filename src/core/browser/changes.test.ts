import { describe, expect, it } from "vitest";
import { changesOf } from "./changes";
import type { OutlineLine } from "./outline";
import { WINDOW_CHARS } from "./window";

const lines = (texts: string[]): OutlineLine[] =>
  texts.map((text) => ({ text, words: text, role: "text", depth: 0 }));

describe("changed outline lines", () => {
  it("reports no change, including an empty page", () => {
    expect(changesOf([], []).lines).toEqual(["changed: nothing changed in the outline."]);
    expect(changesOf(["same"], lines(["same"])).lines).toEqual([
      "changed: nothing changed in the outline.",
    ]);
  });
  it("keeps current and old numbers for separate insertions, replacements and removals", () => {
    const answer = changesOf(
      ["heading", "closed", "kept", "removed", "tail"],
      lines(["heading", "expanded", "download", "kept", "tail"]),
    ).lines.join("\n");
    expect(answer).toContain("2 old lines removed, 2 current lines added");
    expect(answer).toContain("- old line 2: closed");
    expect(answer).toContain("+ line 2: expanded");
    expect(answer).toContain("+ line 3: download");
    expect(answer).toContain("- old line 4: removed");
    expect(answer).not.toContain(": kept");
    expect(answer).not.toContain(": heading");
  });
  it("handles repeated lines without counting line-number shifts as changes", () => {
    expect(
      changesOf(["same", "same", "end"], lines(["same", "insert", "same", "end"])).lines,
    ).toEqual([
      "changed: 0 old lines removed, 1 current lines added (replacements count as both).",
      "+ line 2: insert",
    ]);
  });
  it("bounds comparison work and output on wholesale replacement, with a factual recovery read", () => {
    const changed = changesOf(
      Array.from({ length: 2000 }, (_, i) => `old ${i}`),
      lines(Array.from({ length: 2000 }, (_, i) => `new ${i}`)),
    );
    const answer = changed.lines.join("\n");
    expect(answer).toContain("2000 old lines removed, 2000 current lines added");
    expect(answer.length).toBeLessThan(WINDOW_CHARS + 1000);
    expect(answer).toContain("changed lines not shown");
    expect(changed.next).toEqual([
      "`infinitary-browser-axi snapshot` reads the current page; `infinitary-browser-axi snapshot --from <line>` reads from a current line above.",
    ]);
  });
});
