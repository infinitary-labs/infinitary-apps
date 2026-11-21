import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FolderMove } from "@core/folderMove/due";
import type { TakeOverDeps } from "@core/folderMove/takeOver";
import { pauseInBackground, resumeInBackground, writeInstalled } from "@core/helper/background";
import { helperPlace } from "@core/helper/place";
import { isProfileRetired } from "@core/storage/retiredProfile";
import { workLabelOf } from "@shared/codeNames";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { RUN_WORDS } from "./runCommand";
import { type RunHandOverOptions, runHandOverInTerminal } from "./runHandOver";

/**
 * The one-time move for a run a command started (docs/run.md, "Before it
 * starts"). The intent is the user's report behind INF-5468: an older
 * Firstmate 3000 started from a terminal held the saved work, and the
 * update could not go on until he found its process and killed it by hand;
 * a run then only said to open the window once. Each case starts a real
 * process that holds a scratch older folder the way an older copy does -
 * background work by `work/running.lock`, a run a command started or a
 * window by Chromium's `SingletonLock` - and runs the real move into this
 * app's folder, reading what the run would print and what it asks. That
 * process is Node, standing in for our program by name; launchctl is a
 * stand-in that writes down what it was asked.
 */

const OLDER_LABEL = workLabelOf("fm", "release");
const HOSTNAME = "builder-mac";
/** The stand-in older copy runs as Node, named as one of our programs here. */
const PROGRAMS = [basename(process.execPath)];
const NAMES = { from: "Firstmate 3000", to: "Infinitary" };

/** The stand-in older copy: holds the folder as its arguments say, saves and exits on the ordinary stop unless stubborn. */
const HOLDER = `
const { mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const [from, log, stubborn, ...words] = process.argv.slice(2);
const work = words.includes("work");
const lock = work ? join(from, "work", "running.lock") : join(from, "SingletonLock");
if (work) { mkdirSync(join(from, "work"), { recursive: true }); writeFileSync(lock, process.pid + "\\n"); }
else symlinkSync(${JSON.stringify(HOSTNAME)} + "-" + process.pid, lock);
process.on("SIGTERM", () => {
  appendFileSync(log, "asked to stop\\n");
  if (stubborn === "stubborn") return;
  appendFileSync(log, "saved\\n");
  rmSync(lock, { force: true });
  process.exit(0);
});
appendFileSync(log, "holding\\n");
setInterval(() => {}, 1000);
`;

type Holder = {
  child: ChildProcess;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  said: () => string[];
};

const holders: Holder[] = [];

async function started(
  from: string,
  words: string[],
  options: { stubborn?: boolean } = {},
): Promise<Holder> {
  const dir = scratchDir("infinitary-run-hand-over-holder-");
  const script = join(dir, "holder.cjs");
  const log = join(dir, "holder.log");
  writeFileSync(script, HOLDER);
  writeFileSync(log, "");
  const child = spawn(
    process.execPath,
    [script, from, log, options.stubborn ? "stubborn" : "polite", ...words],
    { stdio: "ignore" },
  );
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const said = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  for (let at = 0; !said().includes("holding"); at += 1) {
    if (at > 100) throw new Error("The stand-in older copy never took the folder.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const holder = { child, ended, said };
  holders.push(holder);
  return holder;
}

function stillRunning(holder: Holder): boolean {
  return holder.child.exitCode === null && holder.child.signalCode === null;
}

/**
 * Firstmate 3000's folder with saved work and its background agent
 * recorded, due to move into Infinitary's, and what a run hands over with:
 * every line it prints, the answer it is given at a terminal, and a
 * launchctl stand-in.
 */
function olderFolder(answer?: string) {
  const appData = scratchDir("infinitary-run-hand-over-");
  const homeDir = scratchDir("infinitary-run-hand-over-home-");
  const from = join(appData, "firstmate-3000");
  const work = join(from, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(from, "saved-work.txt"), "the record\n", { mode: 0o600 });
  writeFileSync(join(work, "home.json"), '{"grant":"the home it joined"}\n', { mode: 0o600 });
  const service = {
    label: OLDER_LABEL,
    file: join(homeDir, "Library", "LaunchAgents", `${OLDER_LABEL}.plist`),
  };
  writeInstalled(work, { service, app: null });
  const move = helperPlace({
    packaged: true,
    flavor: "release",
    appData,
    env: {},
    spelling: "inf",
  }).move as FolderMove;
  if (!move) throw new Error("The scratch older folder should be due to move.");
  const asked: string[][] = [];
  const background = {
    flavor: "release" as const,
    dataDir: work,
    spelling: "fm" as const,
    homeDir,
    uid: 502,
    launchctl: async (args: readonly string[]) => {
      asked.push([...args]);
      return { ok: true, output: "" };
    },
  };
  const takeOver: TakeOverDeps = {
    platform: process.platform,
    hostname: HOSTNAME,
    programs: PROGRAMS,
    runsUnder: () => false,
    unloadAgent: (service) => pauseInBackground(background, service),
    resumeAgent: (service) => resumeInBackground(background, service),
    waitMs: 5000,
  };
  const printed: string[] = [];
  const questions: { lines: readonly string[]; prompt: string }[] = [];
  const handedOver: string[] = [];
  const stop = new AbortController();
  const options: RunHandOverOptions = {
    names: NAMES,
    deps: {
      platform: process.platform,
      claudeConfigDir: scratchDir("infinitary-run-hand-over-claude-"),
      hostname: HOSTNAME,
    },
    takeOver,
    say: (lines) => printed.push(...lines),
    ...(answer === undefined
      ? {}
      : {
          ask: async (lines: readonly string[], prompt: string) => {
            questions.push({ lines, prompt });
            return answer;
          },
        }),
    signal: stop.signal,
    startAtLogin: () => {},
    handBackground: async () => handedOver.push(move.to),
  };
  return {
    from,
    work,
    move,
    service,
    asked,
    takeOver,
    printed,
    questions,
    handedOver,
    stop,
    options,
  };
}

/** Whether the saved work reached Infinitary's own folder. */
function movedIn(move: FolderMove): boolean {
  return (
    existsSync(join(move.to, "saved-work.txt")) && existsSync(join(move.to, "work", "home.json"))
  );
}

// The move runs the system's copier on each case's scratch folder.
describe("a run hands over the one-time move in its terminal", { timeout: 10_000 }, () => {
  afterEach(() => {
    for (const holder of holders.splice(0)) if (stillRunning(holder)) holder.child.kill("SIGKILL");
  });

  it("stops an older run a command started, moves the work, and says each step", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["run"]);
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({ kind: "here" });
    expect(await holder.ended).toEqual({ code: 0, signal: null });
    expect(holder.said()).toEqual(["holding", "asked to stop", "saved"]);
    expect(movedIn(at.move)).toBe(true);
    expect(isProfileRetired(at.from)).toBe(true);
    expect(at.printed.slice(0, 4)).toEqual([
      m.handoverStoppingTitle({ from: NAMES.from }),
      m.handoverStoppingText(NAMES),
      m.handoverRunMoving(NAMES),
      m.handoverRunContinueLater({ to: NAMES.to }),
    ]);
    expect(at.printed).toContain(m.handoverRunChecking());
    expect(at.printed.at(-1)).toBe(m.handoverRunMoved(NAMES));
    expect(at.handedOver).toEqual([at.move.to]);
    expect(at.asked).toEqual([]);
  });

  it("lets go of the older background agent first when its work run holds the folder", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["work", "run"]);
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({ kind: "here" });
    expect(await holder.ended).toEqual({ code: 0, signal: null });
    expect(at.asked).toEqual([["bootout", `gui/502/${OLDER_LABEL}`]]);
    expect(movedIn(at.move)).toBe(true);
    expect(at.handedOver).toEqual([at.move.to]);
  });

  it("asks before forcing: a yes typed at a terminal ends a copy that ignores the stop, then moves", async () => {
    const at = olderFolder("yes\n");
    at.options.takeOver = { ...at.takeOver, waitMs: 500 };
    const holder = await started(at.from, ["run"], { stubborn: true });
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({ kind: "here" });
    expect(at.questions).toEqual([
      {
        lines: [
          m.handoverWontStopTitle({ from: NAMES.from }),
          m.handoverRunWontStop({ to: NAMES.to }),
        ],
        prompt: `${m.handoverRunStopPrompt()} `,
      },
    ]);
    expect(await holder.ended).toEqual({ code: null, signal: "SIGKILL" });
    expect(movedIn(at.move)).toBe(true);
  });

  it("never forces with no terminal to answer: the copy runs on and nothing changes", async () => {
    const at = olderFolder();
    at.options.takeOver = { ...at.takeOver, waitMs: 500 };
    const holder = await started(at.from, ["run"], { stubborn: true });
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({
      kind: "ended",
      end: {
        reason: "start-failed",
        exitCode: 1,
        lines: [
          m.handoverWontStopTitle({ from: NAMES.from }),
          m.handoverRunNoTerminal({ to: NAMES.to }),
        ],
      },
    });
    expect(stillRunning(holder)).toBe(true);
    expect(holder.said()).toEqual(["holding", "asked to stop"]);
    expect(movedIn(at.move)).toBe(false);
    expect(isProfileRetired(at.from)).toBe(false);
  });

  it("leaves the copy running on any answer but yes, and starts its agent again", async () => {
    const at = olderFolder("no");
    at.options.takeOver = { ...at.takeOver, waitMs: 500 };
    const holder = await started(at.from, ["work", "run"], { stubborn: true });
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({
      kind: "ended",
      end: {
        reason: "start-failed",
        exitCode: 1,
        lines: [m.handoverRunLeftRunning({ from: NAMES.from })],
      },
    });
    expect(stillRunning(holder)).toBe(true);
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${OLDER_LABEL}`],
      ["bootstrap", "gui/502", at.service.file],
    ]);
    expect(movedIn(at.move)).toBe(false);
    expect(isProfileRetired(at.from)).toBe(false);
  });

  it("leaves an older copy with its window open to the person's own Quit", async () => {
    const at = olderFolder("yes");
    const holder = await started(at.from, []);
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({
      kind: "ended",
      end: {
        reason: "start-failed",
        exitCode: 1,
        lines: [m.handoverRunStillOpen(NAMES)],
      },
    });
    expect(stillRunning(holder)).toBe(true);
    expect(holder.said()).toEqual(["holding"]);
    expect(at.questions).toEqual([]);
    expect(movedIn(at.move)).toBe(false);
  });

  it("ends cleanly on a stop while it waits, with nothing changed and the agent started again", async () => {
    const at = olderFolder("yes");
    const holder = await started(at.from, ["work", "run"], { stubborn: true });
    // Ctrl-C once the older copy was asked to stop, as a person would press it during the wait.
    const say = at.options.say;
    at.options.say = (lines) => {
      say(lines);
      if (lines.includes(m.handoverStoppingTitle({ from: NAMES.from })))
        setTimeout(() => at.stop.abort(), 300);
    };
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({
      kind: "ended",
      end: { reason: "signal", exitCode: 0, lines: [RUN_WORDS.stopped] },
    });
    expect(at.questions).toEqual([]);
    expect(stillRunning(holder)).toBe(true);
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${OLDER_LABEL}`],
      ["bootstrap", "gui/502", at.service.file],
    ]);
    expect(movedIn(at.move)).toBe(false);
    expect(isProfileRetired(at.from)).toBe(false);
  });

  it("moves at once when nothing holds the older folder", async () => {
    const at = olderFolder();
    expect(await runHandOverInTerminal(at.move, at.options)).toEqual({ kind: "here" });
    expect(movedIn(at.move)).toBe(true);
    expect(at.printed[0]).toBe(m.handoverRunMoving(NAMES));
    expect(at.printed.at(-1)).toBe(m.handoverRunMoved(NAMES));
  });
});
