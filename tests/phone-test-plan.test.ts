import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_PARTS,
  partSelection,
  phoneExecutionArguments,
  phoneJobs,
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
  it("refuses to run with no simulator", async () => {
    await expect(runSideBySide(phoneJobs(["iphone"]), 0, async () => 0)).rejects.toThrow(
      /at least one simulator/,
    );
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
