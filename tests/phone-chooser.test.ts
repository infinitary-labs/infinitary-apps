import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_BUDGET_MS,
  partReach,
  partTimes,
  phoneDecision,
  phoneRepeatPlan,
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
// The part table these changes were chosen with: scripts/phone-test-plan.ts's PHONE_PARTS before
// INF-2125 split join, talk, relaunch and cards into short parts. Each change replays against it.
const BEFORE_SPLIT = [
  { name: "join", test: "testJoinAndRecover" },
  { name: "talk", test: "testTalkAndTasks" },
  { name: "relaunch", test: "testRelaunchThenTasks" },
  { name: "cards", test: "testCards" },
  { name: "address", test: "testJoinByAddress" },
  { name: "rest", test: "testCharacterAndPastChoices" },
] as const;
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
    BEFORE_SPLIT,
  );
  return placeParts(reach, partTimes(times ?? undefined, BEFORE_SPLIT), { virtualMac });
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
      ["relaunch", 2, false],
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
      expect(kept("e3be41f53", times)).toEqual(BEFORE_SPLIT.map((part) => part.name).sort());
      expect(choose("e3be41f53", times)![0]!.reason).toMatch(/no part times/);
    }
  });

  it("counts every part edited when it cannot read the test change", () => {
    const { paths, testFiles } = change("2dbbedc52");
    const reasons = phoneDecision(paths).reasons;
    const read = (path: string) => testFiles[path];
    for (const reach of [
      partReach(reasons, undefined, Object.keys(testFiles), read, BEFORE_SPLIT),
      partReach(
        reasons,
        change("2dbbedc52").testDiff,
        Object.keys(testFiles),
        () => undefined,
        BEFORE_SPLIT,
      ),
    ])
      expect(reach.map((part) => part.distance)).toEqual(BEFORE_SPLIT.map(() => 0));
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
        BEFORE_SPLIT,
      ),
    ).map((each) => each.part);
  }
  it("runs only cards for the real generated card-runtime change, without timing data", () => {
    expect(request("e3be41f53")).toEqual(["cards"]);
  });
  it("runs every reached part, not just the closest or one fitting a time budget", () => {
    // Replay only the real UI-test hunks: its other product edits include shared style.
    expect(request("2dbbedc52", false, true)).toEqual(["join", "talk"]);
    expect(request("2dbbedc52")).toEqual(BEFORE_SPLIT.map((part) => part.name));
  });
  it("runs all parts for shared gate setup or an unreadable test diff", () => {
    const all = BEFORE_SPLIT.map((part) => part.name);
    expect(request("a7aa5e974")).toEqual(all);
    expect(request("2dbbedc52", true)).toEqual(all);
  });
});

// INF-2259's accepted complete-selection route: ordinary proof plus two edited-test
// passes on each device, using the existing real change fixtures and the live table.
describe("complete phone selection repeat accounting", () => {
  const all = PHONE_PARTS.map(({ name }) => name);
  const reached = (commit: string, unreadable = false) => {
    const { paths, testDiff, testFiles } = change(commit);
    return partReach(
      phoneDecision(paths).reasons,
      unreadable ? undefined : testDiff,
      Object.keys(testFiles),
      (path) => testFiles[path],
    );
  };

  it("counts ordinary coverage once and repeats only distance-zero parts", () => {
    const reach = reached("2dbbedc52");
    const plan = phoneRepeatPlan([...all].reverse(), reach);
    expect(plan.full).toBe(true);
    expect(plan.repeatParts).toEqual(
      reach.filter(({ distance }) => distance === 0).map(({ part }) => part),
    );
    expect(plan.repeatParts.length).toBeGreaterThan(0);
    expect(plan.repeatParts.length).toBeLessThan(all.length);
    for (const part of all) {
      expect(
        [all, plan.repeatParts, plan.repeatParts].filter((round) => round.includes(part)),
      ).toHaveLength(reach.find((each) => each.part === part)!.distance === 0 ? 3 : 1);
    }
  });

  it("keeps proper subsets on their existing local repeat route", () => {
    const reach = reached("2dbbedc52");
    expect(
      phoneRepeatPlan(
        reach.filter(({ distance }) => distance === 0).map(({ part }) => part),
        reach,
      ),
    ).toEqual({ full: false, repeatParts: [] });
  });

  it("retains every-part repetition for unreadable UI changes", () => {
    expect(phoneRepeatPlan(all, reached("2dbbedc52", true))).toEqual({
      full: true,
      repeatParts: all,
    });
  });

  it("does not repeat test parts for a shared product input alone", () => {
    expect(phoneRepeatPlan(all, reached("e3be41f53"))).toEqual({ full: true, repeatParts: [] });
  });
});

// INF-2125's direction C (the captain chose "Shared fixes, then short parts", within 10 minutes):
// an edit to one short test runs that test alone. The change is cd98a3e86, a real edit to the
// talk-drafts test; the times are the passing parts' per-device milliseconds in this branch's
// phone run 41271123700 on the Mac mini, Nov 1, before the parking cancelled its last parts.
const SHORT_TIMES = JSON.stringify({
  "join-read": { ipad: 386831, iphone: 463806 },
  "join-activity": { ipad: 132690, iphone: 126059 },
  "join-away": { ipad: 287296, iphone: 233462 },
  "talk-compose": { iphone: 337927, ipad: 419948 },
  "talk-tasks": { iphone: 202058, ipad: 221608 },
  "talk-drafts": { iphone: 315501, ipad: 318604 },
  "relaunch-first": { iphone: 346233, ipad: 322559 },
  "relaunch-second": { iphone: 327092, ipad: 354210 },
  "cards-merge": { iphone: 173914, ipad: 180185 },
});
describe("the short phone parts", () => {
  const { paths, testDiff, testFiles } = change("cd98a3e86");
  const reasons = phoneDecision(paths).reasons;
  const reach = partReach(reasons, testDiff, Object.keys(testFiles), (path) => testFiles[path]);
  it("runs only the short part whose test changed", () => {
    const placed = placeParts(reach, partTimes(SHORT_TIMES));
    expect(placed.filter((part) => part.kept).map((part) => part.part)).toEqual(["talk-drafts"]);
    expect((placed.find((part) => part.kept)?.minutes ?? Infinity) * 60_000).toBeLessThan(
      PHONE_BUDGET_MS,
    );
    expect(requestedParts(reasons, reach).map((part) => part.part)).toEqual(["talk-drafts"]);
  });
});
