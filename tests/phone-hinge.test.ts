import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  innerScreenLit,
  litScreenWide,
  phonePoseFault,
  pressPhoneKey,
  setPhoneHinge,
  turnPhone,
} from "../scripts/phone-hinge";
import { PHONE_PARTS, partDevices, partHinge } from "../scripts/phone-test-plan";
import { scratchDir } from "./helpers/scratchDirs";

// INF-4241 piece 8 (the brief's "a helper in scripts/ opens and closes the simulated hinge, reads the pose back and
// fails the part by name with no retry"). The readings are `devicectl device info displays` on a simulated iPhone Duo
// on iOS 27.1 under Xcode 27.1, closed and then open after the helper's sweep; only the output file's path is renamed.
const CLOSED = "tests/fixtures/phone-hinge/duo-displays-closed.json";
const OPEN = "tests/fixtures/phone-hinge/duo-displays-open.json";
// INF-4539: the same reading on the open Duo once the helper turned it onto its side (`turn landscape-left`).
const SIDE = "tests/fixtures/phone-hinge/duo-displays-open-side.json";

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

describe("turning the open Duo", () => {
  // INF-4539 (the captain's "Yes, start it once INF-4330 merges" for a check that turns the open Duo): the gate turns
  // it once and reads the inner screen back, wide like a book and tall on its side.
  it("reads the inner screen's shape from its panel and its turn", () => {
    expect(litScreenWide(readFileSync(OPEN, "utf8"))).toBe(true);
    expect(litScreenWide(readFileSync(SIDE, "utf8"))).toBe(false);
    expect(litScreenWide(readFileSync(CLOSED, "utf8"))).toBe(false);
  });
  // A Duo whose screens read `screens` in turn and whose hinge reads `angle`; every command is kept.
  function duo(screens: string[], angle = 180) {
    const reading = join(scratchDir("phone-turn-"), "displays.json");
    const commands: string[] = [];
    const run = async (command: string, args: string[]) => {
      commands.push([command, ...args].join(" "));
      if (args[0] === "devicectl") copyFileSync(screens.shift() ?? screens.at(-1) ?? OPEN, reading);
      return args.at(-1) === "angle" ? `${angle}\n` : "";
    };
    return {
      run,
      reading,
      commands,
      turns: () => commands.filter((each) => each.includes(" turn ")),
    };
  }
  it("turns the open Duo onto its side once and waits for its screen to stand tall", async () => {
    const open = duo([OPEN, SIDE]);
    await turnPhone({
      run: open.run,
      simulator: "duo-1",
      helper: "/h",
      to: "side-left",
      reading: open.reading,
    });
    expect(open.turns()).toEqual(["xcrun simctl spawn duo-1 /h turn landscape-left"]);
  });
  // INF-5183: the simulated Duo dropped a turn that was the first pose event SpringBoard heard after the hinge closed
  // and reopened: it took the event and kept its inner screen wide. The gate states the hinge's angle once more
  // first, where it already stands, so that event is never the turn.
  it("states the hinge's angle where it stands before the turn, so the turn follows a pose event", async () => {
    const open = duo([SIDE]);
    await turnPhone({
      run: open.run,
      simulator: "duo-1",
      helper: "/h",
      to: "side-left",
      reading: open.reading,
    });
    expect(open.commands.slice(0, 3)).toEqual([
      "xcrun simctl spawn duo-1 /h angle",
      "xcrun simctl spawn duo-1 /h sweep 180 180 0",
      "xcrun simctl spawn duo-1 /h turn landscape-left",
    ]);
    expect(open.commands.filter((each) => each.includes(" sweep "))).toHaveLength(1);
  });
  it("fails before it turns a Duo whose hinge cannot be read", async () => {
    const unread = duo([OPEN], Number.NaN);
    await expect(
      turnPhone({
        run: unread.run,
        simulator: "duo-1",
        helper: "/h",
        to: "side-left",
        reading: unread.reading,
        settle: 0,
      }),
    ).rejects.toThrow("The Duo's hinge angle could not be read: NaN");
    expect(unread.turns()).toEqual([]);
  });
  it("fails, naming the turn and what the screen shows, and never turns it a second time", async () => {
    const stuck = duo([OPEN]);
    await expect(
      turnPhone({
        run: stuck.run,
        simulator: "duo-1",
        helper: "/h",
        to: "side-right",
        reading: stuck.reading,
        settle: 0,
      }),
    ).rejects.toThrow(
      "duo: it was turned side-right once, and 0 seconds later its inner screen shows wide",
    );
    expect(stuck.turns()).toEqual(["xcrun simctl spawn duo-1 /h turn landscape-right"]);
  });
  it("refuses to turn a closed Duo", async () => {
    const closed = duo([CLOSED], 0);
    await expect(
      turnPhone({
        run: closed.run,
        simulator: "duo-1",
        helper: "/h",
        to: "book",
        reading: closed.reading,
        settle: 0,
      }),
    ).rejects.toThrow("only the open Duo turns");
  });
});

describe("pressing a key on the open Duo", () => {
  // INF-5183: XCTest's own key reaches no app on the open Duo, so the gate presses it once through the helper, as an
  // attached keyboard does, and reads where the simulator sent it.
  type Outcome = { outcome: string; proof: string[] };
  const delivered: Outcome = {
    outcome: "delivered",
    proof: [
      "sequence starting with Keyboard event: <sq: 0x1; (<keyboardFocus; pid: 7; token: 0x2>)>",
    ],
  };
  const unread: Outcome = { outcome: "unknown", proof: [] };
  // A Duo whose kept log answers `readings` in turn; every command, every span asked about and when each ask's
  // window ends are kept.
  function duo(readings: Outcome[]) {
    const commands: string[] = [];
    const spans: [number, number][] = [];
    const deadlines: number[] = [];
    return {
      commands,
      spans,
      deadlines,
      run: async (command: string, args: string[]) => {
        commands.push([command, ...args].join(" "));
        return "";
      },
      outcome: async (since: number, until: number, deadline: number) => {
        spans.push([since, until]);
        deadlines.push(deadline);
        return readings.shift() ?? unread;
      },
    };
  }
  it("presses the key once and answers where the simulator sent it", async () => {
    const open = duo([delivered]);
    const pressed = await pressPhoneKey({
      run: open.run,
      simulator: "duo-1",
      helper: "/h",
      key: "tab",
      outcome: open.outcome,
    });
    expect(pressed).toEqual(delivered);
    expect(open.commands).toEqual(["xcrun simctl spawn duo-1 /h key tab"]);
    expect(open.spans).toHaveLength(1);
    // The span asked about brackets the one press: it starts before the helper ran and ends after it.
    const [[since, until] = [Number.NaN, Number.NaN]] = open.spans;
    expect(since).toBeLessThanOrEqual(until);
  });
  it("reads the same press again while the simulator's log trails it, and never presses twice", async () => {
    const late = duo([unread, delivered]);
    const pressed = await pressPhoneKey({
      run: late.run,
      simulator: "duo-1",
      helper: "/h",
      key: "return",
      outcome: late.outcome,
      settle: 4_000,
    });
    expect(pressed).toEqual(delivered);
    expect(late.commands).toEqual(["xcrun simctl spawn duo-1 /h key return"]);
    expect(late.spans).toHaveLength(2);
    expect(late.spans[1]).toEqual(late.spans[0]);
    // Every read of the one press ends with the same window, its settle time after the press: a read used to have
    // the kept log's own minute, so a late one could outlast the journey's request for the key.
    const [[, until] = [Number.NaN, Number.NaN]] = late.spans;
    expect(late.deadlines).toEqual([until + 4_000, until + 4_000]);
  });
  it("answers what it read, after one press, when the simulator never names the key", async () => {
    const silent = duo([]);
    const pressed = await pressPhoneKey({
      run: silent.run,
      simulator: "duo-1",
      helper: "/h",
      key: "escape",
      outcome: silent.outcome,
      settle: 0,
    });
    expect(pressed).toEqual(unread);
    expect(silent.commands).toEqual(["xcrun simctl spawn duo-1 /h key escape"]);
    expect(silent.spans).toHaveLength(1);
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
