import type { ReleaseNotesView, ShownReleaseNote } from "@shared/releaseTracking";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { noteStop, VersionRowView } from "./VersionRow";

/**
 * Settings → General → Version (docs/release-notes.md "Reading a note
 * again"): the version running now and the newest three release notes,
 * one Tab stop that the arrows move through.
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STABLE: ShownReleaseNote = {
  version: "0.1.28",
  name: "stable 0.1.28",
  cardId: "a",
  listed: false,
  shownAt: 3,
};

const SHOWN: ReleaseNotesView = {
  version: "0.1.28",
  name: "stable 0.1.28",
  notes: [
    STABLE,
    {
      version: "0.1.28-alpha.2",
      name: "alpha 0.1.28-alpha.2",
      cardId: "b",
      listed: true,
      shownAt: 2,
    },
  ],
};

describe("the Version row", () => {
  // INF-3808: the row said "Reading the version…" for as long as the notes read went
  // unanswered; the update status already carries the version running.
  it("names the version running from the update status while the notes are unread", () => {
    const reading = text(renderToStaticMarkup(<VersionRowView releaseNotes={null} />));
    expect(reading).toBe("Version Reading the version…");
    const running = text(
      renderToStaticMarkup(<VersionRowView releaseNotes={null} running="0.8.2-alpha.628" />),
    );
    expect(running).toBe("Version Alpha 0.8.2-alpha.628.");
    expect(
      text(renderToStaticMarkup(<VersionRowView releaseNotes={SHOWN} running="0.1.28" />)),
    ).toContain("Version Stable 0.1.28. Each release note");
  });

  it("names the version running now and lists each note, newest first, one Tab stop", () => {
    const html = renderToStaticMarkup(<VersionRowView releaseNotes={SHOWN} />);
    expect(text(html)).toContain(
      "Version Stable 0.1.28. Each release note you were shown opens again as you saw it.",
    );
    const rows = [
      ...html.matchAll(/<button[^>]*data-release-note="([^"]+)"[^>]*tabindex="(-?\d)"/g),
    ];
    expect(rows.map(([, version, tab]) => [version, tab])).toEqual([
      ["0.1.28", "0"],
      ["0.1.28-alpha.2", "-1"],
    ]);
    expect(text(html)).toContain("Stable 0.1.28 · no new changes");
    expect(text(html)).toContain("Alpha 0.1.28-alpha.2");
  });

  it("initially shows only the newest three notes and offers the rest without changing the input", () => {
    const notes = Array.from({ length: 5 }, (_, index) => ({
      ...STABLE,
      version: `0.1.${5 - index}`,
      shownAt: 5 - index,
    }));
    const html = renderToStaticMarkup(<VersionRowView releaseNotes={{ ...SHOWN, notes }} />);
    expect(
      [...html.matchAll(/data-release-note="([^"]+)"/g)].map(([, version]) => version),
    ).toEqual(["0.1.5", "0.1.4", "0.1.3"]);
    expect(text(html)).toContain("Show more");
    expect(notes).toHaveLength(5);
  });

  it("offers no disclosure when all notes fit", () => {
    for (const count of [0, 1, 2, 3]) {
      const notes = Array.from({ length: count }, (_, index) => ({
        ...STABLE,
        version: `0.1.${index}`,
      }));
      const html = renderToStaticMarkup(<VersionRowView releaseNotes={{ ...SHOWN, notes }} />);
      expect([...html.matchAll(/data-release-note=/g)]).toHaveLength(count);
      expect(text(html)).not.toContain("Show more");
    }
  });

  it("says so before any note was shown, with no list", () => {
    const html = renderToStaticMarkup(<VersionRowView releaseNotes={{ ...SHOWN, notes: [] }} />);
    expect(text(html)).toContain("Stable 0.1.28. No release notes yet.");
    expect(html).not.toContain("data-release-note");
  });

  it("moves its stop with the arrows, Home and End, stopping at either end", () => {
    expect(noteStop("ArrowDown", 0, 3)).toBe(1);
    expect(noteStop("ArrowDown", 2, 3)).toBe(2);
    expect(noteStop("ArrowUp", 0, 3)).toBe(0);
    expect(noteStop("End", 0, 3)).toBe(2);
    expect(noteStop("Home", 2, 3)).toBe(0);
    expect(noteStop("Enter", 1, 3)).toBeNull();
    expect(noteStop("ArrowDown", 0, 0)).toBeNull();
  });
});
