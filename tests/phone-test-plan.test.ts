import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  devicePhotos,
  PHONE_PARTS,
  partIdentifier,
  partRunsJourney,
  partSelection,
  partTestStarted,
  phoneAnimationWaits,
  phoneExecutionArguments,
  phoneJobs,
  phonePasses,
  RELAUNCH_PAIRS_PER_PART,
  relaunchPairs,
  runDeviceLanes,
  runSideBySide,
  testHomeKeys,
} from "../scripts/phone-test-plan";

// INF-662 piece 1 (the captain's "Approve and build"): one build serves the iPhone and the
// iPad at once, so each device's copy of the built test plan must name its own test home.
// The fixture is Xcode 26.4's actual plan for this scheme, read as JSON, trimmed to the
// fields this reads and the targets' names.
const built = JSON.parse(readFileSync("tests/fixtures/phone-test-plan/xcode-26.4.json", "utf8"));

describe("the phone check's built test plan", () => {
  it("names PHONE_TEST_HOME in both the app-hosted and the UI test targets", () => {
    expect(testHomeKeys(built).sort()).toEqual([
      "InfinitaryTests.EnvironmentVariables.PHONE_TEST_HOME",
      "InfinitaryUITests.EnvironmentVariables.PHONE_TEST_HOME",
    ]);
  });
  it("refuses a plan where the scheme no longer passes a test home", () => {
    const without = structuredClone(built);
    for (const target of ["InfinitaryTests", "InfinitaryUITests"])
      delete without[target].EnvironmentVariables.PHONE_TEST_HOME;
    expect(() => testHomeKeys(without)).toThrow(/no PHONE_TEST_HOME/);
  });
});

// INF-662 piece 2 (the captain's "Both at once, journey in parts"): the journey's four parts run
// side by side, each from its own simulator, and every check the single journey made stays.
// Every test the build has: Xcode 27.1's -enumerate-tests of the phone check's own build of the
// scheme (INF-2625, which retired testCards, testJoinAndRecover and testTalkAndTasks from it).
const everyTest: string[] = JSON.parse(
  readFileSync("tests/fixtures/phone-test-plan/xcode-27.1-tests.json", "utf8"),
);
// xcodebuild's -only-testing and -skip-testing name a target, a class or a test, matched whole.
const chosen = (selection: string[], test: string) => {
  const names = (kind: string) =>
    selection.filter((arg) => arg.startsWith(kind)).map((arg) => arg.slice(kind.length));
  const named = (identifier: string) => test === identifier || test.startsWith(`${identifier}/`);
  const only = names("-only-testing:");
  return (only.length === 0 || only.some(named)) && !names("-skip-testing:").some(named);
};
// The table's first two parts, which the side-by-side runs below fail and stop on.
const [first, second] = PHONE_PARTS.map((part) => part.name);
const partsRunning = (test: string) =>
  PHONE_PARTS.filter((part) => chosen(partSelection(part.name), test)).map((part) => part.name);

describe("the phone journey's parts", () => {
  it("run every test the build has exactly once, each journey test in its own part", () => {
    expect(everyTest.length).toBeGreaterThan(PHONE_PARTS.length);
    for (const test of everyTest) expect(partsRunning(test), test).toHaveLength(1);
    for (const part of PHONE_PARTS) expect(partsRunning(partIdentifier(part))).toEqual([part.name]);
    // INF-2989: the weak link checks run in their own part, every one of them and only there.
    const weakLink = everyTest.filter((test) =>
      test.startsWith("InfinitaryTests/PhoneWeakLinkTests/"),
    );
    expect(weakLink.length).toBeGreaterThan(0);
    for (const test of weakLink) expect(partsRunning(test), test).toEqual(["weak-link"]);
    // The other app-hosted tests ride with the rest part.
    expect(
      partsRunning("InfinitaryTests/RecoveryTests/testMissingCertificateReusesTheStoredKey"),
    ).toEqual(["rest"]);
  });
  // INF-2625's phone guard: a part names a test the build has, so no part selects nothing.
  it("name only tests the build has", () => {
    for (const part of PHONE_PARTS) {
      const identifier = partIdentifier(part);
      expect(
        everyTest.filter((test) => test === identifier || test.startsWith(`${identifier}/`)),
        part.name,
      ).not.toHaveLength(0);
    }
  });
  // INF-2625's phone guard: XCTest passes a selection that matched no test, so the gate reads that the
  // part's own test started. The log is the iPhone's join-read part in the 0.8.0 phone release check.
  it("start their own journey test, read from XCTest's own lines", () => {
    const joinRead = readFileSync(
      "tests/fixtures/phone-test-plan/join-read-xcodebuild.log",
      "utf8",
    );
    expect(partTestStarted("join-read", joinRead)).toBe(true);
    expect(partTestStarted("cards-form", joinRead)).toBe(false);
    expect(partTestStarted("rest", joinRead)).toBe(false);
    expect(
      partTestStarted("join-read", joinRead.replaceAll("PhoneJourney", "PhoneJourneyParts")),
    ).toBe(false);
    // INF-2989: a part that runs a whole class reads the class's own "Test Suite ... started" line. The log is the
    // weak link class in the iPad's rest part of phone run 42391213188, before it had a part of its own.
    const weakLink = readFileSync(
      "tests/fixtures/phone-test-plan/rest-weak-link-xcodebuild.log",
      "utf8",
    );
    expect(partTestStarted("weak-link", weakLink)).toBe(true);
    expect(partTestStarted("weak-link", joinRead)).toBe(false);
    expect(partTestStarted("join-read", weakLink)).toBe(false);
    // It drives no UI, so the gate does not ask it for the journeys' animation-wait line.
    expect(
      PHONE_PARTS.filter((part) => !partRunsJourney(part.name)).map((part) => part.name),
    ).toEqual(["weak-link"]);
    expect(() => partTestStarted("everything", joinRead)).toThrow(
      /No phone journey part is named everything/,
    );
  });
  it("still runs a test no part names, such as a new or renamed one", () => {
    expect(partsRunning("InfinitaryUITests/PhoneJourney/testSomethingNew")).toEqual(["rest"]);
    expect(partsRunning("InfinitaryUITests/PhoneSettingsJourney/testSettings")).toEqual(["rest"]);
  });
  // INF-1438: each part in the table's start order, on the slower iPad first.
  // INF-2052: the parts that choose a photo run last on each device, so a held library photo holds no part before them.
  it("starts each part on the iPad, then the iPhone, the parts that choose a photo last", () => {
    expect(phoneJobs(["iphone", "ipad"]).map(({ device, part }) => `${device} ${part}`)).toEqual(
      PHONE_PARTS.flatMap((part) => [`ipad ${part.name}`, `iphone ${part.name}`]),
    );
    const photos = (part: string) => PHONE_PARTS.find((each) => each.name === part)!.photos;
    const order = phoneJobs(["iphone"]).map(({ part }) => photos(part));
    expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)));
    expect(phoneJobs(["iphone"], ["cards-form"])).toEqual([
      { device: "iphone", part: "cards-form" },
    ]);
    expect(() => phoneJobs(["iphone"], ["everything"])).toThrow(
      /No phone journey part is named everything/,
    );
  });
});

describe("running the parts side by side", () => {
  it("runs every part once, no more at a time than the simulators allow, and a failure stops none", async () => {
    let running = 0;
    let most = 0;
    const ran: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"]);
    const outcome = runSideBySide(jobs, 3, async ({ device, part }) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      ran.push(`${device} ${part}`);
      if (part === first) throw new Error(`${device} ${first} failed`);
      return part;
    });
    await expect(outcome).rejects.toThrow(`${first} failed`);
    expect(most).toBe(3);
    expect(ran.sort()).toEqual(jobs.map(({ device, part }) => `${device} ${part}`).sort());
  });
  // INF-1343 (the captain's "Stop a failing pull request check at its first failed part").
  it("stops the running parts and starts no other once a part fails, when asked to", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"]);
    const outcomes = await runSideBySide(
      jobs,
      3,
      async ({ device, part }, stopping) => {
        const name = `${device} ${part}`;
        started.push(name);
        if (name === `iphone ${first}`) return { name, failed: true };
        // A running part ends when the gate stops it, as an interrupted part does.
        await new Promise((resolve) => stopping.addEventListener("abort", resolve, { once: true }));
        stopped.push(name);
        return { name, failed: false };
      },
      ({ failed }) => failed,
    );
    expect(started).toEqual([`ipad ${first}`, `iphone ${first}`, `ipad ${second}`]);
    expect(stopped.sort()).toEqual([`ipad ${first}`, `ipad ${second}`].sort());
    expect(outcomes.filter(Boolean).map((outcome) => outcome!.name)).toEqual(started);
    expect(outcomes.slice(started.length)).toEqual(jobs.slice(started.length).map(() => undefined));
  });
  it("refuses to run with no simulator", async () => {
    await expect(runSideBySide(phoneJobs(["iphone"]), 0, async () => 0)).rejects.toThrow(
      /at least one simulator/,
    );
  });
});

// INF-1438 (the captain's "Start each simulated device once per phone check, not once per part"): a
// device's parts run one after the other on the one simulator its lane starts, the lanes side by side.
describe("running each device's parts on one started device", () => {
  type Job = { device: "iphone" | "ipad"; part: string };
  const name = ({ device, part }: Job) => `${device} ${part}`;
  it("starts each device once, runs its parts in order on it and ends it after the last", async () => {
    const events: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"]);
    const outcomes = await runDeviceLanes(jobs, 6, {
      open: async (device) => {
        events.push(`start ${device}`);
        return `${device}-simulator`;
      },
      run: async (job, opened) => {
        expect(opened).toBe(`${job.device}-simulator`);
        await new Promise((resolve) => setImmediate(resolve));
        events.push(`run ${name(job)}`);
        return name(job);
      },
      close: async (opened) => {
        events.push(`end ${opened}`);
      },
    });
    expect(outcomes).toEqual(jobs.map(name));
    const lane = (device: string) => events.filter((event) => event.includes(device));
    for (const device of ["ipad", "iphone"])
      expect(lane(device)).toEqual([
        `start ${device}`,
        ...PHONE_PARTS.map((part) => `run ${device} ${part.name}`),
        `end ${device}-simulator`,
      ]);
    expect(events.filter((event) => event.startsWith("start"))).toHaveLength(2);
  });
  it("runs no more devices at a time than asked, and a failed part stops none of the others", async () => {
    let running = 0;
    let most = 0;
    const ran: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"]);
    const outcome = runDeviceLanes(jobs, 1, {
      open: async (device) => {
        running += 1;
        most = Math.max(most, running);
        return device;
      },
      run: async (job) => {
        await new Promise((resolve) => setImmediate(resolve));
        ran.push(name(job));
        if (job.part === first) throw new Error(`${job.device} ${first} failed`);
        return name(job);
      },
      close: async () => {
        running -= 1;
      },
    });
    await expect(outcome).rejects.toThrow(`${first} failed`);
    expect(most).toBe(1);
    // One device at a time: the iPad's whole lane, then the iPhone's.
    expect(ran).toEqual(
      ["ipad", "iphone"].flatMap((device) => jobs.filter((job) => job.device === device).map(name)),
    );
  });
  // INF-1343 (the captain's "Stop a failing pull request check at its first failed part").
  it("stops every lane at its running part and starts no other once a part fails, when asked to", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const ended: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"]);
    const outcomes = await runDeviceLanes(
      jobs,
      2,
      {
        open: async (device) => device,
        run: async (job, _opened, stopping) => {
          started.push(name(job));
          if (name(job) === `iphone ${first}`) return { name: name(job), failed: true };
          // A running part ends when the gate stops it, as an interrupted part does.
          await new Promise((resolve) =>
            stopping.addEventListener("abort", resolve, { once: true }),
          );
          stopped.push(name(job));
          return { name: name(job), failed: false };
        },
        close: async (opened) => {
          ended.push(opened);
        },
      },
      ({ failed }) => failed,
    );
    expect(started).toEqual([`ipad ${first}`, `iphone ${first}`]);
    expect(stopped).toEqual([`ipad ${first}`]);
    expect(ended.sort()).toEqual(["ipad", "iphone"]);
    expect(
      outcomes
        .filter(Boolean)
        .map((outcome) => outcome!.name)
        .sort(),
    ).toEqual(started.sort());
    expect(outcomes.filter((outcome) => !outcome)).toHaveLength(jobs.length - 2);
  });
  it("leaves a device's parts unstarted when it cannot start, runs the other device's, and ends them all", async () => {
    const ran: string[] = [];
    const ended: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"], ["cards-form", "rest"]);
    const outcome = runDeviceLanes(jobs, 2, {
      open: async (device) => {
        if (device === "ipad") throw new Error("ipad: its simulator could not start");
        return device;
      },
      run: async (job) => {
        ran.push(name(job));
        return name(job);
      },
      close: async (opened) => {
        ended.push(opened);
      },
    });
    await expect(outcome).rejects.toThrow(/ipad: its simulator could not start/);
    expect(ran).toEqual(["iphone cards-form", "iphone rest"]);
    expect(ended).toEqual(["iphone"]);
  });
});

// INF-1083: timeouts stay on in both modes; grading keeps Xcode's own allowances.
// INF-2052: a photo added during Photos' background migration held the first part's app install for 1 to 13 minutes.
describe("a device's Photos in two stages", () => {
  const stages = () => {
    const steps: string[] = [];
    let opened!: () => void;
    const photos = devicePhotos(
      () => {
        steps.push("watch");
        return new Promise<void>((resolve) => {
          opened = resolve;
        });
      },
      async () => {
        steps.push("add");
      },
    );
    return { steps, photos, opened: () => opened() };
  };

  it("waits for Photos from the device's start and adds the photo only when a part that chooses one asks", async () => {
    const { steps, photos, opened } = stages();
    const watching = photos.watched();
    expect(photos.watched()).toBe(watching);
    opened();
    await watching;
    expect(steps).toEqual(["watch"]);
    await photos.ready();
    await photos.ready();
    expect(steps).toEqual(["watch", "add"]);
  });

  it("adds the photo only after Photos has opened its library, and once for every part that asks", async () => {
    const { steps, photos, opened } = stages();
    const first = photos.ready();
    expect(photos.ready()).toBe(first);
    await new Promise((resolve) => setImmediate(resolve));
    expect(steps).toEqual(["watch"]);
    opened();
    await first;
    expect(steps).toEqual(["watch", "add"]);
  });

  it("tells every part that chooses a photo when Photos never opened, and adds nothing", async () => {
    const steps: string[] = [];
    const photos = devicePhotos(
      async () => {
        throw new Error("Photos had not opened");
      },
      async () => {
        steps.push("add");
      },
    );
    photos.watched().catch(() => {});
    await expect(photos.ready()).rejects.toThrow("Photos had not opened");
    await expect(photos.ready()).rejects.toThrow("Photos had not opened");
    expect(steps).toEqual([]);
  });

  it("waits and adds again for a device that started again", async () => {
    const { steps, photos, opened } = stages();
    const before = photos.watched();
    opened();
    await photos.ready();
    photos.restarted();
    const after = photos.watched();
    expect(after).not.toBe(before);
    opened();
    await photos.ready();
    expect(steps).toEqual(["watch", "add", "watch", "add"]);
  });
});

describe("the native test's outer deadline", () => {
  it("gives ordinary tests 1200 seconds, leaves graded allowances to Xcode, and collects no diagnostics", () => {
    expect(phoneExecutionArguments(false)).toEqual([
      "-test-timeouts-enabled",
      "YES",
      "-collect-test-diagnostics",
      "never",
      "-default-test-execution-time-allowance",
      "1200",
      "-maximum-test-execution-time-allowance",
      "1200",
    ]);
    expect(phoneExecutionArguments(true)).toEqual([
      "-test-timeouts-enabled",
      "YES",
      "-collect-test-diagnostics",
      "never",
    ]);
  });
});

// INF-1083: the native clock proof is not a grading of unrelated UI recovery latency.
describe("the native clock proof selection", () => {
  it("selects only the existing native clock class on request, leaving ordinary parts unchanged", () => {
    expect(partSelection("rest", true)).toEqual([
      "-only-testing:InfinitaryUITests/PhoneWaitsTests",
    ]);
    expect(partSelection("rest")).toHaveLength(PHONE_PARTS.length - 1);
    expect(() => partSelection("cards-form", true)).toThrow(
      "Native wait-clock tests belong to the rest part",
    );
  });
});

// INF-1541 piece 1 (the captain's choice "The test code skips Apple's animation wait and checks each target itself"):
// the gate fails a journey part whose log never says it skipped XCTest's animation wait, and counts every animation
// wait XCTest still ran out. The first lines are INF-1538's stalled iPhone talk part, as its log printed them.
const stalled = `    t =    68.22s Setting device orientation to Landscape Left
    t =    68.22s     Device orientation changed to Landscape Left
    t =    68.30s     Interface orientation changed to Landscape Right
    t =    68.30s     Wait for com.getinfinitary.infinitary to idle
    t =   128.32s App animations complete notification not received, will attempt to continue.
    t =   128.32s Open com.getinfinitary.infinitary
    t =   128.33s     Activate com.getinfinitary.infinitary
    t =   128.34s         Wait for com.getinfinitary.infinitary to idle
    t =   188.38s App animations complete notification not received, will attempt to continue.
    t =   188.39s Checking existence of \`"message-box" TextField\``;
// Piece 1's own iPhone join part, as its log printed the start of the journey.
const skipped = `    t =     0.13s Set Up
Phone animation wait skipped: -[XCUIApplicationProcess waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:]
    t =     0.13s Setting device orientation to Portrait
    t =     0.13s     Device orientation changed to Portrait
    t =     0.15s     Wait for com.apple.springboard to idle`;

describe("a part's animation waits", () => {
  it("counts each animation wait XCTest ran out, and a part that never skipped the wait", () => {
    expect(phoneAnimationWaits(stalled)).toEqual({ skipped: false, missed: 2 });
  });

  it("reads the hook's own line as a part that skipped the wait", () => {
    expect(phoneAnimationWaits(skipped)).toEqual({ skipped: true, missed: 0 });
  });
});

// INF-2582 direction A (the captain's "A: wait once and trim the soak" and "iPhone only; iPad waits
// for the release check") and INF-2732 (the captain's "run each edited phone part three times on the
// iPhone and once on the iPad"): one gate runs every pass on the devices it started, so a request
// waits for a phone Mac once. The selection is the shape the chooser gives a change that edits the
// talk-tasks test and reaches join-read and rest.
describe("every pass in one gate", () => {
  const selection = {
    parts: ["talk-tasks"],
    iphoneOnly: ["join-read", "rest"],
    repeats: ["talk-tasks"],
  };
  it("runs reached parts on the iPhone alone and edited parts three times on the iPhone and once on the iPad", () => {
    const jobs = phonePasses(["iphone", "ipad"], selection);
    const label = ({ device, part, round }: { device: string; part: string; round: number }) =>
      `${device} ${part} ${round}`;
    expect(jobs.map(label)).toEqual([
      "ipad talk-tasks 1",
      "iphone join-read 1",
      "iphone talk-tasks 1",
      "iphone rest 1",
      "iphone talk-tasks 2",
      "iphone talk-tasks 3",
    ]);
    // A gate of every part on both devices, as the release runs, has one pass and leaves no device out:
    // each device's lane runs every part once, in the parts' own order.
    const every = phonePasses(["iphone", "ipad"], { parts: PHONE_PARTS.map(({ name }) => name) });
    for (const device of ["ipad", "iphone"] as const)
      expect(every.filter((job) => job.device === device)).toEqual(
        phoneJobs([device]).map((job) => ({ ...job, round: 1 })),
      );
    expect(every).toHaveLength(phoneJobs(["iphone", "ipad"]).length);
    expect(() => phonePasses(["iphone"], { repeats: ["talk"] })).toThrow(/No phone journey part/);
  });
  it("starts a device's later passes after its ordinary pass, and none after a failure", async () => {
    const jobs = phonePasses(["iphone", "ipad"], selection);
    const lane = (fail?: string) => {
      const started: string[] = [];
      return {
        started,
        run: () =>
          runDeviceLanes(
            jobs,
            1,
            {
              open: async (device) => device,
              run: async (job) => {
                const name = `${job.device} ${job.part} ${job.round}`;
                started.push(name);
                return { failed: name === fail };
              },
              close: async () => {},
            },
            ({ failed }) => failed,
          ),
      };
    };
    const passing = lane();
    await passing.run();
    expect(passing.started).toEqual(jobs.map((job) => `${job.device} ${job.part} ${job.round}`));
    const failing = lane("iphone talk-tasks 2");
    const outcomes = await failing.run();
    expect(failing.started).toEqual([
      "ipad talk-tasks 1",
      "iphone join-read 1",
      "iphone talk-tasks 1",
      "iphone rest 1",
      "iphone talk-tasks 2",
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(5);
  });
});

// INF-2582 direction A: a branch runs 2 of INF-1735's 20 relaunch pairs, one in each relaunch part.
describe("the relaunch soak's pair count", () => {
  it("runs every pair unless a count is given, and refuses a count outside one to ten", () => {
    const relaunchParts = PHONE_PARTS.filter(({ name }) => name.startsWith("relaunch-"));
    expect(relaunchParts.length * relaunchPairs(undefined)).toBe(20);
    expect(relaunchParts.length * relaunchPairs("")).toBe(20);
    expect(relaunchParts.length * relaunchPairs("1")).toBe(2);
    expect(relaunchPairs(String(RELAUNCH_PAIRS_PER_PART))).toBe(RELAUNCH_PAIRS_PER_PART);
    for (const value of ["0", "11", "1.5", "two", "-1"])
      expect(() => relaunchPairs(value)).toThrow(/whole number from 1 to 10/);
  });
});
