import { inLanguage } from "@shared/i18n/current";
import { englishOf, wordSaid } from "@shared/i18n/said";
import { describe, expect, it } from "vitest";
import { settleFeedSaid } from "./settleService";

// INF-7274's review: a local merge refused because the default branch is
// open in another folder keeps its plain line as a fact, worded in the
// language of whoever reads the feed, not the one the app spoke when it
// refused.
describe("a refused local merge's feed line", () => {
  const refusal = {
    ok: false,
    text: "Cannot merge: main is checked out at /work/video-script; switch that folder to another branch first.",
    problem:
      "main is checked out at /work/video-script; switch that folder to another branch first.",
  };

  it("saves English beside it and words German where it is read, whatever the app spoke then", () => {
    const fact = inLanguage("de", () => settleFeedSaid("land", refusal));
    if (typeof fact === "string") throw new Error(`expected a fact, got "${fact}"`);
    expect(englishOf(fact)).toBe(
      "Cannot merge: the branch it merges into is open in another folder - switch that folder to another branch first",
    );
    expect(inLanguage("de", () => wordSaid(fact))).toBe(
      "Zusammenführen nicht möglich: der Branch, in den es zusammengeführt wird, ist in einem anderen Ordner geöffnet – wechsle dort zuerst zu einem anderen Branch",
    );
  });
});
