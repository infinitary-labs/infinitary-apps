import { describe, expect, it } from "vitest";
import { Attendance } from "./attendance";
import { PresenceWatch } from "./presenceWatch";

/**
 * INF-7038's approved plan, Part 2, with the captain's answers: someone is at
 * a computer until 5 minutes pass without the keyboard or mouse (question 2),
 * a sure sign such as a lock says nobody at once, and acting on a phone says
 * nobody until the next touch unless the computer was touched in the 10
 * seconds before (question 3). A computer that cannot tell keeps the rule
 * before presence: someone is here while a window is in front.
 */
function reading(options: { watched?: boolean; posts?: boolean } = {}) {
  const clock = { now: 1_000_000, lastTouch: 1_000_000 };
  const watch = new PresenceWatch(options.watched ?? true, () =>
    Math.floor((clock.now - clock.lastTouch) / 1000),
  );
  let tick = () => {};
  const attendance = new Attendance({
    presence: watch,
    postsNotices: () => options.posts ?? true,
    now: () => clock.now,
    every: (run) => {
      tick = run;
      return () => {};
    },
  });
  const said: boolean[] = [];
  attendance.listen((here) => said.push(here));
  attendance.start();
  /** Moves the clock by `ms` and lets the reading look again, as its timer does. */
  const pass = (ms: number) => {
    clock.now += ms;
    tick();
  };
  const touch = () => {
    clock.lastTouch = clock.now;
    tick();
  };
  return { attendance, watch, said, pass, touch };
}

describe("whether someone is at this computer, for the phone", () => {
  it("says nobody once 5 minutes pass untouched, and someone again at the next touch", () => {
    const { attendance, said, pass, touch } = reading();
    expect(attendance.here()).toBe(true);
    pass(4 * 60_000 + 59_000);
    expect(said).toEqual([]);
    pass(1_000);
    expect(said).toEqual([false]);
    pass(60_000);
    expect(said).toEqual([false]);
    touch();
    expect(said).toEqual([false, true]);
  });

  it("says nobody at once on a lock, whatever the time since the last touch", () => {
    const { watch, said } = reading();
    watch.set("locked", true);
    expect(said).toEqual([false]);
    watch.set("locked", false);
    expect(said).toEqual([false, true]);
  });

  it("says nobody after an act on the phone until the next touch, unless touched in the 10 seconds before", () => {
    const { attendance, said, pass, touch } = reading();
    pass(9_000);
    attendance.phoneActed();
    expect(said).toEqual([]);
    pass(2_000);
    attendance.phoneActed();
    expect(said).toEqual([false]);
    pass(60_000);
    expect(said).toEqual([false]);
    touch();
    expect(said).toEqual([false, true]);
  });

  it("counts a computer that shows no notification of its own only while a window is in front", () => {
    const { attendance, said } = reading({ posts: false });
    expect(attendance.here()).toBe(false);
    attendance.front(true);
    expect(said).toEqual([true]);
    attendance.front(false);
    expect(said).toEqual([true, false]);
  });

  it("says someone exactly while a window is in front where the computer cannot tell", () => {
    const { attendance, said, pass } = reading({ watched: false });
    expect(attendance.here()).toBe(false);
    attendance.front(true);
    pass(60 * 60_000);
    attendance.phoneActed();
    expect(said).toEqual([true]);
    attendance.front(false);
    expect(said).toEqual([true, false]);
  });
});
