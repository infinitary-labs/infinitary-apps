import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gateSimulators,
  isScratchFolder,
  leftBehind,
  runningGates,
} from "../scripts/phone-leftovers";

// INF-1596 (the captain's "clean up both one-off and automatically moving forward", DOP-119): a phone check
// that was killed left its simulator and scratch folder behind; the next gate removes them, and never what a
// running check may still use. Readings taken on the Mac mini: the process list with a gate, a part and a
// starved part running, and the simulator list with a gate's simulator beside two of the person's own.
const fixtures = join(__dirname, "fixtures", "phone-leftovers");
const processes = readFileSync(join(fixtures, "ps.txt"), "utf8");
const devices = readFileSync(join(fixtures, "simctl-devices.json"), "utf8");

describe("a killed phone check's leftovers", () => {
  it("reads every running phone check, a part and its starvation wrapper included, with when it began", () => {
    expect(runningGates(processes)).toEqual([
      { pid: 64770, started: Date.parse("2026-10-27T18:27:22Z") },
      { pid: 65132, started: Date.parse("2026-10-27T18:27:23Z") },
      { pid: 65455, started: Date.parse("2026-10-27T18:27:24Z") },
      { pid: 65474, started: Date.parse("2026-10-27T18:27:24Z") },
    ]);
  });

  it("counts only what came into being before every running check began", () => {
    const gates = runningGates(processes);
    const earliest = Math.min(...gates.map((gate) => gate.started));
    const killed = { name: "made by a run killed before the gate began", created: earliest - 1 };
    // ps reads whole seconds, so the gate that began then may have made this.
    const sameSecond = {
      name: "made in the second the earliest running gate began",
      created: earliest,
    };
    const running = { name: "made by a part still running", created: earliest + 2_500 };
    expect(leftBehind([killed, sameSecond, running], gates, 65474)).toEqual([killed]);
  });

  it("removes nothing when the process list does not show the gate that asks", () => {
    expect(() => leftBehind([{ created: 0 }], runningGates(processes), 393)).toThrow(
      "does not show this phone check",
    );
  });

  it("takes only the gate's own simulators, with the folder CoreSimulator made for each", () => {
    expect(gateSimulators(devices)).toEqual([
      {
        udid: "32ADB0DE-C4F5-4E4E-8A90-37952DA9B29B",
        state: "Shutdown",
        folder:
          "/Users/captain/Library/Developer/CoreSimulator/Devices/32ADB0DE-C4F5-4E4E-8A90-37952DA9B29B",
      },
    ]);
  });

  it("takes only the gate's scratch folders, never a unit test's with a longer prefix", () => {
    expect(isScratchFolder("infinitary-native-0UfcM9")).toBe(true);
    expect(isScratchFolder("infinitary-native-requirement-yJqT8X")).toBe(false);
    expect(isScratchFolder("infinitary-phone-activity-Xy12Ab")).toBe(false);
  });
});
