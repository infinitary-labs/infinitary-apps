import type { PlacedRosterTask, PlacedSpec } from "@shared/work";
import { type AppPaths, crewmatePlacedDir, crewmateSessionsDir } from "../paths";
import { type CallLine, PlacedLedger } from "./placedLedger";
import type { PlacedSession } from "./placedSession";
import { RecordCopy, type RecordCopyOptions } from "./recordCopy";

/**
 * What the home keeps in memory of each computer that runs work and of each
 * task held on one, for `PlacedSessions`: a computer's roster and reach, and
 * a task's place in its events, its conversation here, its ledger
 * (`PlacedLedger`) and this Mac's copy of its record (`RecordCopy`).
 */

export type Roster = {
  tasksDir: string;
  /** Where its working copies are; absent from a computer that keeps none. */
  worktreesDir?: string;
  tasks: Map<string, PlacedRosterTask>;
  /** It keeps its tasks' own browsers (docs/task-browser.md, "On another computer"). */
  browsers: boolean;
};

export type Device = {
  readonly id: string;
  /** Read once each time it comes into reach. */
  roster: Roster | undefined;
  /** Each contact counts, so a roster from an earlier one is let go. */
  contact: number;
  /** Since when it has been out of reach, or since this Mac started without it. */
  goneSince: number;
  /** When the contact that brought it back came; undefined while it is out of reach. */
  reachedAt: number | undefined;
  /** The feed said it went, so it says when its work caught up. */
  saidGone: boolean;
  /** Resolves once this contact's roster is read: what it asks first waits for it. */
  rostered: Promise<void>;
  rosterRead: () => void;
};

export type Placed = {
  readonly task: string;
  readonly deviceId: string;
  /** The newest event taken in. */
  through: number;
  /** The newest event kept for good, at a model turn's end. */
  kept: number;
  /** The newest turn's end kept. */
  ended: number;
  session: PlacedSession | undefined;
  /** The conversation is being opened on this Mac for an ask that came first. */
  adopting: Promise<void> | undefined;
  /** When that opening began. */
  adoptingSince: number | undefined;
  /** Opens asked there and not yet answered. */
  asking: number;
  /** A cleanup of words from outside under way there, which an open waits for. */
  cleaning: Promise<void> | undefined;
  /**
   * An open there again (`reopen`) under way, which a prompt or steer waits
   * for: true once that computer confirmed the conversation open.
   */
  reopening: Promise<boolean> | undefined;
  /** What the home keeps of it: each callback's answer, each change begun, its place. */
  readonly ledger: PlacedLedger;
  calling: Map<string, Promise<unknown>>;
  /** One events request at a time, in order. */
  chain: Promise<unknown>;
  /** Reports answered since the last kept turn's end, given again to an adopting turn. */
  replays: CallLine[];
  /** The existing event lane waits for adopting report callbacks to commit. */
  replaying?: Promise<void>;
  /** It was caught up the last time the lane was let go. */
  released: boolean;
  /** Close was asked of the computer, and answered. */
  closed: boolean;
  /** Calls announced by the computer whose results have not arrived yet. */
  openCalls: Set<string>;
  /** Claude calls that ended there this turn, whose results this Mac's copy may still lack. */
  endedCalls: Set<string>;
  /** This Mac's copy of its conversation's record. */
  readonly record: RecordCopy;
  /** What its session was opened with, to open it there again after that computer restarts. */
  spec: PlacedSpec | undefined;
  /**
   * The computer's newest answer about this conversation (INF-2332): whether
   * its live session works, and how many events it had counted then. It is
   * compared once the home has taken exactly that many, then dropped.
   */
  said: { seq: number; working: boolean } | undefined;
  /**
   * An open asked there while its conversation worked: that computer kept
   * the conversation as it was, so the home asks again once the turn ends
   * here (INF-2332).
   */
  reopenOwed: boolean;
};

/** A computer first heard of: out of reach since `startedAt`, its first roster awaited. */
export function newDevice(deviceId: string, startedAt: number): Device {
  const device: Device = {
    id: deviceId,
    roster: undefined,
    contact: 0,
    goneSince: startedAt,
    reachedAt: undefined,
    saidGone: false,
    rostered: Promise.resolve(),
    rosterRead: () => {},
  };
  awaitRoster(device);
  return device;
}

/** A roster to wait for, from this contact on; whoever waited on the last one looks again. */
export function awaitRoster(device: Device): void {
  const wake = device.rosterRead;
  device.rostered = new Promise<void>((resolve) => {
    device.rosterRead = resolve;
  });
  wake();
}

/** What a task's state reads of the home: its folders, and how its record copy reaches that computer. */
export type PlacedHome = Pick<RecordCopyOptions, "devices" | "now" | "schedule"> & {
  readonly paths: AppPaths;
};

/**
 * The task's state, kept in `known` from the first ask on: its place and its
 * ledger read from what the home kept of it.
 */
export function loadPlaced(
  known: Map<string, Placed>,
  task: string,
  deviceId: string,
  home: PlacedHome,
  log: (line: string) => void,
): Placed {
  const held = known.get(task);
  if (held) return held;
  const ledger = new PlacedLedger(crewmatePlacedDir(home.paths, task));
  const kept = ledger.place();
  const placed: Placed = {
    task,
    deviceId,
    through: kept.kept,
    kept: kept.kept,
    ended: kept.ended,
    session: undefined,
    adopting: undefined,
    adoptingSince: undefined,
    asking: 0,
    cleaning: undefined,
    reopening: undefined,
    said: undefined,
    reopenOwed: false,
    ledger,
    calling: new Map(),
    chain: Promise.resolve(),
    replays: [],
    released: false,
    closed: false,
    openCalls: new Set(),
    endedCalls: new Set(),
    record: new RecordCopy(
      {
        task,
        deviceId,
        devices: home.devices,
        now: home.now,
        ...(home.schedule ? { schedule: home.schedule } : {}),
        log,
        following: () => !placed.closed && heldSession(placed) !== undefined,
        callOpen: () =>
          placed.spec?.binding.backend === "claude" &&
          (placed.openCalls.size > 0 || placed.record.awaitsAnyResult(placed.endedCalls)),
      },
      crewmateSessionsDir(home.paths, task),
    ),
    spec: undefined,
  };
  known.set(task, placed);
  // The reports a turn this Mac had not finished gave: a restart here replays them.
  placed.replays = ledger
    .lines()
    .filter((line) => line.report !== undefined && line.after >= placed.ended);
  return placed;
}

/** The conversation, while this Mac holds it and has not let it go. */
export function heldSession(placed: Placed): PlacedSession | undefined {
  return placed.session && !placed.session.letGo ? placed.session : undefined;
}
