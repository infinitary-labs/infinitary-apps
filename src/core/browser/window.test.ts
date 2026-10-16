import { describe, expect, it } from "vitest";
import type { OutlineLine } from "./outline";
import {
  FIND_CHARS,
  FOLD_MIN,
  foundWords,
  linesHolding,
  MAP_SHOWN,
  mapOf,
  WINDOW_CHARS,
  windowOf,
} from "./window";

/**
 * Which part of a page one answer shows. The page below has the shape of a
 * long changelog: a banner, then a main landmark holding one region per
 * release, each with its heading, the same long paragraph, and a link.
 */

const PARAGRAPH = `text ${JSON.stringify("Back up your work before you upgrade. ".repeat(8).trim())}`;

function line(text: string, role: string, depth: number, onScreen?: boolean): OutlineLine {
  const shown = `${"  ".repeat(depth)}${text}`;
  return { text: shown, depth, role, words: text, ...(onScreen !== undefined ? { onScreen } : {}) };
}

/** A changelog of `releases` regions; the window shows the lines `screen` names, when given. */
function changelog(releases: number, screen?: (index: number) => boolean): OutlineLine[] {
  const lines: OutlineLine[] = [
    line("banner", "banner", 0),
    line('link "Home" [g1:e1] → /', "link", 1),
    line("main", "main", 0),
  ];
  for (let release = 1; release <= releases; release += 1) {
    lines.push(
      line(`region "Release ${release}"`, "region", 1),
      line(`heading "Release ${release}" (level 2)`, "heading", 2),
      line(PARAGRAPH, "text", 2),
      line(`link "Download release ${release}" [g1:e${release + 1}] → /r/${release}`, "link", 2),
    );
  }
  return screen ? lines.map((each, index) => ({ ...each, onScreen: screen(index) })) : lines;
}

/** The outline lines a window printed, without its own header and map. */
function shown(window: { lines: string[] }): string[] {
  const end = window.lines.findIndex((each) => /^map\[\d+\]:$/.test(each));
  return window.lines.slice(1, end < 0 ? undefined : end);
}

function chars(lines: readonly string[]): number {
  return lines.reduce((sum, each) => sum + each.length + 1, 0);
}

describe("an answer's window", () => {
  it("shows a page that fits whole, with no map and no next lines", () => {
    const page = changelog(3);
    const window = windowOf(page, { kind: "top" });
    expect(window.lines[0]).toBe(`outline: lines 1-${page.length} of ${page.length}`);
    expect(window.lines.some((each) => each.startsWith("map["))).toBe(false);
    expect(window.next).toEqual([]);
  });

  it("folds a long passage the answer already showed into a pointer to its first copy", () => {
    const window = windowOf(changelog(3), { kind: "top" });
    expect(PARAGRAPH.length).toBeGreaterThanOrEqual(FOLD_MIN);
    // The first copy is line 6; the next two point at it, at their own depth.
    expect(window.lines[6]).toBe(`    ${PARAGRAPH}`);
    expect(window.lines.filter((each) => each.includes(PARAGRAPH))).toHaveLength(1);
    expect(window.lines).toContain(`    text (same as line 6, ${PARAGRAPH.length} characters)`);
  });

  it("cuts a long page within its bound, maps its parts by line, and says how to read on", () => {
    const page = changelog(120);
    const window = windowOf(page, { kind: "top" });
    const lines = shown(window);
    expect(chars(lines)).toBeLessThanOrEqual(WINDOW_CHARS);
    expect(window.lines[0]).toBe(`outline: lines 1-${lines.length} of ${page.length}`);
    const map = window.lines.slice(window.lines.indexOf(`map[${120 + 2}]:`));
    // Landmarks and regions with the line each starts on; a heading under its region adds nothing.
    expect(map).toContain("  1 banner");
    expect(map).toContain("  3 main");
    expect(map).toContain('  4 region "Release 1"');
    expect(map.some((each) => each.includes("heading"))).toBe(false);
    expect(map).toContain(`  … and ${122 - MAP_SHOWN} more parts`);
    expect(window.next).toEqual([
      `\`infinitary-browser-axi snapshot --from ${lines.length + 1}\` reads on from line ${lines.length + 1}`,
      "`infinitary-browser-axi snapshot --find <words>` reads the part of the page that holds them",
    ]);
  });

  it("reads on from a line, numbered as in the whole outline", () => {
    const page = changelog(120);
    const window = windowOf(page, { kind: "from", line: 300 });
    expect(window.lines[0]).toMatch(new RegExp(`^outline: lines 300-\\d+ of ${page.length}$`));
    expect(shown(window)[0]).toBe(page[299]?.text);
    // Past the end, it says how long the page is instead of showing nothing.
    expect(windowOf(page, { kind: "from", line: 5000 }).lines[0]).toBe(
      `outline: line 5000 is past the page's end; it has ${page.length} lines.`,
    );
  });

  it("finds words past the cut and shows the part that holds them, within the smaller bound", () => {
    const page = changelog(120);
    const window = windowOf(page, { kind: "find", words: "download RELEASE 117" });
    // Line 4 + 116 regions of 4 lines, then the region's own line: the link is its fourth.
    const at = 3 + 116 * 4 + 4;
    expect(window.found).toEqual([at]);
    // The window starts at the region that holds it, not at the page's top.
    expect(shown(window)[0]).toBe('  region "Release 117"');
    expect(chars(shown(window))).toBeLessThanOrEqual(FIND_CHARS);
    expect(foundWords("download RELEASE 117", window.found ?? [])).toBe(
      `Found "download RELEASE 117" on line ${at}.`,
    );
  });

  it("names every line that holds the words and steps to the next one from a line", () => {
    const page = changelog(120);
    const all = windowOf(page, { kind: "find", words: "Release 11" });
    expect(all.found?.length).toBeGreaterThan(12);
    expect(foundWords("Release 11", all.found ?? [])).toMatch(/, and \d+ more\.$/);
    // The next line names the first line past this window that holds them.
    const next = all.next
      .map((each) =>
        /^`infinitary-browser-axi snapshot --find "Release 11" --from (\d+)` reads the next line that holds them$/.exec(
          each,
        ),
      )
      .find((match) => match !== null);
    const later = Number(next?.[1]);
    const lastShown = Number(/^outline: lines \d+-(\d+) of/.exec(all.lines[0] ?? "")?.[1]);
    expect(later).toBe(all.found?.find((at) => at > lastShown));
    const stepped = windowOf(page, { kind: "find", words: "Release 11", from: later });
    expect(stepped.found?.[0]).toBe(later);
    expect(foundWords("nothing like this", [], 40)).toBe(
      'No line from line 40 on holds "nothing like this".',
    );
  });

  it("finds the whole of a passage, not only its cut line", () => {
    const page: OutlineLine[] = [
      {
        text: 'text "aaaa…" [g1:e1] (cut short)',
        depth: 0,
        role: "text",
        words: 'text "aaaa…"\naaaa the tail',
      },
    ];
    expect(linesHolding(page, "the tail")).toEqual([0]);
    expect(windowOf(page, { kind: "top" }).next).toContain(
      "`infinitary-browser-axi snapshot @g1:e1` reads line 1's passage in full",
    );
  });

  it("shows the lines on screen after a scroll, and says which lines it skipped", () => {
    // The banner stays on screen; the page shows releases 30 and 31 below it.
    const page = changelog(
      120,
      (index) => index < 2 || (index >= 3 + 29 * 4 && index < 3 + 31 * 4),
    );
    const window = windowOf(page, { kind: "screen" });
    expect(window.lines[0]).toBe(
      `outline: lines 1-${3 + 31 * 4} of ${page.length}, those on screen`,
    );
    expect(window.lines).toContain(`… lines 3-${3 + 29 * 4} are not on screen`);
    expect(shown(window)).toContain('  region "Release 30"');
    expect(shown(window)).not.toContain('  region "Release 29"');
    expect(chars(shown(window))).toBeLessThan(2_000);
  });

  it("shows the page from its top when it cannot tell what is on screen", () => {
    const page = changelog(3);
    expect(windowOf(page, { kind: "screen" }).lines[0]).toBe(
      `outline: lines 1-${page.length} of ${page.length}`,
    );
  });

  it("shows the part around a passage just read", () => {
    const page = changelog(120);
    const window = windowOf(page, { kind: "around", ref: "g1:e101" });
    expect(shown(window)).toContain('    link "Download release 100" [g1:e101] → /r/100');
    expect(shown(window)[0]).toBe('  region "Release 100"');
  });

  it("shows a page small enough whole around the words, so nothing above them is missed", () => {
    const page = changelog(3);
    const window = windowOf(page, { kind: "find", words: "Download release 3" });
    expect(window.lines[0]).toBe(`outline: lines 1-${page.length} of ${page.length}`);
  });

  it("maps nothing on a page with no named parts", () => {
    expect(mapOf([line('text "plain"', "text", 0)])).toEqual([]);
  });
});
