import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it } from "vitest";
import { afterMergeStrip } from "./afterMergeStrip";

// INF-4574, the captain's yes: "A step stops asking again for what its merge card
// named." The merge card says what the captain's own merge click allows a step to use,
// so the click is a consent the captain could read before giving it.
describe("afterMergeStrip", () => {
  it("names what the captain's merge click allows a step, and nothing for a step that uses nothing", () => {
    const uses = "the phone check on the iPhone simulator, about 20 minutes of CI time";
    const html = afterMergeStrip(
      [],
      [
        { title: "Run the phone check on the merged version", uses },
        { title: "Remove the old batch branches" },
      ],
    );
    const lines = [...html.matchAll(/<p data-inf-after-merge-uses="">(.*?)<\/p>/g)].map(
      (line) => line[1],
    );
    expect(lines).toEqual([m.cardAfterMergeUses({ uses })]);
    expect(lines[0]).toContain(uses);
  });
});
