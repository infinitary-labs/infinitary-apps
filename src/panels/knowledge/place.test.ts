import { KNOWLEDGE_STANDING_WORDS } from "@shared/knowledge";
import { describe, expect, it } from "vitest";
import { HOME_CAMERA } from "./graph";
import { askOf, entryIdOf, FRESH, placeOf, startOf } from "./place";
import {
  askWords,
  connectionSentence,
  countsOf,
  originLine,
  rangeOf,
  STANDING_WORDS,
} from "./words";

/**
 * What the knowledge browser keeps while it pages and what a key that put
 * it up asks (the design skill's `components/knowledge/KnowledgeBrowser`,
 * "Where the browser opens"), and the words it says them with.
 */

describe("the browser's place", () => {
  it("reads back what it kept, and starts fresh from anything else", () => {
    expect(placeOf(null)).toEqual(FRESH);
    expect(placeOf("nonsense")).toEqual(FRESH);
    expect(FRESH.camera).toEqual(HOME_CAMERA);
    const kept = placeOf({
      scope: "repo-alpha",
      query: "proof",
      tab: "findings",
      selection: { kind: "connection", id: "claim:f-abc123" },
      node: "c-abc123",
      section: "evidence",
      camera: { yaw: 1.2, pitch: 0.4, zoom: 1.3 },
      nearby: true,
      hops: 2,
      filter: "recheck",
      pages: { concepts: 1, findings: 2 },
      detail: true,
      answered: 3,
    });
    expect(kept).toMatchObject({
      scope: "repo-alpha",
      tab: "findings",
      selection: { kind: "connection", id: "claim:f-abc123" },
      camera: { yaw: 1.2, pitch: 0.4, zoom: 1.3 },
      hops: 2,
      filter: "recheck",
      pages: { concepts: 1, findings: 2 },
      answered: 3,
    });
    // An id it cannot have written, a tab it has not, a zoom past the range.
    const odd = placeOf({
      selection: { kind: "concept", id: "../../etc" },
      tab: "settings",
      camera: { zoom: 9 },
    });
    expect(odd.selection).toBeNull();
    expect(odd.tab).toBe("graph");
    expect(odd.camera.zoom).toBe(1.45);
    // An earlier revision is kept with a concept or a finding, and only a whole one.
    expect(
      placeOf({ selection: { kind: "finding", id: "f-abc123", revision: 2 } }).selection,
    ).toEqual({ kind: "finding", id: "f-abc123", revision: 2 });
    expect(
      placeOf({ selection: { kind: "finding", id: "f-abc123", revision: 1.5 } }).selection,
    ).toEqual({ kind: "finding", id: "f-abc123" });
    expect(
      placeOf({ selection: { kind: "connection", id: "claim:f-abc123", revision: 2 } }).selection,
    ).toEqual({ kind: "connection", id: "claim:f-abc123" });
  });

  it("answers what a key, a row or a reference asked for", () => {
    expect(askOf({ focus: "pane" })).toEqual({ focus: "pane", scope: null, entry: null });
    expect(askOf({ focus: "find", scope: "captain" })).toEqual({
      focus: "find",
      scope: "captain",
      entry: null,
    });
    expect(askOf(null)).toEqual({ focus: null, scope: null, entry: null });
    // A card's reference names an entry; a Knowledge used row, the revision its work used.
    expect(askOf({ focus: "inspector", scope: "repo-alpha", entry: "f-abc123" })).toEqual({
      focus: "inspector",
      scope: "repo-alpha",
      entry: { kind: "finding", id: "f-abc123" },
    });
    expect(askOf({ focus: "inspector", entry: "c-abc123", revision: 3 })).toEqual({
      focus: "inspector",
      scope: null,
      entry: { kind: "concept", id: "c-abc123", revision: 3 },
    });
    // The inspector takes focus only for an entry it can open.
    expect(askOf({ focus: "inspector", entry: "claim:f-abc123" })).toEqual({
      focus: null,
      scope: null,
      entry: null,
    });
  });

  it("reads a connection through its finding or its declaring concept", () => {
    expect(entryIdOf({ kind: "connection", id: "claim:f-abc123" })).toBe("f-abc123");
    expect(entryIdOf({ kind: "connection", id: "context:c-aaaaaa:c-bbbbbb" })).toBe("c-aaaaaa");
    expect(entryIdOf({ kind: "finding", id: "f-abc123" })).toBe("f-abc123");
    expect(startOf({ kind: "connection", id: "context:c-aaaaaa:c-bbbbbb" })).toBe("c-aaaaaa");
    expect(startOf({ kind: "concept", id: "c-cccccc" })).toBe("c-cccccc");
  });
});

describe("the browser's words", () => {
  it("says a connection as a sentence, counts and ranges", () => {
    const named = (title: string) => ({
      id: "c-x",
      kind: "concept" as const,
      title,
      retired: false,
    });
    expect(
      connectionSentence({
        kind: "claim",
        id: "claim:f-1",
        finding: "f-1",
        from: named("Evidence"),
        predicate: "pins",
        to: named("Source versions"),
        standing: "unchecked",
      }),
    ).toBe("Evidence pins Source versions");
    expect(
      connectionSentence({ kind: "context", from: named("Evidence"), to: named("Reuse") }),
    ).toBe("Evidence read with Reuse");
    expect(countsOf({ concepts: 1, findings: 4 })).toBe("1 concept · 4 findings");
    expect(rangeOf(1, 20, 20, 52)).toBe("21–40 of 52");
    expect(
      originLine({
        kind: "file",
        path: "a.ts",
        startLine: 3,
        endLine: 9,
        commit: "0123456789abc",
        dirty: true,
      }),
    ).toBe("a.ts, lines 3–9 · kept at commit 0123456789 with uncommitted changes");
  });

  it("asks about exactly what is shown, by its id and revision", () => {
    expect(
      askWords({
        kind: "finding",
        title: "Closing a task keeps its evidence.",
        id: "f-abc123",
        revision: 1,
      }),
    ).toBe(
      "What should I know about the finding “Closing a task keeps its evidence” (f-abc123, revision 1)? ",
    );
    expect(
      askWords({
        kind: "claim",
        sentence: "Evidence pins Source versions",
        finding: "f-abc123",
        revision: 2,
      }),
    ).toBe(
      "What should I know about the claim “Evidence pins Source versions” (f-abc123, revision 2)? ",
    );
    expect(
      askWords({
        kind: "context",
        from: { title: "Knowledge reuse", id: "c-aaaaaa" },
        to: { title: "Evidence", id: "c-bbbbbb" },
      }),
    ).toBe(
      "What should I know about reading “Knowledge reuse” with “Evidence” (c-aaaaaa, c-bbbbbb)? ",
    );

    // A long statement is quoted short; the question stays one line a panel may draft.
    const long = askWords({
      kind: "concept",
      title: "word ".repeat(200),
      id: "c-abc123",
      revision: 1,
    });
    expect(long.length).toBeLessThan(260);
    expect(long).not.toMatch(/[\r\n]/);
  });
});

describe("a finding's standing in words", () => {
  it("says what the app's own surfaces outside the browser say", () => {
    expect(STANDING_WORDS).toEqual(KNOWLEDGE_STANDING_WORDS);
  });
});
