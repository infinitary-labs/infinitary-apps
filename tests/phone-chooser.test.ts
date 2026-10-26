import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_BUDGET_MS,
  partReach,
  partTimes,
  phoneDecision,
  placeParts,
  requestedParts,
} from "../scripts/affected-phone";
import { PHONE_PARTS } from "../scripts/phone-test-plan";

// INF-827 (the captain's approved INF-828 plan: "Run only the parts a change reaches; skip
// changes to unused setup" and "A journeys-style budget, with the rest checked later on main",
// read the change, 6 minutes, edited parts always even past the budget, setup runs rest).
// The changes are real ones merged to main, read by git; the times are each part's per-device
// minutes in phone run 39698258628 on the Mac mini, Oct 21.
const TIMES = JSON.stringify({
  join: { ipad: 7.7 * 60_000, iphone: 7.6 * 60_000 },
  talk: { ipad: 8.1 * 60_000, iphone: 8.0 * 60_000 },
  cards: { ipad: 6.6 * 60_000, iphone: 6.5 * 60_000 },
  rest: { ipad: 3.1 * 60_000, iphone: 3.1 * 60_000 },
});
type Change = { paths: string[]; testDiff: string; testFiles: Record<string, string> };
const change = (commit: string): Change =>
  JSON.parse(readFileSync(`tests/fixtures/phone-changes/${commit}.json`, "utf8"));
// `null` reads no part times file at all.
function choose(commit: string, times: string | null = TIMES, virtualMac = false) {
  const { paths, testDiff, testFiles } = change(commit);
  const decision = phoneDecision(paths, undefined, { virtualMac });
  if (!decision.run) return undefined;
  const reach = partReach(
    decision.reasons,
    testDiff,
    Object.keys(testFiles),
    (path) => testFiles[path],
  );
  return placeParts(reach, partTimes(times ?? undefined), { virtualMac });
}
const kept = (commit: string, times: string | null = TIMES) =>
  choose(commit, times)
    ?.filter((part) => part.kept)
    .map((part) => part.part)
    .sort();

describe("the phone check's parts on a pull request", () => {
  it("skips a change only to setup the device gates never run", () => {
    // da171d24e changed only virtual Mac scripts while the switch was off.
    expect(choose("da171d24e")).toBeUndefined();
  });

  it("runs the closest part alone when it is past the budget by itself", () => {
    // e3be41f53 rebuilt the card script, a file the cards part owns.
    const placed = choose("e3be41f53")!;
    expect(placed.map(({ part, distance, kept }) => [part, distance, kept])).toEqual([
      ["cards", 1, true],
      ["rest", 2, false],
      ["join", 2, false],
      ["talk", 2, false],
      // A part main has no time for yet costs the slowest measured one.
      ["address", 2, false],
    ]);
    expect(placed.find((part) => !part.kept)?.reason).toMatch(/nightly check of main/);
  });

  it("runs every part whose test code changed, even past the budget", () => {
    // 2dbbedc52 edited helpers the join and talk tests call, and removed one they called.
    const placed = choose("2dbbedc52")!;
    expect(kept("2dbbedc52")).toEqual(["join", "talk"]);
    const minutes = placed
      .filter((part) => part.kept)
      .reduce((sum, part) => sum + part.minutes!, 0);
    expect(minutes * 60_000).toBeGreaterThan(PHONE_BUDGET_MS);
    expect(placed.find((part) => part.part === "join")?.why).toMatch(/phoneActivityDisclosure/);
    expect(placed.find((part) => part.part === "cards")?.distance).toBe(1);
  });

  it("runs the shortest part, rest, for a change to setup the gates use", () => {
    // a7aa5e974 changed only phone.yml.
    expect(kept("a7aa5e974")).toEqual(["rest"]);
  });

  it("runs every part the change reaches when no part times can be read", () => {
    for (const times of [null, "", "{}", "not json"]) {
      expect(kept("e3be41f53", times)).toEqual(["address", "cards", "join", "rest", "talk"]);
      expect(choose("e3be41f53", times)![0]!.reason).toMatch(/no part times/);
    }
  });

  it("counts every part edited when it cannot read the test change", () => {
    const { paths, testFiles } = change("2dbbedc52");
    const reasons = phoneDecision(paths).reasons;
    const read = (path: string) => testFiles[path];
    for (const reach of [
      partReach(reasons, undefined, Object.keys(testFiles), read),
      partReach(reasons, change("2dbbedc52").testDiff, Object.keys(testFiles), () => undefined),
    ])
      expect(reach.map((part) => part.distance)).toEqual(PHONE_PARTS.map(() => 0));
  });

  it("runs the virtual Mac scripts' change, with every part, while the switch is on", () => {
    expect(choose("da171d24e", TIMES, true)?.every((part) => part.kept)).toBe(true);
  });
});

// Captain's INF-1258 selection: requested phone checks run touched parts, uncertainty runs all.
describe("affected phone requests", () => {
  function request(commit: string, unreadable = false, uiOnly = false) {
    const { paths, testDiff, testFiles } = change(commit);
    const reasons = phoneDecision(
      uiOnly ? paths.filter((path) => path.includes("InfinitaryUITests/")) : paths,
    ).reasons;
    return requestedParts(
      reasons,
      partReach(
        reasons,
        unreadable ? undefined : testDiff,
        Object.keys(testFiles),
        (path) => testFiles[path],
      ),
    ).map((each) => each.part);
  }
  it("runs only cards for the real generated card-runtime change, without timing data", () => {
    expect(request("e3be41f53")).toEqual(["cards"]);
  });
  it("runs every reached part, not just the closest or one fitting a time budget", () => {
    // Replay only the real UI-test hunks: its other product edits include shared style.
    expect(request("2dbbedc52", false, true)).toEqual(["join", "talk"]);
    expect(request("2dbbedc52")).toEqual(PHONE_PARTS.map((part) => part.name));
  });
  it("runs all parts for shared gate setup or an unreadable test diff", () => {
    const all = PHONE_PARTS.map((part) => part.name);
    expect(request("a7aa5e974")).toEqual(all);
    expect(request("2dbbedc52", true)).toEqual(all);
  });
});
