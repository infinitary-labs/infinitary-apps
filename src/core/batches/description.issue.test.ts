import { describe, expect, it } from "vitest";
import { BATCH_DESCRIPTION_WORDS, batchDescription, issueLine } from "./description";

// Intent: INF-6426's approved plan, piece A. Where a change built from a
// reader's Build row is published, GitHub reads "Closes #N" for a fix or a
// plan's last piece and "Part of #N" for any other piece; in a batch of
// several the words go on the change's line of the list.

describe("a change that answers an outside issue", () => {
  it("says Closes or Part of on GitHub, and nothing on a host whose issues do not read it", () => {
    expect(issueLine({ number: 7, closes: true }, "github")).toBe("Closes #7");
    expect(issueLine({ number: 7 }, "github")).toBe("Part of #7");
    expect(issueLine({ number: 7, closes: true }, "gitlab")).toBeUndefined();
    expect(issueLine(undefined, "github")).toBeUndefined();
  });

  it("puts each change's line after its title in a batch of several's list", () => {
    const { body } = batchDescription(
      [
        { title: "fix(meter): keep the daily reading at zero or above", issue: "Closes #7" },
        { title: "docs: explain the daily view" },
        { title: "feat(meter): show the week's readings", issue: "Part of #12" },
      ],
      { description: 65536, comment: 65536 },
    );
    expect(body.split("\n\n").slice(0, 2)).toEqual([
      BATCH_DESCRIPTION_WORDS.opening(3),
      [
        "- fix(meter): keep the daily reading at zero or above (Closes #7)",
        "- docs: explain the daily view",
        "- feat(meter): show the week's readings (Part of #12)",
      ].join("\n"),
    ]);
  });
});
