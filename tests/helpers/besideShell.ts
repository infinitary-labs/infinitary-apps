import { join } from "node:path";
import { type HomeConnection, startConnection } from "@core/connection/connection";
import { HomeLink } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import { DevicePairing } from "@core/devices/pairing";
import type { RestartOutcome } from "@core/helper/runAgent";
import type { Core } from "@core/index";
import type { Card } from "@shared/cards";
import { DEFAULT_SAVED_KEYMAP, type SavedKeymap } from "@shared/keymap";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { type Mock, vi } from "vitest";
import type { StartEntry } from "../../src/main/besideRun";
import type { OwnedRun } from "../../src/main/runCommand";
import type { RunStatus } from "../../src/main/runStatus";
import { Shell } from "../../src/main/shell";
import { scratchDir } from "./scratchDirs";
import { ownCore, ownUpdates, stops } from "./shellStandIns";

/**
 * The stand-ins for the window opened beside a command's first mate
 * (docs/run.md; src/main/shell.beside.test.ts): the shell against a
 * stand-in core served on the command's local door, a stand-in for the
 * command's records and starter, and this program's own presence. Each
 * test file that uses them calls `stopEachTest` once.
 */

export const JOINED = { pid: 41, startedAt: "2026-11-01T08:00:00.000Z" };
/** The run this app's own agent started, which its window's starter owns. */
export const OWNED: OwnedRun = JOINED;
/** The command's own records in its data folder, as the window reads them. */
export type Records = Pick<RunStatus, "running" | "run" | "lastStop">;
export const stopped = (
  reason: "quit" | "signal" | "updated" | "start-failed",
  exitCode: number,
  of = JOINED,
): Records => ({
  running: false,
  run: null,
  // Stopped just now: the wait for a start entry counts from the record's own time.
  lastStop: { ...of, stoppedAt: new Date().toISOString(), reason, exitCode, lines: [] },
});

/** The command's first mate in another program: a stand-in core served on its local door. */
export function commandRun() {
  const run = ownCore();
  /** What that first mate keeps, and what this computer's window told it. */
  const there = {
    look: {
      ...DEFAULT_SHELL_PREFERENCES,
      appearance: { ...DEFAULT_SHELL_PREFERENCES.appearance, theme: "light", size: 125 },
    } as ShellPreferences,
    keys: DEFAULT_SAVED_KEYMAP as SavedKeymap,
    showInDock: true,
    dictation: true,
    cards: [] as Card[],
    here: 0,
    focused: 0,
    answers: [] as unknown[][],
    holds: [] as unknown[],
  };
  run.dispatch.mockImplementation((async (channel: string, args: unknown[]) => {
    switch (channel) {
      case "inf:shell:preferences":
        return there.look;
      case "inf:settings:appearance:set":
        there.look = { ...there.look, appearance: args[0] as ShellPreferences["appearance"] };
        run.core.events.emit("inf:shell:preferences", there.look);
        return there.look.appearance;
      case "inf:settings:keys:get":
        return { saved: there.keys, unreadable: false };
      case "inf:settings:keys:set":
        there.keys = args[0] as SavedKeymap;
        return { ok: true };
      case "inf:presence:get":
        return { startAtLogin: false, showInDock: there.showInDock };
      case "inf:settings:dictation:get":
        return { enabled: there.dictation, key: "AltRight" };
      case "inf:settings:dictation:set":
        there.dictation = (args[0] as { enabled: boolean }).enabled;
        return { enabled: there.dictation, key: "AltRight" };
      case "inf:own-window:here":
        there.here += 1;
        return { ok: true };
      case "inf:own-window:focused":
        there.focused += 1;
        return { ok: true };
      case "inf:own-window:answer":
        there.answers.push(args);
        return { ok: true };
      case "inf:cards:list":
        return there.cards;
      case "inf:settings:notifications:get":
        return true;
      case "inf:update:hold":
        there.holds.push(args[0]);
        return { saved: true, work: { state: "resuming", tasks: ["Fix the flaky test"] } };
      default:
        return { run: channel };
    }
  }) as never);
  const doorDir = join(scratchDir("infinitary-shell-beside-"), "local-door");
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-shell-beside-"), "devices"),
    onProblem: () => {},
  });
  let connection: HomeConnection | null = null;
  /**
   * Opens the command's door, naming the run it stands for, as a command does: the joined run
   * unless another is given, and none for a door from before doors named their run.
   */
  const open = (doorRun: OwnedRun | null = JOINED) => {
    connection = startConnection({
      dispatch: run.core.dispatch,
      events: run.core.events,
      devices: pairing,
      localDoor: doorDir,
      ...(doorRun ? { localDoorRun: doorRun } : {}),
      port: 0,
      onProblem: () => {},
    });
    return connection;
  };
  stops.push(async () => {
    await connection?.close();
    pairing.dispose();
  });
  return {
    run,
    there,
    doorDir,
    open,
    stop: () => connection?.close(),
    asked: (channel: string) =>
      run.dispatch.mock.calls.filter(([asked]) => asked === channel).map(([, args]) => args),
  };
}

/** A command whose first mate welcomes the window and never answers its first ask. */
export function silentRun() {
  const command = commandRun();
  const answer = command.run.dispatch.getMockImplementation();
  command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
    channel === "inf:own-window:here"
      ? new Promise(() => {})
      : answer?.(channel as never, args as never)) as never);
  // How it answers once it does, as a program started again in its place would.
  return Object.assign(command, { answer });
}

export function besideShell(
  doorDir: string,
  options: {
    records?: Records;
    entry?: StartEntry;
    readyMs?: number;
    installsUpdates?: boolean;
    programReplaced?: boolean;
    /** When this window started the command, and the starter it started it with. */
    startedAt?: number;
    starts?: boolean;
    /** How long the window waits for a running command to answer before it says it does not. */
    answerWaitMs?: number;
    /** Each dial of the command's door after this turns true never connects, as at a stuck command. */
    dialHangs?: () => boolean;
    /** Where each link the window dials the command's door with is kept, to read its connection. */
    links?: HomeLink[];
    /** This user's work folder, where a home that added this computer leaves its grant. */
    workDir?: string;
    /**
     * The command running when it is the starter's own - this app's agent started it - or null
     * for one started by hand; asked each time. With a starter, the agent's run by default.
     */
    ownedRun?: (status: Records) => OwnedRun | null;
  } = {},
) {
  const startCore: Mock<() => Promise<Core>> = vi.fn(async () => ownCore().core);
  const relaunch: Mock<(...args: unknown[]) => void> = vi.fn();
  const restartWindows: Mock<() => void> = vi.fn();
  const openPage: Mock<(url: string) => Promise<void>> = vi.fn(async (_url: string) => {});
  const pushes: { channel: string; payload: unknown }[] = [];
  /** What the command's records say now, and which start entry is in place. */
  const command = {
    records: options.records ?? ({ running: true, run: JOINED, lastStop: null } as Records),
    entry: options.entry ?? (null as StartEntry),
    programReplaced: options.programReplaced ?? false,
  };
  /** This program's own Dock icon, login item, file picker and Notification Center. */
  const program = {
    dock: [] as boolean[],
    startAtLogin: false,
    picked: ["/home/kai/report.pdf"],
    notified: [] as { title: string; body: string }[],
  };
  /** The command's starter (docs/run.md, "The window starts it"), and Stop's signals. */
  const starter = {
    start: vi.fn(async () => true) as Mock<() => Promise<boolean>>,
    atLogin: {
      get: () => starter.login,
      set: (on: boolean) => {
        starter.login = on;
      },
    },
    inPlace: () => true,
    stop: vi.fn(async (_how: { forget: boolean }) => {}) as Mock<
      (how: { forget: boolean }) => Promise<void>
    >,
    restart: vi.fn(async (_run?: { pid?: number }): Promise<RestartOutcome> => "restarted") as Mock<
      (run?: { pid?: number }) => Promise<RestartOutcome>
    >,
    login: false,
    stops: 0,
    /** Which run each stop asked to stop, when it named one. */
    stopped: [] as (OwnedRun | undefined)[],
  };
  const made = new Shell({
    joined: new JoinedHome(join(scratchDir("infinitary-shell-beside-"), "joined"), () => {}),
    openPage,
    beside: {
      door: doorDir,
      crewmatesDir: "/run/crewmates",
      look: new JoinedHome(join(scratchDir("infinitary-shell-beside-"), "look"), () => {}),
      status: () => command.records,
      startEntry: () => command.entry,
      // The entry's own wait is the rule's (besideRun.test.ts); here the window only waits to join.
      restartWaitMs: 0,
      presence: {
        getStartAtLogin: () => program.startAtLogin,
        setStartAtLogin: (enabled) => {
          program.startAtLogin = enabled;
        },
        setShowInDock: (visible) => program.dock.push(visible),
      },
      chooseFiles: async () => program.picked,
      installsUpdates: options.installsUpdates ?? false,
      programReplaced: () => command.programReplaced,
      ...(options.starts ? { starter } : {}),
      ownedRun: options.ownedRun ?? (() => OWNED),
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...(options.answerWaitMs === undefined ? {} : { answerWaitMs: options.answerWaitMs }),
      stopCommand: (only?: OwnedRun) => {
        starter.stops += 1;
        starter.stopped.push(only);
        return command.records.running === true;
      },
    },
    startCore,
    startConnection: () => {
      throw new Error("A window beside a command serves no connection.");
    },
    ...(options.readyMs !== undefined || options.dialHangs || options.links
      ? {
          localWindow: {
            ...(options.readyMs !== undefined ? { readyMs: options.readyMs } : {}),
            ...(options.dialHangs || options.links
              ? {
                  link: (linkOptions: ConstructorParameters<typeof HomeLink>[0]) => {
                    const link = new HomeLink({
                      ...linkOptions,
                      dial: async (grant, reached) => {
                        if (options.dialHangs?.()) return new Promise<never>(() => {});
                        return (
                          linkOptions.dial?.(grant, reached) ?? Promise.reject(new Error("no dial"))
                        );
                      },
                    });
                    options.links?.push(link);
                    return link;
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(options.workDir ? { work: { dataDir: options.workDir } } : {}),
    broadcast: (channel, payload) => pushes.push({ channel, payload }),
    notifications: {
      supported: () => true,
      focused: () => false,
      show: (notification) => program.notified.push(notification),
    },
    deviceName: async () => "MacBook Pro",
    restartWindows,
    relaunch,
    updates: ownUpdates().updates,
  });
  stops.push(() => made.dispose());
  return {
    shell: made,
    /**
     * Starts the window, then waits as the window's first request does: for the
     * command's first welcome, or for the window to stop waiting for one.
     */
    start: async () => {
      await made.start();
      await made.dispatch("inf:conversation:state", []).catch(() => {});
    },
    startCore,
    relaunch,
    restartWindows,
    openPage,
    pushes,
    command,
    program,
    starter,
  };
}
