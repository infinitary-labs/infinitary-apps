import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  iphoneOnlyParts,
  type PartTable,
  PHONE_BUDGET_MS,
  partReach,
  partTimes,
  phoneDecision,
  phoneRepeatPlan,
  placeParts,
  requestedParts,
  UI_TESTS,
} from "../scripts/affected-phone";
import { PHONE_PARTS, phonePasses } from "../scripts/phone-test-plan";

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

// INF-2259's accepted route: ordinary proof plus two edited-test passes on the iPhone (INF-2732),
// using the existing real change fixtures and the live table. INF-2811: a proper subset takes them
// in the same request too, since a computer in CI mode cannot run a local phone check.
describe("phone selection repeat accounting", () => {
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

  it("repeats a proper subset's edited parts, and only them, in the same request", () => {
    const reach = reached("2dbbedc52");
    const edited = reach.filter(({ distance }) => distance === 0).map(({ part }) => part);
    const reachedOnly = reach.find(({ distance }) => distance === 1)!.part;
    expect(edited.length).toBeGreaterThan(0);
    expect(phoneRepeatPlan([reachedOnly, ...edited], reach)).toEqual({
      full: false,
      repeatParts: edited,
    });
    expect(phoneRepeatPlan([reachedOnly], reach)).toEqual({ full: false, repeatParts: [] });
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

  // INF-2582 (the captain's "iPhone only; iPad waits for the release check"): the gate the chooser's
  // outputs start, on the same real changes. An edited part runs three times on the iPhone and once on the iPad (INF-2732); a part
  // the change only reaches runs once, on the iPhone.
  const runs = (reach: ReturnType<typeof reached>) => {
    const iphoneOnly = iphoneOnlyParts(all, reach);
    const jobs = phonePasses(["iphone", "ipad"], {
      parts: all.filter((part) => !iphoneOnly.includes(part)),
      iphoneOnly,
      repeats: phoneRepeatPlan(all, reach).repeatParts,
    });
    return (part: string, device: string) =>
      jobs.filter((job) => job.part === part && job.device === device).length;
  };
  it("runs reached parts on the iPhone alone and edited parts three times on the iPhone and once on the iPad", () => {
    const reach = reached("2dbbedc52");
    const count = runs(reach);
    for (const { part, distance } of reach) {
      expect(count(part, "iphone")).toBe(distance === 0 ? 3 : 1);
      expect(count(part, "ipad")).toBe(distance === 0 ? 1 : 0);
    }
    expect(reach.some(({ distance }) => distance > 0)).toBe(true);
  });
  it("leaves the iPad nothing for a shared product input, and everything for an unreadable change", () => {
    const shared = runs(reached("e3be41f53"));
    const unreadable = runs(reached("2dbbedc52", true));
    for (const part of all) {
      expect([shared(part, "iphone"), shared(part, "ipad")]).toEqual([1, 0]);
      expect([unreadable(part, "iphone"), unreadable(part, "ipad")]).toEqual([3, 1]);
    }
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
  // INF-2811: the affected request for that edit runs the part three times on the iPhone and once
  // on the iPad in its one gate, so no local phone check or second request is needed.
  it("runs the edited short part three times on the iPhone and once on the iPad in one request", () => {
    const parts = requestedParts(reasons, reach).map(({ part }) => part);
    const plan = phoneRepeatPlan(parts, reach);
    expect(plan).toEqual({ full: false, repeatParts: ["talk-drafts"] });
    const iphoneOnly = iphoneOnlyParts(parts, reach);
    expect(iphoneOnly).toEqual([]);
    const jobs = phonePasses(["iphone", "ipad"], {
      parts: parts.filter((part) => !iphoneOnly.includes(part)),
      iphoneOnly,
      repeats: plan.repeatParts,
    });
    expect(jobs.map(({ device, part, round }) => `${device} ${part} ${round}`)).toEqual([
      "ipad talk-drafts 1",
      "iphone talk-drafts 1",
      "iphone talk-drafts 2",
      "iphone talk-drafts 3",
    ]);
  });
});

// INF-2257: approved “Narrower selection only; retain local repeats”. These mutations
// replay declarations and consumers captured from the real UI tests, not invented call graphs.
describe("declaration-aware phone selection", () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/phone-changes/declaration-consumers.json", "utf8"),
  ) as {
    testFiles: Record<string, string>;
    parts: PartTable;
  };
  const waits = "ios/Infinitary/InfinitaryUITests/PhoneWaits.swift";
  const keys = "ios/Infinitary/InfinitaryUITests/PhoneKeys.swift";
  const all = fixture.parts.map((part) => part.name);
  const patternParts = fixture.parts
    .filter((part) => part.name === "cards" || part.name === "rest")
    .map((part) => part.name);
  type Edit = { path: string; old: string; next: string };
  function selection(
    edits: Edit[],
    unreadable?: string,
    source = fixture.testFiles,
    parts: PartTable = fixture.parts,
  ) {
    const files = { ...source };
    let diff = "";
    for (const path of new Set(edits.map((edit) => edit.path))) {
      const original = files[path]!;
      let next = original;
      for (const edit of edits.filter((edit) => edit.path === path)) {
        expect(next.split(edit.old)).toHaveLength(2);
        next = next.replace(edit.old, edit.next);
      }
      files[path] = next;
      const oldLines = original.split("\n");
      const newLines = next.split("\n");
      diff += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
      // Independent, line-preserving replacements keep unrelated tests out of the diff.
      if (oldLines.length === newLines.length) {
        for (let at = 0; at < oldLines.length; at++)
          if (oldLines[at] !== newLines[at])
            diff += `@@ -${at + 1} +${at + 1} @@\n-${oldLines[at]}\n+${newLines[at]}\n`;
      } else {
        let start = 0;
        while (oldLines[start] === newLines[start]) start++;
        let oldEnd = oldLines.length;
        let newEnd = newLines.length;
        while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
          oldEnd--;
          newEnd--;
        }
        diff += `@@ -${start + 1},${oldEnd - start} +${newEnd === start ? start : start + 1},${newEnd - start} @@\n`;
        diff += oldLines
          .slice(start, oldEnd)
          .map((line) => `-${line}\n`)
          .join("");
        diff += newLines
          .slice(start, newEnd)
          .map((line) => `+${line}\n`)
          .join("");
      }
    }
    const paths = [...new Set(edits.map((edit) => edit.path))];
    const reach = partReach(
      paths,
      diff,
      Object.keys(files),
      (path) => (path === unreadable ? undefined : files[path]),
      parts,
    );
    return requestedParts(paths, reach).map((part) => part.part);
  }
  const pattern = fixture.testFiles[waits]!.split("\n").find((line) =>
    line.startsWith("let phoneAnsweredFormPattern"),
  )!;

  it("keeps INF-1973 broad because the real photo-readiness change also edits common waits", () => {
    const recorded = change("declaration-consumers");
    const reach = partReach(
      recorded.paths,
      recorded.testDiff,
      Object.keys(recorded.testFiles),
      (path) => recorded.testFiles[path],
      fixture.parts,
    );
    expect(requestedParts(recorded.paths, reach).map((part) => part.part)).toEqual(all);
    expect(reach.every((part) => part.distance === 0)).toBe(true);
  });

  it("follows a literal constant through the form helper to Cards and the unnamed tests in Rest", () => {
    expect(
      selection([
        { path: waits, old: pattern, next: pattern.replace("answered", "answered|complete") },
      ]),
    ).toEqual(patternParts);
  });

  it("keeps old consumers when the constant is deleted, and new consumers when it is added", () => {
    expect(selection([{ path: waits, old: `${pattern}\n`, next: "" }])).toEqual(patternParts);
    // Reverse the real source snapshot to model an added declaration with existing consumers.
    const removed = fixture.testFiles[waits]!.replace(`${pattern}\n`, "");
    const saved = fixture.testFiles[waits]!;
    fixture.testFiles[waits] = removed;
    try {
      const anchor = "@MainActor func waitForAnsweredPhoneForm";
      expect(selection([{ path: waits, old: anchor, next: `${pattern}\n${anchor}` }])).toEqual(
        patternParts,
      );
    } finally {
      fixture.testFiles[waits] = saved;
    }
  });

  it("unions old and new references when a declaration is renamed", () => {
    expect(
      selection([
        { path: waits, old: "let phoneAnsweredFormPattern", next: "let phoneCompletedFormPattern" },
        {
          path: waits,
          old: '"label MATCHES %@", phoneAnsweredFormPattern',
          next: '"label MATCHES %@", phoneCompletedFormPattern',
        },
      ]),
    ).toEqual(patternParts);
  });

  it("narrows real photo enum and struct declarations to their Talk and Rest consumers", () => {
    const path = "ios/Infinitary/InfinitaryUITests/PhoneComposerJourney.swift";
    const parts = fixture.parts
      .filter((part) => part.name === "talk" || part.name === "rest")
      .map((part) => part.name);
    expect(
      selection([
        {
          path,
          old: "enum PhonePhotoOutcome: String { case selected, preview, settled }",
          next: "enum PhonePhotoOutcome: String { case selected, preview, settled, cancelled }",
        },
      ]),
    ).toEqual(parts);
    expect(
      selection([
        {
          path,
          old: "    private var steady = PhoneSteadyReading<PhoneTargetReading>()",
          next: "    private var steady = PhoneSteadyReading<PhoneTargetReading>() ",
        },
      ]),
    ).toEqual(parts);
  });

  it("follows type references in signatures and generic uses to the shared target wait", () => {
    expect(
      selection([{ path: waits, old: "    let drawn: Data?", next: "    let drawn: Data? " }]),
    ).toEqual(all);
    expect(
      selection([
        {
          path: waits,
          old: "    private var last: Reading?",
          next: "    private var last: Reading? ",
        },
      ]),
    ).toEqual(all);
  });

  it("retains full coverage for executable global setup, unsupported declarations and duplicate names", () => {
    expect(
      selection([{ path: waits, old: pattern, next: pattern.replace(/= .*/, "= loadPattern()") }]),
    ).toEqual(all);
    expect(selection([{ path: waits, old: pattern, next: `${pattern}\n${pattern}` }])).toEqual(all);
    expect(
      selection([
        {
          path: waits,
          old: pattern,
          next: `${pattern}\nlet setupPattern = phoneAnsweredFormPattern`,
        },
      ]),
    ).toEqual(all);
    expect(
      selection([{ path: waits, old: pattern, next: `${pattern}\nextension String {}` }]),
    ).toEqual(all);
  });

  it("keeps conditional compilation and malformed source conservative", () => {
    expect(
      selection([{ path: waits, old: pattern, next: `#if DEBUG\n${pattern}\n#endif` }]),
    ).toEqual(all);
    expect(selection([{ path: waits, old: pattern, next: `/* ${pattern}` }])).toEqual(all);
    expect(
      selection([
        {
          path: waits,
          old: "struct PhoneSteadyReading<Reading: Equatable> {",
          next: "struct PhoneSteadyReading<Reading: Equatable> {{",
        },
      ]),
    ).toEqual(all);
  });

  it("treats XCTest observation callbacks as shared setup, not ordinary Rest-only tests", () => {
    expect(
      selection([
        {
          path: keys,
          old: "        guard issue.isFailure else { return }",
          next: "        guard issue.isFailure else { return } ",
        },
      ]),
    ).toEqual(all);
  });

  it("retains full coverage when an unchanged dependency is unreadable", () => {
    expect(selection([{ path: waits, old: pattern, next: `${pattern} ` }], keys)).toEqual(all);
  });

  it("uses the live short-part table for focused declarations and shared target types", () => {
    const files = Object.fromEntries(
      readdirSync(UI_TESTS)
        .filter((name) => name.endsWith(".swift"))
        .map((name) => [UI_TESTS + name, readFileSync(UI_TESTS + name, "utf8")]),
    );
    const live = (edits: Edit[]) => selection(edits, undefined, files, PHONE_PARTS);
    const named = (...tests: string[]) =>
      PHONE_PARTS.filter((part) => "test" in part && tests.includes(part.test)).map(
        (part) => part.name,
      );
    const pattern = files[waits]!.split("\n").find((line) =>
      line.startsWith("let phoneAnsweredFormPattern"),
    )!;
    expect(live([{ path: waits, old: pattern, next: `${pattern} ` }])).toEqual(
      named("testCardForm", "testCharacterAndPastChoices"),
    );
    const path = UI_TESTS + "PhoneComposerJourney.swift";
    const outcome = files[path]!.split("\n").find((line) =>
      line.startsWith("enum PhonePhotoOutcome"),
    )!;
    expect(live([{ path, old: outcome, next: `${outcome} ` }])).toEqual(
      named("testComposeAndSend", "testCharacterAndPastChoices"),
    );
    const picker = files[path]!.split("\n").find((line) =>
      line.includes("func pickPhoneJourneyPhoto("),
    )!;
    // Rest calls recoverPhonePhoto directly; only composing calls the picker helper.
    expect(live([{ path, old: picker, next: `${picker} ` }])).toEqual(named("testComposeAndSend"));
    // A declaration every journey test reaches selects every part that runs UI test code; the weak-link part
    // runs only its app-hosted class (INF-2989).
    expect(
      live([{ path: waits, old: "    let drawn: Data?", next: "    let drawn: Data? " }]),
    ).toEqual(PHONE_PARTS.filter((part) => "test" in part).map((part) => part.name));
  });

  it("keeps edited tests unconditional even when their names have no named part", () => {
    const path = "ios/Infinitary/InfinitaryUITests/PhoneWaitsTests.swift";
    const test = fixture.testFiles[path]!.split("\n").find((line) => line.includes("func test"))!;
    expect(selection([{ path, old: test, next: `${test} ` }])).toEqual(["rest"]);
  });
});

// INF-2989 (the captain's "find what doubled the rest part and shorten it without weakening a test"): the weak
// link checks run as a part of their own, so a change to one app-hosted test class repeats only the part that
// runs it. Each path list is a real change merged to main, as git names its files.
describe("app-hosted test changes", () => {
  const distanceZero = (paths: string[]) =>
    partReach(phoneDecision(paths).reasons, "", [], () => undefined)
      .filter(({ distance }) => distance === 0)
      .map(({ part }) => part);

  it("repeats only the weak-link part for a change to the weak link checks", () => {
    // 535182aab: keep a slow device connected while a long catch-up arrives.
    const paths = [
      "docs/connection.md",
      "docs/ios.md",
      "ios/Infinitary/InfinitaryTests/PhoneWeakLinkTests.swift",
      "release-notes/changes/phone-slow-catch-up.json",
      "src/core/connection/connection.test.ts",
      "src/core/connection/connection.ts",
      "src/core/connection/outbox.test.ts",
      "src/core/connection/outbox.ts",
      "tests/helpers/phoneHome.ts",
    ];
    expect(distanceZero(paths)).toEqual(["weak-link"]);
  });

  it("repeats only the rest part for a change to another app-hosted test class", () => {
    // 9687d5ac4: catch up in one step when the app reopens.
    const paths = [
      "docs/ios.md",
      "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneWork.swift",
      "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/ReadOnlySession.swift",
      "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/PhoneBoardTests.swift",
      "ios/Infinitary/InfinitaryTests/PhoneCatchUpTests.swift",
      "release-notes/changes/phone-reopen-one-step-catch-up.json",
      "tests/helpers/phoneHome.ts",
    ];
    expect(distanceZero(paths)).toEqual(["rest"]);
  });

  it("repeats every part that runs app-hosted tests for a change to a shared app-hosted helper", () => {
    // 0fb8df67c: draw the crew scene on its own render thread, which edited the shared SceneCanvas.swift.
    const paths = [
      "docs/ios.md",
      "ios/Infinitary/InfinitaryApp/CharacterGarnish.swift",
      "ios/Infinitary/InfinitaryApp/CharacterSky.swift",
      "ios/Infinitary/InfinitaryApp/CharacterWarp.swift",
      "ios/Infinitary/InfinitaryApp/PhoneCharacter.swift",
      "ios/Infinitary/InfinitaryApp/PhoneCrewPainter.swift",
      "ios/Infinitary/InfinitaryApp/PhoneCrewScene.swift",
      "ios/Infinitary/InfinitaryApp/PhoneSceneRenderer.swift",
      "ios/Infinitary/InfinitaryApp/PhoneSceneRoster.swift",
      "ios/Infinitary/InfinitaryApp/PhoneSceneTouches.swift",
      "ios/Infinitary/InfinitaryApp/ScenePen.swift",
      "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneFrame.swift",
      "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/ReadOnlySession.swift",
      "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/PhoneFrameTests.swift",
      "ios/Infinitary/InfinitaryTests/PhoneOrbitSeatsTests.swift",
      "ios/Infinitary/InfinitaryTests/PhoneSceneRosterTests.swift",
      "ios/Infinitary/InfinitaryTests/SceneCanvas.swift",
      "release-notes/changes/phone-scene-own-thread.json",
    ];
    expect(distanceZero(paths).sort()).toEqual(["rest", "weak-link"]);
  });
});
