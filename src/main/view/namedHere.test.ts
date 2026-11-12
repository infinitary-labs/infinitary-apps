import type { Card, PastCard } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import type { FeedLine } from "@shared/feed";
import { englishOf, wordedLine } from "@shared/i18n/said";
import type { CoreInvokeChannel } from "@shared/ipc";
import type { TaskDetail } from "@shared/tasks";
import type { TimelineReading } from "@shared/timeline";
import { describe, expect, it } from "vitest";
import {
  CAPTAIN,
  ownCards,
  ownRecord,
  ownTimeline,
  ownWords,
  pastUpdateCard,
  RUNS_HERE,
} from "../../../tests/helpers/firstMatesOwnWords";
import { namedHere } from "./namedHere";

// The approved plan (INF-3674, piece 3): a line saved as a fact is worded
// where it is shown, but a line a computer that controls the first mate
// renamed this computer in keeps those words, since its fact would word
// this computer again.
describe("the first mate's own feed lines on a computer that controls it", () => {
  it("keep their fact unless naming the first mate's computer changed their words", () => {
    const said = { m: "settleMergingChange", a: { change: "PR #61" } };
    const lines: FeedLine[] = [
      { kind: "info", text: "Merging PR #61", said, saidHere: true, at: 1 },
      {
        kind: "info",
        text: "Merging on this computer",
        said: { m: "settleMerging" },
        saidHere: true,
        at: 2,
      },
    ];
    expect(namedHere("inf:feed:recent", lines, () => "Studio Mac")).toEqual([
      lines[0],
      { kind: "info", text: "Merging on Studio Mac", saidHere: true, at: 2 },
    ]);
  });
});

// INF-3676: a task's record, the cards the first mate's computer writes itself and a line that
// says here as a place name that computer on one that controls it; a crewmate's words, the
// captain's and the brief the first mate served stay as they are.
describe("the first mate's own record, cards and places on a computer that controls it", () => {
  const there = (channel: CoreInvokeChannel, answer: unknown) =>
    namedHere(channel, answer, () => "MacBook Pro");

  it("names its computer in a task's own lines, readings and problem", () => {
    const record = there("inf:tasks:detail", ownRecord()) as TaskDetail;
    expect(
      record.activityLog.map((row) => [
        row.text,
        row.change && row.text.slice(row.change.from, row.change.to),
      ]),
    ).toEqual([
      ["Opened pull request #612.", "pull request #612"],
      [ownWords("MacBook Pro").note, undefined],
      // The pull request it links moves with the words before it.
      ["MacBook Pro could not reach #612 where the project lives.", "#612"],
      [`Checked the soundings on ${HERE.this}.`, undefined],
      [CAPTAIN.text, undefined],
    ]);
    expect(record.problem).toBe("something it needed is missing on MacBook Pro");

    // The readings the record's Activity draws in place of its lines: its own note names it,
    // while the brief it served, which quotes the captain, and a crewmate's line stay.
    const written = ownTimeline();
    const reading = (readings: readonly TimelineReading[] | undefined, kind: string) =>
      readings?.find((one) => one.entry.content.kind === kind);
    const note = reading(record.timeline, "note");
    expect([note?.entry.summary, note?.text]).toEqual([
      "No sign-in for harbour.example is saved on MacBook Pro.",
      "No sign-in for harbour.example is saved on MacBook Pro.",
    ]);
    for (const kept of ["brief", "progress"]) {
      expect(reading(written, kept)?.text).toContain(HERE.this);
      expect(reading(record.timeline, kept)).toEqual(reading(written, kept));
    }
    expect(record.timeline).toHaveLength(written.length);
  });

  it("names its computer in the cards it wrote itself, with the change bar moved", () => {
    const cards = ownCards();
    const [update, pause, soundings] = there("inf:cards:list", cards) as Card[];
    expect(update?.body).toContain("MacBook Pro has alpha 0.7.1-alpha.557.");
    expect(update?.body).toContain("Update it sends MacBook Pro's Infinitary to it");
    expect(update?.body).not.toMatch(/this computer/i);
    // The change bar still starts at the paragraph that is new.
    const mark = update?.changes?.marks[0] ?? -1;
    expect(update?.body.slice(mark)).toMatch(/^<p>Update it sends MacBook Pro/);
    expect(pause?.title).toBe("Your first mate cannot run on MacBook Pro right now");
    expect(soundings).toEqual(cards[2]);
    expect(there("inf:cards:show", cards[0])).toEqual(update);
    expect((there("inf:cards:show-past", pastUpdateCard()) as PastCard).body).toBe(update?.body);
  });

  it("says on that computer where a line said here as a place", () => {
    const line: FeedLine = {
      kind: "info",
      text: englishOf(RUNS_HERE),
      said: RUNS_HERE,
      at: 3,
      saidHere: true,
    };
    const [named] = there("inf:feed:recent", [line]) as FeedLine[];
    const movedThere = "harbour-site runs on MacBook Pro now. Its next task starts on MacBook Pro.";
    expect(named).toMatchObject({ text: movedThere, saidHere: true });
    // Worded again in the window's language from its fact, it still names that computer.
    expect(named && wordedLine(named)).toBe(movedThere);
  });
});
