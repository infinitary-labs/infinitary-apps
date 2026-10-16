import {
  type ReleaseDelivery,
  releaseNoteToShow,
  UNKNOWN_RELEASE_TRACKING,
} from "@shared/releaseTracking";
import { describe, expect, it } from "vitest";
import { releaseNotesView } from "./shown";

/**
 * Reading a note again (docs/release-notes.md): the notes the app showed,
 * read from the version tracking record, and the one What's new opens.
 */

const delivery = (
  cardId: string | null,
  entryIds: string[],
  deliveredAt: number,
): ReleaseDelivery => ({
  boundary: { version: null, source: null },
  entryIds,
  coverage: entryIds.length > 0 ? "complete" : "unavailable",
  cardId,
  deliveredAt,
});

const tracking = {
  ...UNKNOWN_RELEASE_TRACKING,
  deliveries: {
    "0.1.26": delivery("card-26", ["a", "b"], 100),
    "0.1.27-alpha.2": delivery("card-27a", ["c"], 200),
    // A promotion that said only that nothing was new.
    "0.1.27": delivery("card-27", [], 300),
    // A delivery recorded with no card makes nothing to open.
    "0.1.28-alpha.1": delivery(null, ["d"], 400),
  },
};

describe("the release notes the app showed", () => {
  it("lists each note that made a card, newest first, each named with its channel", () => {
    const view = releaseNotesView(tracking, "0.1.28-alpha.1");
    expect(view.name).toBe("alpha 0.1.28-alpha.1");
    expect(view.notes).toEqual([
      { version: "0.1.27", name: "stable 0.1.27", cardId: "card-27", listed: false, shownAt: 300 },
      {
        version: "0.1.27-alpha.2",
        name: "alpha 0.1.27-alpha.2",
        cardId: "card-27a",
        listed: true,
        shownAt: 200,
      },
      { version: "0.1.26", name: "stable 0.1.26", cardId: "card-26", listed: true, shownAt: 100 },
    ]);
  });

  it("has none before a note was shown", () => {
    expect(releaseNotesView(UNKNOWN_RELEASE_TRACKING, "0.1.28").notes).toEqual([]);
  });
});

describe("the note What's new opens", () => {
  const { notes } = releaseNotesView(tracking, "0.1.28-alpha.1");

  it("is the newest that listed changes, past a newer one that said nothing was new", () => {
    expect(releaseNoteToShow(notes)?.cardId).toBe("card-27a");
  });

  it("is the named version's, listed or not, and none for a version never shown", () => {
    expect(releaseNoteToShow(notes, "0.1.27")?.cardId).toBe("card-27");
    expect(releaseNoteToShow(notes, "0.1.26")?.cardId).toBe("card-26");
    expect(releaseNoteToShow(notes, "0.1.20")).toBeUndefined();
  });

  it("is the newest when none listed changes, and none before any was shown", () => {
    const quiet = notes.filter((note) => !note.listed);
    expect(releaseNoteToShow(quiet)?.cardId).toBe("card-27");
    expect(releaseNoteToShow([])).toBeUndefined();
  });
});
