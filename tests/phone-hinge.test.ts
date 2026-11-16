import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { innerScreenLit, phonePoseFault, setPhoneHinge } from "../scripts/phone-hinge";
import { PHONE_PARTS, partDevices, partHinge } from "../scripts/phone-test-plan";
import { scratchDir } from "./helpers/scratchDirs";

// INF-4241 piece 8 (the brief's "a helper in scripts/ opens and closes the simulated hinge, reads the pose back and
// fails the part by name with no retry"). The readings are `devicectl device info displays` on a simulated iPhone Duo
// on iOS 27.1 under Xcode 27.1, closed and then open after the helper's sweep; only the output file's path is renamed.
const CLOSED = "tests/fixtures/phone-hinge/duo-displays-closed.json";
const OPEN = "tests/fixtures/phone-hinge/duo-displays-open.json";

describe("the Duo's pose", () => {
  it("reads which screen is lit from devicectl's displays", () => {
    expect(innerScreenLit(readFileSync(CLOSED, "utf8"))).toBe(false);
    expect(innerScreenLit(readFileSync(OPEN, "utf8"))).toBe(true);
  });
  it("refuses a reading that lights both screens or neither", () => {
    const reading = JSON.parse(readFileSync(OPEN, "utf8"));
    for (const display of reading.result.displays) display.active = true;
    expect(() => innerScreenLit(JSON.stringify(reading))).toThrow("lit 2 of its 2 screens");
  });
  it("names what a pose shows that the hinge asked for does not", () => {
    expect(phonePoseFault("open", { angle: 180, inner: true })).toBeUndefined();
    expect(phonePoseFault("closed", { angle: 0.4, inner: false })).toBeUndefined();
    expect(phonePoseFault("open", { angle: 0, inner: false })).toBe(
      "its hinge reads 0 degrees, not 180 and its outer screen is lit",
    );
    expect(phonePoseFault("closed", { angle: 0, inner: true })).toBe("its inner screen is lit");
  });
});

describe("moving the Duo's hinge", () => {
  // A Duo whose hinge reads `angles` in turn and whose screens read `screens` in turn, as the helper and devicectl
  // answer; every command is kept.
  function duo(angles: number[], screens: string[]) {
    const folder = scratchDir("phone-hinge-");
    const reading = join(folder, "displays.json");
    const commands: string[] = [];
    const run = async (command: string, args: string[]) => {
      commands.push([command, ...args].join(" "));
      if (args[0] === "devicectl") copyFileSync(screens.shift() ?? CLOSED, reading);
      return args.at(-1) === "angle" ? `${angles.shift()}\n` : "";
    };
    return {
      run,
      reading,
      commands,
      sweeps: () => commands.filter((each) => each.includes(" sweep ")),
    };
  }
  it("moves a closed Duo open once and answers the pose it shows", async () => {
    const closed = duo([0, 180], [OPEN]);
    const pose = await setPhoneHinge({
      run: closed.run,
      simulator: "duo-1",
      helper: "/h",
      hinge: "open",
      reading: closed.reading,
    });
    expect(pose).toEqual({ angle: 180, inner: true });
    expect(closed.sweeps()).toEqual(["xcrun simctl spawn duo-1 /h sweep 0 180 0.5"]);
  });
  it("leaves a hinge already where it is asked to be", async () => {
    const closed = duo([0, 0], [CLOSED]);
    await setPhoneHinge({
      run: closed.run,
      simulator: "duo-1",
      helper: "/h",
      hinge: "closed",
      reading: closed.reading,
    });
    expect(closed.sweeps()).toEqual([]);
  });
  it("fails, naming the hinge and what the Duo shows, and never moves it a second time", async () => {
    const stuck = duo([0, 180], [CLOSED]);
    await expect(
      setPhoneHinge({
        run: stuck.run,
        simulator: "duo-1",
        helper: "/h",
        hinge: "open",
        reading: stuck.reading,
        settle: 0,
      }),
    ).rejects.toThrow(
      "duo: the hinge was moved to open once, and 0 seconds later its outer screen is lit",
    );
    expect(stuck.sweeps()).toHaveLength(1);
  });
});

describe("the Duo's parts", () => {
  it("each name the hinge the Duo starts them with", () => {
    const duoParts = PHONE_PARTS.filter((part) => partDevices(part.name).includes("duo"));
    expect(duoParts.length).toBeGreaterThan(0);
    for (const part of duoParts)
      expect(["open", "closed"], part.name).toContain(partHinge(part.name));
    expect(() => partHinge("rest")).toThrow("does not run on the duo");
  });
});
