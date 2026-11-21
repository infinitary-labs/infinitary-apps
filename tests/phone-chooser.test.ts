import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appScreenEdits,
  before,
  chooseRequest,
  deviceParts,
  diffHunks,
  GENERATED_CARD_WORDS,
  GENERATED_CONTRACT,
  generatedReach,
  ipadParts,
  iphoneOnlyParts,
  ownEdits,
  type PartReach,
  type PartTable,
  PHONE_BUDGET_MS,
  partFamily,
  partReach,
  partTimes,
  phoneDecision,
  phoneRepeatPlan,
  placeParts,
  type RequestSelection,
  requestBase,
  requestDevicePlan,
  requestedParts,
  requestJobs,
  requestPasses,
  swiftFunctions,
  UI_TESTS,
} from "../scripts/affected-phone";
import { PHONE_JOB_BUDGET_MS } from "../scripts/phone-deadlines";
import { phoneFileOwners, unownedPhoneFiles } from "../scripts/phone-part-owners";
import {
  devicePartNames,
  PHONE_DEVICES,
  PHONE_PART_TIMES,
  PHONE_PARTS,
  type PhoneDevice,
  type PhoneJob,
  partDevices,
  partOnMac,
  partSelection,
  phoneJobMs,
  phonePasses,
  readPhonePlan,
} from "../scripts/phone-test-plan";

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
    // INF-4241 removed the relaunch parts, so the table's relaunch part owns no file today and nothing reaches it.
    expect(request("2dbbedc52")).toEqual(
      BEFORE_SPLIT.map((part) => part.name).filter((part) => part !== "relaunch"),
    );
  });
  it("runs a smoke part for gate setup and all parts for an unreadable test diff", () => {
    const all = BEFORE_SPLIT.map((part) => part.name);
    expect(request("a7aa5e974")).toEqual(["join"]);
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
  // the change only reaches runs once, on the iPhone. INF-4241 piece 6: the iPad runs only the parts whose row names it.
  const onIpad = (part: string) => partDevices(part).includes("ipad");
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
      expect(count(part, "ipad")).toBe(distance === 0 && onIpad(part) ? 1 : 0);
    }
    expect(reach.some(({ distance }) => distance > 0)).toBe(true);
  });
  it("leaves the iPad nothing for a shared product input, and everything for an unreadable change", () => {
    const shared = runs(reached("e3be41f53"));
    const unreadable = runs(reached("2dbbedc52", true));
    for (const part of all) {
      expect([shared(part, "iphone"), shared(part, "ipad")]).toEqual([1, 0]);
      expect([unreadable(part, "iphone"), unreadable(part, "ipad")]).toEqual([
        3,
        onIpad(part) ? 1 : 0,
      ]);
    }
    // INF-2970's fix 1: phone.yml's iPad job reads these parts and ends before its gate with none.
    expect(ipadParts(all, iphoneOnlyParts(all, reached("e3be41f53")))).toEqual([]);
    expect(ipadParts(all, iphoneOnlyParts(all, reached("2dbbedc52", true)))).toEqual(
      devicePartNames("ipad"),
    );
  });
});

// INF-4241 piece 9 (the captain's "The middle rule: today's rule, plus the short Duo and iPad passes when the change
// edits the phone app's screens"): a change to a hand-written Swift file in the phone app's folder runs the iPad's and
// the Duo's whole short passes beside the iPhone's reached parts. The changes are real ones merged to main: the four in
// app-screens.json by their paths, read by git, and the recorded fixtures above with their test edits.
describe("the short Duo and iPad passes on a branch request", () => {
  const recorded = (
    JSON.parse(readFileSync("tests/fixtures/phone-changes/app-screens.json", "utf8")) as {
      changes: { commit: string; subject: string; paths: string[] }[];
    }
  ).changes;
  const pathsOf = (commit: string) =>
    recorded.find((each) => each.commit.startsWith(commit))?.paths ?? change(commit).paths;
  // The chooser's affected request for a change, as its main hands it to phone.yml: the iPhone's parts, the
  // device jobs, and the parts each other device's job runs.
  function request(commit: string) {
    const recordedChange = recorded.find((each) => each.commit.startsWith(commit));
    const { paths, testDiff, testFiles } = recordedChange
      ? { paths: recordedChange.paths, testDiff: "", testFiles: {} as Record<string, string> }
      : change(commit);
    const reasons = phoneDecision(paths).reasons;
    const reach = partReach(reasons, testDiff, Object.keys(testFiles), (path) => testFiles[path]);
    const parts = requestedParts(reasons, reach).map(({ part }) => part);
    const screens = appScreenEdits(paths).length > 0;
    const plan = requestDevicePlan(parts, reach, { screens });
    return {
      parts,
      ...plan,
      ipad: deviceParts("ipad", parts, plan.iphoneOnly, screens),
      duo: deviceParts("duo", parts, plan.iphoneOnly, screens),
    };
  }
  it("counts a hand-written Swift file in the app's folder, never a regenerated file or translated words", () => {
    // A card's web view beside the regenerated card words and card host.
    expect(appScreenEdits(pathsOf("a6c8f4334a"))).toEqual([
      "ios/Infinitary/InfinitaryApp/CardWebView.swift",
    ]);
    // The scene's stars, beside their regenerated scene data and an app-hosted test.
    expect(appScreenEdits(pathsOf("4d8b7b20e6"))).toEqual([
      "ios/Infinitary/InfinitaryApp/CharacterCatalog.swift",
      "ios/Infinitary/InfinitaryApp/PhoneFixedStars.swift",
    ]);
    // Translated words and the package's regenerated messages; regenerated hosts and Settings words alone.
    expect(appScreenEdits(pathsOf("c6212e4851"))).toEqual([]);
    expect(appScreenEdits(pathsOf("7ca44510bb"))).toEqual([]);
    expect(appScreenEdits(pathsOf("e3be41f53"))).toEqual([]);
    // A UI test edit is the parts' own test code, not the app's screens.
    expect(appScreenEdits(pathsOf("cd98a3e86"))).toEqual([]);
  });
  it("adds each other device's whole short pass when the change edits the app's screens", () => {
    // The stars change reaches only the rest part on the iPhone: INF-4326 moved the weak link checks out of the
    // app-hosted tests its regenerated test data sits beside.
    const stars = request("4d8b7b20e6");
    expect(stars.parts).toEqual(["rest"]);
    expect(stars.devices).toEqual(["duo", "ipad", "iphone"]);
    expect(stars.ipad).toEqual(devicePartNames("ipad"));
    expect(stars.duo).toEqual(devicePartNames("duo"));
    // The iPad's job runs each part of its short pass once; the iPhone's job runs only what the change reaches.
    expect(
      phonePasses(["ipad"], { parts: stars.ipad }).map(({ part, round }) => `${part} ${round}`),
    ).toEqual(devicePartNames("ipad").map((part) => `${part} 1`));
    expect(
      new Set(
        phonePasses(["iphone"], { parts: stars.parts, iphoneOnly: stars.iphoneOnly }).map(
          ({ part }) => part,
        ),
      ),
    ).toEqual(new Set(stars.parts));
    // A change reaching every part with the iPad's own parts left to the iPhone gets the short passes too.
    for (const commit of ["2dbbedc52", "a6c8f4334a"]) {
      const screens = request(commit);
      expect(screens.devices).toEqual(["duo", "ipad", "iphone"]);
      expect([screens.ipad, screens.duo]).toEqual([
        devicePartNames("ipad"),
        devicePartNames("duo"),
      ]);
    }
  });
  it("keeps today's rule for a change that edits no screen", () => {
    for (const commit of ["c6212e4851", "7ca44510bb", "e3be41f53", "cd98a3e86"]) {
      const plain = request(commit);
      expect(plain.parts.length).toBeGreaterThan(0);
      expect([plain.devices, plain.ipad, plain.duo]).toEqual([["iphone"], [], []]);
    }
  });
  it("never adds the short passes to a request that names its parts", () => {
    expect(requestDevicePlan(["weak-link"], [], { explicit: true, screens: true })).toEqual({
      iphoneOnly: [],
      devices: ["iphone"],
    });
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
  // INF-2811: the affected request for that edit runs the part three times on the iPhone in its one gate, so no
  // local phone check or second request is needed. INF-4241 piece 6: talk-drafts shows the iPad nothing of its own,
  // so its row names no iPad and the iPad runs none of it.
  it("runs the edited short part three times on the iPhone, and not on the iPad its row leaves out", () => {
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
    expect(partDevices("talk-drafts")).toEqual(["iphone"]);
    expect(jobs.map(({ device, part, round }) => `${device} ${part} ${round}`)).toEqual([
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
      named("testCardForm", "testLayoutFollowsTheFold", "testCharacterAndPastChoices"),
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
// runs it. Each path list is a real change merged to main, as git names its files; INF-4326 moved the weak link
// checks into a test target of the phone's package, run on the Mac, so a change to them names that file now.
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
      "ios/Infinitary/InfinitaryKit/Tests/PhoneWeakLinkTests/PhoneWeakLinkTests.swift",
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

  // INF-4326: the weak link checks no longer build with the app-hosted tests, so a shared app-hosted helper reaches
  // only the rest part.
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
    expect(distanceZero(paths).sort()).toEqual(["rest"]);
  });
});

// Approved cuts 1–4: real source files and recorded changes drive selection, not invented call graphs.
describe("the approved phone-check cuts", () => {
  // Secrets staging: its native approval and key-recovery checks belong to rest.
  // Regression: the new owner registry treated these real production files as unknown.
  it.for([
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/ApprovalKey.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSecrets.swift",
  ])("selects the existing Secrets checks without inventing edited tests for %s", (path) => {
    const reach = partReach([path], "", [], () => undefined);
    const parts = requestedParts([path], reach).map(({ part }) => part);
    expect(unownedPhoneFiles([path])).toEqual([]);
    expect(parts).toEqual(["rest"]);
    expect(phoneRepeatPlan(parts, reach).repeatParts).toEqual([]);
  });

  it("keeps the owners of shared production files and refuses missing ownership", () => {
    const shared = "ios/Infinitary/InfinitaryApp/PhoneStyle.swift";
    const file = readFileSync(shared, "utf8");
    expect(file.length).toBeGreaterThan(0);
    const reach = partReach([shared], "", [], () => undefined);
    expect(requestedParts([shared], reach).map(({ part }) => part)).toEqual(
      phoneFileOwners(shared),
    );
    expect(phoneFileOwners(shared)).toEqual(PHONE_PARTS.map(({ name }) => name));
    // Removing an actual file's owner is precisely the missing-owner failure.
    const moved = shared.replace("PhoneStyle", "PhoneStyleMoved");
    expect(unownedPhoneFiles([shared, moved])).toEqual([moved]);
    expect(
      requestedParts(
        [moved],
        partReach([moved], "", [], () => undefined),
      ),
    ).toHaveLength(PHONE_PARTS.length);
  });
  it("runs only a short smoke part for the real workflow-only change", () => {
    const recorded = change("a7aa5e974");
    const reach = partReach(recorded.paths, "", [], () => undefined);
    const parts = requestedParts(recorded.paths, reach).map(({ part }) => part);
    expect(parts).toEqual(["join-read"]);
    const packageTest = "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/TrustTests.swift";
    const packageReach = partReach([packageTest], "", [], () => undefined);
    expect(requestedParts([packageTest], packageReach).map(({ part }) => part)).toEqual([
      "join-read",
    ]);
    expect(requestDevicePlan(parts, reach)).toEqual({ iphoneOnly: parts, devices: ["iphone"] });
  });
  it("covers shared test helpers once but repeats an edit inside a test itself", () => {
    const recorded = JSON.parse(
      readFileSync("tests/fixtures/phone-changes/declaration-consumers.json", "utf8"),
    ) as Change & { parts: PartTable };
    const shared = "ios/Infinitary/InfinitaryUITests/PhoneWaits.swift";
    const source = recorded.testFiles[shared]!;
    const line =
      source.split("\n").findIndex((line) => line.startsWith("let phoneAnsweredFormPattern")) + 1;
    const diff = `diff --git a/${shared} b/${shared}\n--- a/${shared}\n+++ b/${shared}\n@@ -${line} +${line} @@\n-${source.split("\n")[line - 1]}\n+${source.split("\n")[line - 1]} \n`;
    expect(diffHunks(diff).get(shared)).toHaveLength(1);
    const reach = partReach(
      [shared],
      diff,
      Object.keys(recorded.testFiles),
      (path) => recorded.testFiles[path],
      recorded.parts,
    );
    const parts = requestedParts([shared], reach).map(({ part }) => part);
    expect(parts.length).toBeGreaterThan(1);
    expect(
      reach.filter(({ distance }) => distance === 0).every(({ repeat }) => repeat === false),
    ).toBe(true);
    expect(phoneRepeatPlan(parts, reach).repeatParts).toEqual([]);
    const short = change("cd98a3e86");
    const own = partReach(
      short.paths,
      short.testDiff,
      Object.keys(short.testFiles),
      (path) => short.testFiles[path],
    );
    expect(phoneRepeatPlan(["talk-drafts"], own).repeatParts).toEqual(["talk-drafts"]);
  });
  it("reproduces one named part on one device without adding repeat rounds", () => {
    const part = devicePartNames("ipad")[0]!;
    for (const device of ["iphone", "ipad"] as const) {
      const plan = requestDevicePlan([part], [], { explicit: true, device });
      expect(plan.devices).toEqual([device]);
      expect(phonePasses([device], { parts: [part] })).toEqual([{ part, device, round: 1 }]);
    }
  });
  // INF-4241 piece 6: a part whose row names no iPad, such as the screenless weak-link suite, runs on the iPhone
  // alone, for a request and the release alike, and a request for it on the iPad starts no job.
  it("runs a part the iPad's list leaves out on the iPhone alone, for requests and the release", () => {
    for (const part of ["weak-link", "cards-form"]) {
      expect(partDevices(part)).toEqual(["iphone"]);
      expect(requestDevicePlan([part], [], { explicit: true })).toEqual({
        iphoneOnly: [],
        devices: ["iphone"],
      });
      expect(requestDevicePlan([part], [], { explicit: true, device: "ipad" })).toEqual({
        iphoneOnly: [],
        devices: [],
      });
      expect(
        phonePasses(["iphone", "ipad"], { parts: [part] }).map(({ device }) => device),
      ).toEqual(["iphone"]);
    }
    expect(requestDevicePlan([], [])).toEqual({ iphoneOnly: [], devices: [] });
  });
  // INF-4241 piece 8 (the brief's "an every-part request passes on three devices", and the plan's full check of every
  // device as lanes from one build): a request of every part names one job of every device; a narrower one, or one
  // that names a device, keeps a job a device, the Duo's among them when a Duo part is kept.
  it("runs a request of every part as one job of every device, and a narrower one a job a device", () => {
    const every = PHONE_PARTS.map(({ name }) => name);
    expect(requestDevicePlan(every, [], { explicit: true }).devices).toEqual(["every"]);
    expect(requestDevicePlan(every, [], { explicit: true, device: "duo" }).devices).toEqual([
      "duo",
    ]);
    const fold = PHONE_PARTS.find((part) => partDevices(part.name).includes("duo"))!.name;
    expect(requestDevicePlan([fold], [], { explicit: true }).devices).toEqual(
      ["duo", "iphone", ...(partDevices(fold).includes("ipad") ? ["ipad"] : [])].sort(),
    );
  });
});

// Approved cut 2 also covers suite-owning parts, which contain more than one XCTest method.
it("repeats only the edited app-hosted test within the weak-link suite", () => {
  const path = "ios/Infinitary/InfinitaryKit/Tests/PhoneWeakLinkTests/PhoneWeakLinkTests.swift";
  const text = readFileSync(path, "utf8");
  const own = swiftFunctions(text)!.find(({ name }) => name.startsWith("test"))!;
  const line = text.split("\n")[own.start - 1]!;
  const after = text
    .split("\n")
    .map((value, at) => (at === own.start - 1 ? `${value} ` : value))
    .join("\n");
  const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${own.start} +${own.start} @@\n-${line}\n+${line} \n`;
  const reach = partReach([path], diff, [], () => after);
  expect(phoneRepeatPlan(["weak-link"], reach).repeatParts).toEqual(["weak-link"]);
  expect(reach.find(({ part }) => part === "weak-link")!.repeatTests).toEqual([
    `PhoneWeakLinkTests/PhoneWeakLinkTests/${own.name}`,
  ]);
  const renamed = `${own.name}Renamed`;
  const renamedLine = line.replace(own.name, renamed);
  const renameDiff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${own.start} +${own.start} @@\n-${line}\n+${renamedLine}\n`;
  const renamedReach = partReach([path], renameDiff, [], () => text.replace(line, renamedLine));
  expect(renamedReach.find(({ part }) => part === "weak-link")!.repeatTests).toEqual([
    `PhoneWeakLinkTests/PhoneWeakLinkTests/${renamed}`,
  ]);
});

// INF-3379 (the captain's "File the checked cuts" and "start the checked ones now in a single change"): the reach
// reader places a header, import, new file or overloaded helper on its own parts, a request reads the change from
// its branch's merge point with main, and the generated contract and card words reach only the parts whose files
// read the changed entries. The requests are the two on the captain's Mac CI panel, read by git: INF-1109's phone
// requests at f42c082a6 with base 9629ca0d1, 51 main commits behind their merge point ddbb01430, and INF-3137's at
// 46696b19b. The generated changes are main's commits that changed a generated file and no other every-part file,
// with every Swift file outside the UI tests that names a type the generated files declare; parts are today's.
type Recorded = {
  base: string;
  head: string;
  paths: string[];
  testDiff?: string;
  testFiles?: Record<string, string>;
  generated?: Record<string, { diff: string; after: string }>;
  sources?: Record<string, string>;
};
function recorded(file: string) {
  const { texts, cases } = JSON.parse(
    readFileSync(`tests/fixtures/phone-changes/inf-3379-${file}.json`, "utf8"),
  ) as { texts: Record<string, string>; cases: Record<string, Recorded> };
  const text = (files: Record<string, string> = {}) =>
    new Map(Object.entries(files).map(([path, id]) => [path, texts[id]!]));
  return { texts, cases, text };
}
function requested(name: string) {
  const { cases, text } = recorded("requests");
  const each = cases[name]!;
  const files = text(each.testFiles);
  const reasons = phoneDecision(each.paths).reasons;
  const reach = partReach(
    reasons,
    each.testDiff,
    [...files.keys()].filter((path) => path.startsWith(UI_TESTS)),
    (path) => files.get(path),
  );
  const parts = requestedParts(reasons, reach);
  return {
    reach,
    parts,
    repeats: phoneRepeatPlan(
      parts.map(({ part }) => part),
      parts,
    ).repeatParts,
  };
}
const EVERY_PART = PHONE_PARTS.map(({ name }) => name);

describe("INF-3379's recorded phone requests", () => {
  it("places INF-1109's new part files, their imports and extension lines on their own parts", () => {
    const { reach, parts, repeats } = requested("inf-1109-requested-base");
    // Before, the import, `extension PhoneJourney {` and closing lines of the two new files charged every part.
    expect(reach.some(({ why }) => /outside any/.test(why))).toBe(false);
    expect(repeats).not.toEqual(EVERY_PART);
    const own = (part: string) => reach.find((each) => each.part === part)!;
    expect(own("cards-place")).toMatchObject({
      distance: 0,
      repeat: true,
      repeatTests: ["InfinitaryUITests/PhoneJourney/testThreadKeepsItsPlace"],
    });
    expect(own("keyboard-ways-out")).toMatchObject({
      distance: 0,
      repeat: true,
      repeatTests: ["InfinitaryUITests/PhoneJourney/testKeyboardWaysOut"],
    });
    // Ordinary coverage stays as broad as the shared files make it.
    expect(parts.map(({ part }) => part)).toEqual(EVERY_PART);
  });

  it("reads INF-1109's request from its merge point with main, not its older base", () => {
    const { cases } = recorded("requests");
    const stale = cases["inf-1109-requested-base"]!;
    const point = cases["inf-1109-merge-point"]!.base;
    // git's own answers for these commits: the base is an ancestor of the merge point.
    const answers: Record<string, string> = {
      [`merge-base origin/main ${stale.head}`]: point,
      [`merge-base ${stale.base} ${stale.head}`]: stale.base,
      [`merge-base --is-ancestor ${stale.base} ${point}`]: "",
    };
    const git = (args: string[]) => {
      const answer = answers[args.join(" ")];
      if (answer === undefined) throw new Error(`git ${args.join(" ")} failed`);
      return `${answer}\n`;
    };
    expect(requestBase(stale.base, stale.head, git)).toEqual({ base: point, ignored: stale.base });
    // A base at the merge point stands, as does any base when git cannot read main.
    answers[`merge-base ${point} ${stale.head}`] = point;
    expect(requestBase(point, stale.head, git)).toEqual({ base: point });
    expect(
      requestBase("origin/main", stale.head, () => {
        throw new Error("no main");
      }),
    ).toEqual({ base: "origin/main" });
    // From the merge point, main's own phone files no longer count as the branch's edits.
    const fromPoint = requested("inf-1109-merge-point");
    expect(fromPoint.repeats).toEqual(["cards-media", "talk-compose", "rest"]);
    expect(requested("inf-1109-requested-base").repeats).toEqual(
      expect.arrayContaining(fromPoint.repeats),
    );
  });

  it("places INF-3137's edit to the overloaded verifyPhoneReadingColumn on its callers", () => {
    const { texts, cases } = recorded("requests");
    const journey = `${UI_TESTS}PhoneComposerJourney.swift`;
    // The branch removed one of main's two overloads, so the file it started from declared the name twice.
    const each = cases["inf-3137"]!;
    const started = before(
      texts[each.testFiles![journey]!],
      diffHunks(each.testDiff!).get(journey)!,
    );
    const declared = swiftFunctions(started)!.filter(
      ({ name }) => name === "verifyPhoneReadingColumn",
    );
    expect(declared).toHaveLength(2);
    const { reach, repeats } = requested("inf-3137");
    expect(reach.some(({ why }) => /ambiguous/.test(why))).toBe(false);
    expect(
      reach.filter(({ why }) => why.includes("verifyPhoneReadingColumn")).map(({ part }) => part),
    ).toEqual(["talk-compose"]);
    expect(repeats).toEqual(["cards-merge", "cards-form", "keyboard-scrolling", "talk-compose"]);
  });
});

describe("the generated contract and card words", () => {
  function generated(name: string) {
    const { cases, text, texts } = recorded("generated");
    const each = cases[name]!;
    const sources = text(each.sources);
    const reaches = new Map(
      Object.entries(each.generated!).map(([path, { diff, after }]) => [
        path,
        generatedReach(diff, texts[after], sources, path),
      ]),
    );
    const paths = [...reaches.keys()];
    const reach = partReach(paths, "", [], () => undefined, PHONE_PARTS, reaches);
    return { reaches, parts: requestedParts(paths, reach).map(({ part }) => part) };
  }

  it("reaches only the card parts for a new card words entry read by the card parts file", () => {
    // ee8f49c1d added PhoneCardWords.contributor, read only by PhoneCardParts.swift.
    const { reaches, parts } = generated("ee8f49c1d");
    expect(reaches.get(GENERATED_CARD_WORDS)).toEqual(
      phoneFileOwners(`ios/Infinitary/InfinitaryApp/PhoneCardParts.swift`),
    );
    expect(parts).toEqual(phoneFileOwners(`ios/Infinitary/InfinitaryApp/PhoneCardParts.swift`));
  });

  it("reaches the readers of a contract's new words and new type, and the package tests' part", () => {
    // e29423b30 added two PhoneTaskRowWords entries and the PhoneRowMoveWords type.
    const { reaches, parts } = generated("e29423b30");
    const readers = [
      "ios/Infinitary/InfinitaryApp/PhoneTasks.swift",
      "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneRowMoves.swift",
      "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/PhoneTaskListTests.swift",
    ];
    const owners = [...new Set(readers.flatMap(phoneFileOwners))];
    expect([...reaches.get(GENERATED_CONTRACT)!].sort()).toEqual([...owners].sort());
    expect(parts).not.toEqual(EVERY_PART);
  });

  it("reaches nothing for a change only to the generated header comment", () => {
    const { reaches, parts } = generated("fbb541793");
    expect(reaches.get(GENERATED_CONTRACT)).toEqual([]);
    expect(parts).toEqual(["join-read"]);
  });

  it("keeps every part when the change cannot be read", () => {
    const { cases, texts } = recorded("generated");
    const each = cases.e29423b30!;
    const after = texts[each.generated![GENERATED_CONTRACT]!.after]!;
    expect(generatedReach(undefined, after, new Map(), GENERATED_CONTRACT)).toBeUndefined();
    const reaches = new Map([[GENERATED_CONTRACT, undefined]]);
    const reach = partReach([GENERATED_CONTRACT], "", [], () => undefined, PHONE_PARTS, reaches);
    expect(requestedParts([GENERATED_CONTRACT], reach).map(({ part }) => part)).toEqual(EVERY_PART);
  });
});

// INF-4071 (the captain's "Only the change's own edits"): a phone re-run after a pass reads only the change's own edits
// since its last passing version. The versions are real ones, read by git: PR #1598's eight affected requests after its
// first pass on Nov 12 and 13, each passing, and fm/task-282b2e67's request after only being brought up to date. Each
// keeps its merge point with main and its zero-context `ios/` diff from there (`git diff -U0 --full-index --no-renames
// <merge point>...<version> -- ios/`); the expected files are the replay's own reading of the same requests.
describe("a phone re-run after a pass", () => {
  type Version = { commit: string; mergePoint: string; ios: string; run?: number };
  const { texts, pullRequest1598, rebaseOnly } = JSON.parse(
    readFileSync("tests/fixtures/phone-changes/inf-4071-reruns.json", "utf8"),
  ) as { texts: Record<string, string>; pullRequest1598: Version[]; rebaseOnly: Version[] };
  const since = (last: Version, now: Version) => ownEdits(texts[last.ios]!, texts[now.ios]!);
  // The parts the own edits reach; none of these edits a UI test, so no test file is read.
  const reached = (files: string[]) => {
    const { reasons } = phoneDecision(files);
    return requestedParts(
      reasons,
      partReach(reasons, "", [], () => undefined),
    ).map(({ part }) => part);
  };
  const app = "ios/Infinitary/InfinitaryApp";
  const kit = "ios/Infinitary/InfinitaryKit";

  it("reads an edit on the same base as the files it changed", () => {
    const [first, second, third] = pullRequest1598;
    expect(since(first!, second!)).toEqual([
      `${app}/CardLogView.swift`,
      "ios/Infinitary/InfinitaryUITests/PhoneJourney+CardsMedia.swift",
    ]);
    expect(since(second!, third!)).toEqual([`${app}/CardLogView.swift`]);
    expect(reached(since(second!, third!))).toEqual(phoneFileOwners(`${app}/CardLogView.swift`));
  });

  it("counts only the change's own edits after the branch was brought up to date", () => {
    const at = (index: number) => since(pullRequest1598[index - 1]!, pullRequest1598[index]!);
    // Each of these versions also brought the branch up to date, so main's own phone edits moved under it.
    for (const index of [3, 4, 5, 7])
      expect(pullRequest1598[index]!.mergePoint).not.toBe(pullRequest1598[index - 1]!.mergePoint);
    expect(at(3)).toEqual([`${app}/CardAssets/CardHost.generated.js`]);
    expect(at(4)).toEqual([`${app}/CardAssets/CardHost.generated.js`]);
    expect(at(5)).toEqual([
      "ios/Infinitary/CardRuntime/cardHost.ts",
      `${app}/CardAssets/CardHost.generated.js`,
    ]);
    expect(at(7)).toEqual([`${app}/CardAssets/CardHost.generated.js`]);
    for (const index of [3, 4, 5, 7]) {
      const parts = reached(at(index));
      expect(parts.length).toBeGreaterThan(0);
      expect(
        parts.every((part) => partFamily(part) === "cards"),
        parts.join(" "),
      ).toBe(true);
      expect(parts.length).toBeLessThan(EVERY_PART.length);
    }
  });

  it("still checks every part when the own edits change the phone's message files", () => {
    // The Nov 12 evening edit regenerated the phone's message files, which every part reads.
    const files = since(pullRequest1598[5]!, pullRequest1598[6]!);
    expect(files).toEqual([
      `${app}/CardLogView.swift`,
      `${kit}/Sources/InfinitaryKit/PhoneMessages.generated.swift`,
      `${kit}/Sources/InfinitaryKit/Resources/en.lproj/Localizable.strings`,
      `${kit}/Tests/InfinitaryKitTests/Fixtures/PhoneWords.generated.json`,
    ]);
    expect(reached(files)).toEqual(EVERY_PART);
  });

  it("runs no part after only bringing the branch up to date", () => {
    const [last, now] = rebaseOnly;
    expect(now!.mergePoint).not.toBe(last!.mergePoint);
    // The whole change still edits the phone's message files, which would check every part.
    expect(texts[now!.ios]).toContain("PhoneMessages.generated.swift");
    expect(since(last!, now!)).toEqual([]);
    expect(phoneDecision(since(last!, now!)).run).toBe(false);
  });

  it("counts a file the change no longer edits, since its version now is not the one that passed", () => {
    const [last, now] = rebaseOnly;
    const dropped = texts[now!.ios]!.split(/^(?=diff --git )/m).find((each) =>
      each.includes("Localizable.strings"),
    )!;
    expect(ownEdits(texts[last!.ios]!, texts[now!.ios]!.replace(dropped, ""))).toEqual([
      `${kit}/Sources/InfinitaryKit/Resources/en.lproj/Localizable.strings`,
    ]);
  });
});

// INF-5387's plan, piece 2 (the captain's "how can we make them last <30m at max", and the approved plan's "A unit
// test holds that the dealt jobs equal today's pass list exactly"): a manual request's passes are dealt into jobs of at
// most the job budget's recorded minutes. Today's pass list is what phone.yml's job of each device ran before: its gate
// step built arguments from the chooser's outputs, and scripts/test-phone.ts built the passes from them. Both are
// transcribed here as they stood, and the selections are the chooser's own for generated changes over the real part
// table.
describe("a request dealt into jobs", () => {
  const RECORDED = JSON.parse(readFileSync(PHONE_PART_TIMES, "utf8"));
  // phone.yml's gate step for one device job, before the request was dealt: the arguments it handed test-phone.
  function gateArguments(selection: RequestSelection, device: string): string[] {
    const env = {
      parts: selection.kept,
      iphoneParts: selection.iphoneOnly,
      // The job read the chooser's own parts for its device, its completeness and its further passes only when the
      // request named no parts ("Read the chosen parts" ran only then).
      deviceParts: selection.named
        ? []
        : device === "ipad"
          ? selection.ipadParts
          : device === "duo"
            ? selection.duoParts
            : [],
      full: !selection.named && selection.full,
      repeats: selection.named ? [] : selection.repeats,
    };
    let list = env.parts;
    let iphoneOnly = env.iphoneParts;
    if (env.deviceParts.length) [list, iphoneOnly] = [env.deviceParts, []];
    let parts = list.flatMap((part) => [
      iphoneOnly.includes(part) ? "--iphone-part" : "--part",
      part,
    ]);
    if (env.full && !env.iphoneParts.length) parts = [];
    for (const part of env.repeats) parts.push("--repeat-part", part);
    if (Object.keys(selection.repeatTests).length)
      parts.push("--repeat-tests", JSON.stringify(selection.repeatTests));
    return [...(device === "every" ? ["--every-device"] : ["--device", device]), ...parts];
  }
  // scripts/test-phone.ts's passes from those arguments.
  function gatePasses(args: string[]): PhoneJob[] {
    const values = (flag: string) =>
      args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
    const devices: PhoneDevice[] = args.includes("--every-device")
      ? [...PHONE_DEVICES]
      : (values("--device") as PhoneDevice[]);
    const named = values("--part").length > 0 || values("--iphone-part").length > 0;
    return phonePasses(devices, {
      parts: named ? values("--part") : PHONE_PARTS.map((part) => part.name),
      iphoneOnly: values("--iphone-part"),
      repeats: values("--repeat-part"),
      repeatTests: JSON.parse(values("--repeat-tests")[0] ?? "{}"),
    });
  }
  // The job of each device the chooser named ran its gate only when it had parts (the scope step).
  const todaysPasses = (selection: RequestSelection) =>
    selection.devices
      .filter(
        (device) =>
          selection.named ||
          device === "every" ||
          device === "iphone" ||
          (device === "ipad" ? selection.ipadParts : selection.duoParts).length,
      )
      .flatMap((device) => gatePasses(gateArguments(selection, device)));
  const names = (passes: readonly PhoneJob[]) => passes.map((pass) => JSON.stringify(pass)).sort();
  // A small deterministic generator, so a failure names its selection again on every run.
  function* selections(count: number): Generator<{ label: string; selection: RequestSelection }> {
    let seed = 5387;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const every = PHONE_PARTS.map((part) => part.name);
    const repeatable = every.filter((part) => !partOnMac(part));
    for (let index = 0; index < count; index++) {
      const all = next() < 0.15;
      const kept = all ? every : every.filter(() => next() < 0.2);
      const reach = kept.map((part) => {
        const edited = repeatable.includes(part) && next() < 0.3;
        return {
          part,
          distance: edited ? 0 : next() < 0.5 ? 1 : 2,
          why: edited ? "its test code changed" : "the change reaches it",
          // A test the part runs by name, as the chooser names an edited test.
          ...(edited && next() < 0.3
            ? {
                repeatTests: partSelection(part)
                  .filter((arg) => arg.startsWith("-only-testing:"))
                  .map((arg) => arg.slice("-only-testing:".length)),
              }
            : {}),
        } as PartReach;
      });
      const mode = next();
      const explicit = mode < 0.25;
      const named = explicit && mode < 0.15 && kept.length > 0;
      const device = next() < 0.2 ? PHONE_DEVICES[Math.floor(next() * PHONE_DEVICES.length)]! : "";
      const screens = !explicit && next() < 0.3;
      yield {
        label: JSON.stringify({ kept, explicit, named, device, screens }),
        selection: chooseRequest(kept, explicit ? [] : reach, { explicit, named, device, screens }),
      };
    }
  }
  it("deals exactly today's passes, none lost and none doubled, over generated selections", () => {
    let dealtRequests = 0;
    for (const { label, selection } of selections(300)) {
      const today = todaysPasses(selection);
      expect(names(requestPasses(selection)), label).toEqual(names(today));
      const jobs = requestJobs(selection, RECORDED);
      expect(names(jobs.flatMap((job) => job.passes)), label).toEqual(names(today));
      // Each job's gate reads its passes back whole.
      for (const job of jobs)
        expect(readPhonePlan(JSON.stringify(job.passes)), label).toEqual(job.passes);
      if (jobs.length > 1) dealtRequests++;
    }
    // The generated selections include requests dealt into several jobs, not only single ones.
    expect(dealtRequests).toBeGreaterThan(10);
  });
  it("deals today's complete request into as few jobs of the job budget as it needs", () => {
    const complete = chooseRequest(EVERY_PART, [], { explicit: true });
    const jobs = requestJobs(complete, RECORDED);
    for (const job of jobs)
      expect(phoneJobMs(job.passes, RECORDED)).toBeLessThanOrEqual(PHONE_JOB_BUDGET_MS);
    for (const [at, job] of jobs.entries())
      for (const other of jobs.slice(at + 1))
        expect(phoneJobMs([...job.passes, ...other.passes], RECORDED)).toBeGreaterThan(
          PHONE_JOB_BUDGET_MS,
        );
    expect(jobs.map((job) => job.key)).toEqual(jobs.map((_, index) => `job-${index + 1}`));
    // The Mac part reuses the package tests' build, so it rides the first job, which runs them.
    expect(jobs[0]!.passes.some((pass) => partOnMac(pass.part))).toBe(true);
    expect(jobs[0]!.label).toMatch(new RegExp(`^job 1 of ${jobs.length}: `));
  });
});
