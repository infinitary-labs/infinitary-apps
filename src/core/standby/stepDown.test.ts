import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HomeHandOver } from "../homeMove/outgoing";
import { MOVED_AWAY_DIR } from "../homeMove/record";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { SettledBeforeAct } from "./settled";
import {
  type HeardHome,
  NEVER_SENT_FILE,
  neverSentLines,
  StepDownWatch,
  type WatchedCopy,
} from "./stepDown";

/**
 * An old home that returns, and two homes with one number (INF-4207 piece
 * 8; docs/devices.md, "An old home that returns" and "Two homes with one
 * number"): the home's real record and data folder, with the welcome each
 * copy's address answers given here, as the dial would hear it.
 */

const WAY_BACK = { deviceId: "way-back", key: "KEY", cert: "CERT" };

const opened: { close: () => void }[] = [];
const watches: StepDownWatch[] = [];
afterEach(() => {
  for (const each of watches.splice(0)) each.dispose();
  for (const each of opened.splice(0)) each.close();
});

function setUp(options: {
  copies: WatchedCopy[];
  answers: Record<string, HeardHome | null>;
  homeNumber?: number;
  takeOver?: string | null;
}) {
  const userData = scratchDir("infinitary-step-down-");
  const db = openDatabase(userData);
  opened.push(db);
  let now = 1_000;
  const tasks = new TaskService({ db, now: () => now });
  let homeNumber = options.homeNumber ?? 2;
  const heard: DeviceGrant[] = [];
  const steppedDown: HomeHandOver[] = [];
  const twoHomes: ({ deviceId: string; name: string } | null)[] = [];
  const settled = new SettledBeforeAct();
  const watch = new StepDownWatch({
    returning: () => WAY_BACK,
    homeKey: () => "HOME-PIN",
    homeNumber: () => homeNumber,
    takeOver: () => options.takeOver ?? null,
    copies: () => options.copies,
    onReach: () => () => {},
    hear: async (grant) => {
      heard.push(grant);
      return options.answers[grant.at] ?? null;
    },
    neverSent: (since) => neverSentLines(db, since),
    userData,
    stepDown: (handOver) => steppedDown.push(handOver),
    twoHomes: (other) => {
      settled.hold(other !== null);
      twoHomes.push(other);
    },
    log: () => {},
    now: () => now,
    lookMs: [60_000],
  });
  watches.push(watch);
  return {
    userData,
    tasks,
    watch,
    heard,
    steppedDown,
    twoHomes,
    settled,
    at: (time: number) => {
      now = time;
    },
    raise: (next: number) => {
      homeNumber = next;
    },
    homeNumber: () => homeNumber,
  };
}

const studio = (copy: Partial<WatchedCopy> = {}): WatchedCopy => ({
  deviceId: "studio",
  name: "Mac Studio",
  addresses: ["10.0.0.7:4800", "studio.local:4800"],
  copyAt: 5_000,
  inReach: false,
  ...copy,
});

describe("an old home that returns", () => {
  it("finds the copy that took over with a higher number, lists what it saved after that copy, and steps down to it", async () => {
    const home = setUp({
      copies: [studio()],
      answers: { "10.0.0.7:4800": { homeNumber: 3, takeOver: "take-1", name: "Mac Studio" } },
    });
    seedTask(home.tasks, { id: "t-old", title: "Before the copy", status: "queued" });
    home.at(4_000);
    home.tasks.note("t-old", "Saved before the copy", { news: false, feed: true });
    seedTask(home.tasks, { id: "t-new", title: "After the copy", status: "queued" });
    home.at(6_000);
    home.tasks.note("t-new", "Pushed the branch", { news: false, feed: true });
    home.at(7_000);
    home.tasks.note("t-new", "Merged", { news: false, feed: true });

    home.watch.start();
    await vi.waitFor(() => expect(home.steppedDown).toHaveLength(1));

    // It dialed as its own way back, pinned to its own key, at the copy's addresses.
    expect(home.heard[0]).toMatchObject({
      at: "10.0.0.7:4800",
      also: ["studio.local:4800"],
      homeKey: "HOME-PIN",
      deviceId: "way-back",
      kind: "mac",
    });
    const handOver = home.steppedDown[0];
    expect(handOver).toMatchObject({
      move: "took-over-take-1",
      homeNumber: 3,
      name: "Mac Studio",
      grant: { at: "10.0.0.7:4800", deviceId: "way-back", key: "KEY", cert: "CERT" },
    });
    // Only what it saved after the copy's time never reached it, newest first.
    expect(handOver?.steppedDown?.since).toBe(5_000);
    expect(handOver?.steppedDown?.lines).toEqual([
      { task: "After the copy", at: 7_000, text: "Merged" },
      { task: "After the copy", at: 6_000, text: "Pushed the branch" },
    ]);
    // The same list is kept beside where its record goes aside.
    const kept = JSON.parse(
      readFileSync(
        join(home.userData, MOVED_AWAY_DIR, "took-over-take-1", NEVER_SENT_FILE),
        "utf8",
      ),
    );
    expect(kept.lines).toHaveLength(2);
    // It steps down once, whatever it hears after.
    home.watch.look();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(home.steppedDown).toHaveLength(1);
  });

  it("dials no copy in its reach, and keeps its place when no copy answers as a home", async () => {
    const home = setUp({
      copies: [
        studio({ inReach: true }),
        studio({ deviceId: "mini", name: "Mac mini", addresses: ["10.0.0.8:4800"] }),
      ],
      answers: {},
    });
    home.watch.start();
    await vi.waitFor(() => expect(home.heard).toHaveLength(1));
    expect(home.heard[0]?.at).toBe("10.0.0.8:4800");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(home.steppedDown).toEqual([]);
    expect(home.twoHomes).toEqual([]);
  });

  it("stays the home when a copy answers with a lower number", async () => {
    const home = setUp({
      copies: [studio()],
      answers: { "10.0.0.7:4800": { homeNumber: 1, takeOver: null, name: "Mac Studio" } },
    });
    home.watch.start();
    await vi.waitFor(() => expect(home.heard).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(home.steppedDown).toEqual([]);
    expect(home.twoHomes).toEqual([]);
  });
});

describe("two homes with one number", () => {
  it("holds every act until the captain keeps this one, which takes the next number", async () => {
    const home = setUp({
      homeNumber: 3,
      takeOver: "take-here",
      copies: [studio()],
      answers: { "10.0.0.7:4800": { homeNumber: 3, takeOver: "take-there", name: "Mac Studio" } },
    });
    home.watch.start();
    await vi.waitFor(() =>
      expect(home.twoHomes).toEqual([{ deviceId: "studio", name: "Mac Studio" }]),
    );
    expect(home.watch.twoHomes()).toEqual({ deviceId: "studio", name: "Mac Studio" });

    let acted = false;
    const act = home.settled.settled().then(() => {
      acted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acted).toBe(false);

    expect(home.watch.keep("here", home.raise)).toBe(true);
    await act;
    expect(acted).toBe(true);
    expect(home.homeNumber()).toBe(4);
    expect(home.watch.twoHomes()).toBeNull();
    expect(home.steppedDown).toEqual([]);
  });

  it("steps down to the other when the captain keeps it, and its acts stay held", async () => {
    const home = setUp({
      homeNumber: 3,
      takeOver: "take-here",
      copies: [studio()],
      answers: { "10.0.0.7:4800": { homeNumber: 3, takeOver: "take-there", name: "Mac Studio" } },
    });
    home.watch.start();
    await vi.waitFor(() => expect(home.watch.twoHomes()).not.toBeNull());
    expect(home.watch.keep("someone-else", home.raise)).toBe(false);
    expect(home.watch.keep("studio", home.raise)).toBe(true);
    expect(home.steppedDown[0]).toMatchObject({ homeNumber: 3, name: "Mac Studio" });
    let acted = false;
    void home.settled.settled().then(() => {
      acted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acted).toBe(false);
  });

  it("releases the held acts once the other no longer answers as a home with this number", async () => {
    const answers: Record<string, HeardHome | null> = {
      "10.0.0.7:4800": { homeNumber: 3, takeOver: "take-there", name: "Mac Studio" },
    };
    const home = setUp({ homeNumber: 3, takeOver: "take-here", copies: [studio()], answers });
    home.watch.start();
    await vi.waitFor(() => expect(home.watch.twoHomes()).not.toBeNull());
    let acted = false;
    const act = home.settled.settled().then(() => {
      acted = true;
    });
    // Out of reach, it still holds: nothing heard says the other stopped.
    answers["10.0.0.7:4800"] = null;
    home.watch.look();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acted).toBe(false);
    // The other stepped down and answers as a Mac would, with an older number.
    answers["10.0.0.7:4800"] = { homeNumber: 2, takeOver: null, name: "Mac Studio" };
    home.watch.look();
    await act;
    expect(home.watch.twoHomes()).toBeNull();
    expect(home.twoHomes).toEqual([{ deviceId: "studio", name: "Mac Studio" }, null]);
    expect(home.steppedDown).toEqual([]);
  });

  it("holds every act and asks when a window tells it of a second home it cannot reach, and steps down there if the captain keeps that one", async () => {
    // Mac Studio is out of this home's reach: nothing answers its dial. Mac
    // mini, a copy both homes keep, is in reach here.
    const mini = studio({
      deviceId: "mini",
      name: "Mac mini",
      addresses: ["10.0.0.8:4800"],
      inReach: true,
    });
    const home = setUp({
      homeNumber: 3,
      takeOver: "take-here",
      copies: [mini, studio()],
      answers: {},
    });
    home.watch.start();
    await vi.waitFor(() => expect(home.heard).toHaveLength(1));
    expect(home.twoHomes).toEqual([]);

    // A home with another number, or this home's own takeover, is no second home.
    // The window names first where Mac Studio answered, then every copy it keeps.
    const there = {
      name: "Mac Studio",
      takeOver: "take-there",
      addresses: ["10.0.0.7:4800", "10.0.0.8:4800"],
    };
    expect(home.watch.reported({ ...there, homeNumber: 2 })).toBe(false);
    expect(home.watch.reported({ ...there, homeNumber: 3, takeOver: "take-here" })).toBe(false);
    expect(home.watch.reported({ ...there, homeNumber: 3 })).toBe(true);
    // The window named it first where Mac Studio's copy answers, so it is that copy, never Mac mini.
    expect(home.twoHomes).toEqual([{ deviceId: "studio", name: "Mac Studio" }]);
    let acted = false;
    void home.settled.settled().then(() => {
      acted = true;
    });
    // Still unreached on the next look, it stays held.
    home.watch.look();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acted).toBe(false);
    expect(home.watch.twoHomes()).toEqual({ deviceId: "studio", name: "Mac Studio" });

    expect(home.watch.keep("studio", home.raise)).toBe(true);
    expect(home.steppedDown[0]).toMatchObject({
      homeNumber: 3,
      name: "Mac Studio",
      grant: { at: "10.0.0.7:4800", deviceId: "way-back" },
    });
  });

  it("a copy that answers with this home's own takeover is this home, not a second one", async () => {
    const home = setUp({
      homeNumber: 3,
      takeOver: "take-here",
      copies: [studio()],
      answers: { "10.0.0.7:4800": { homeNumber: 3, takeOver: "take-here", name: "Mac Studio" } },
    });
    home.watch.start();
    await vi.waitFor(() => expect(home.heard).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(home.twoHomes).toEqual([]);
  });
});
