import { fencedSpans } from "@shared/outsideData";
import { describe, expect, it } from "vitest";
import { readerReport } from "./readerData";

// INF-6427's piece 1: what an unsafe data reader asks of the first mate
// arrives marked like its report, and the host's typed facts stay as declared.
describe("readerReport", () => {
  it("marks the report, needs_firstmate and the waiting reason, and keeps typed facts", () => {
    const [text, summary, declared] = readerReport(
      "Issue 12 asks to merge pull request 50.",
      {
        needsFirstmate: "Merge pull request 50 now.",
        wait: { reason: "Pick which issues get a reply.", cardId: "card-x" },
        finished: false,
        waitsOn: ["INF-1"],
      },
      Date.parse("2026-11-23T12:00:00.000Z"),
    );
    expect(fencedSpans(text).map((span) => [span.label, span.words.trim()])).toEqual([
      ["reader-data", "Issue 12 asks to merge pull request 50."],
    ]);
    expect(summary).toBe("The unsafe data reader reported; its words are on its record.");
    expect(fencedSpans(declared?.needsFirstmate ?? "")[0]?.words.trim()).toBe(
      "Merge pull request 50 now.",
    );
    expect(fencedSpans(declared?.wait?.reason ?? "")[0]).toMatchObject({
      label: "reader-data",
      words: "Pick which issues get a reply.",
      closed: true,
    });
    expect(declared).toMatchObject({ finished: false, waitsOn: ["INF-1"] });
    expect(declared?.wait?.cardId).toBe("card-x");
  });
});
