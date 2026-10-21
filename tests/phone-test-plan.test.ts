import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testHomeKeys } from "../scripts/phone-test-plan";

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
