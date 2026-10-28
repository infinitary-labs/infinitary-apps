import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_PARTS,
  partSelection,
  phoneAnimationWaits,
  phoneExecutionArguments,
  phoneJobs,
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
// Every test the Oct 21 build ran, read from the four parts' result bundles on the Mac mini.
const everyTest: string[] = JSON.parse(
  readFileSync("tests/fixtures/phone-test-plan/xcode-26.4-tests.json", "utf8"),
);
// xcodebuild's -only-testing and -skip-testing name a target, a class or a test, matched whole.
const chosen = (selection: string[], test: string) => {
  const names = (kind: string) =>
    selection.filter((arg) => arg.startsWith(kind)).map((arg) => arg.slice(kind.length));
  const named = (identifier: string) => test === identifier || test.startsWith(`${identifier}/`);
  const only = names("-only-testing:");
  return (only.length === 0 || only.some(named)) && !names("-skip-testing:").some(named);
};
const partsRunning = (test: string) =>
  PHONE_PARTS.filter((part) => chosen(partSelection(part.name), test)).map((part) => part.name);

describe("the phone journey's parts", () => {
  it("run every test the build has exactly once, each journey test in its own part", () => {
    expect(everyTest.length).toBeGreaterThan(PHONE_PARTS.length);
    for (const test of everyTest) expect(partsRunning(test), test).toHaveLength(1);
    for (const part of PHONE_PARTS)
      expect(partsRunning(`InfinitaryUITests/PhoneJourney/${part.test}`)).toEqual([part.name]);
    // The app-hosted tests ride with the shortest part.
    expect(
      partsRunning("InfinitaryTests/RecoveryTests/testMissingCertificateReusesTheStoredKey"),
    ).toEqual(["rest"]);
  });
  it("still runs a test no part names, such as a new or renamed one", () => {
    expect(partsRunning("InfinitaryUITests/PhoneJourney/testSomethingNew")).toEqual(["rest"]);
    expect(partsRunning("InfinitaryUITests/PhoneSettingsJourney/testSettings")).toEqual(["rest"]);
  });
  it("starts each part on the iPad, then the iPhone, longest part first", () => {
    expect(phoneJobs(["iphone", "ipad"]).map(({ device, part }) => `${device} ${part}`)).toEqual([
      "ipad join",
      "iphone join",
      "ipad talk",
      "iphone talk",
      "ipad cards",
      "iphone cards",
      "ipad address",
      "iphone address",
      "ipad rest",
      "iphone rest",
    ]);
    expect(phoneJobs(["iphone"], ["cards"])).toEqual([{ device: "iphone", part: "cards" }]);
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
      if (part === "join") throw new Error(`${device} join failed`);
      return part;
    });
    await expect(outcome).rejects.toThrow(/join failed/);
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
        if (name === "iphone join") return { name, failed: true };
        // A running part ends when the gate stops it, as an interrupted part does.
        await new Promise((resolve) => stopping.addEventListener("abort", resolve, { once: true }));
        stopped.push(name);
        return { name, failed: false };
      },
      ({ failed }) => failed,
    );
    expect(started).toEqual(["ipad join", "iphone join", "ipad talk"]);
    expect(stopped.sort()).toEqual(["ipad join", "ipad talk"]);
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
        if (job.part === "join") throw new Error(`${job.device} join failed`);
        return name(job);
      },
      close: async () => {
        running -= 1;
      },
    });
    await expect(outcome).rejects.toThrow(/join failed/);
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
          if (name(job) === "iphone join") return { name: name(job), failed: true };
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
    expect(started).toEqual(["ipad join", "iphone join"]);
    expect(stopped).toEqual(["ipad join"]);
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
    const jobs = phoneJobs(["iphone", "ipad"], ["cards", "rest"]);
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
    expect(ran).toEqual(["iphone cards", "iphone rest"]);
    expect(ended).toEqual(["iphone"]);
  });
});

// INF-1083: timeouts stay on in both modes; grading keeps Xcode's own allowances.
describe("the native test's outer deadline", () => {
  it("gives ordinary tests 1200 seconds and leaves graded allowances to Xcode", () => {
    expect(phoneExecutionArguments(false)).toEqual([
      "-test-timeouts-enabled",
      "YES",
      "-default-test-execution-time-allowance",
      "1200",
      "-maximum-test-execution-time-allowance",
      "1200",
    ]);
    expect(phoneExecutionArguments(true)).toEqual(["-test-timeouts-enabled", "YES"]);
  });
});

// INF-1083: the native clock proof is not a grading of unrelated UI recovery latency.
describe("the native clock proof selection", () => {
  it("selects only the existing native clock class on request, leaving ordinary parts unchanged", () => {
    expect(partSelection("rest", true)).toEqual([
      "-only-testing:InfinitaryUITests/PhoneWaitsTests",
    ]);
    expect(partSelection("rest")).toHaveLength(PHONE_PARTS.length - 1);
    expect(() => partSelection("cards", true)).toThrow(
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
