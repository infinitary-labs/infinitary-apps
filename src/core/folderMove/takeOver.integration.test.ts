import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { workLabelOf } from "@shared/codeNames";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { pauseInBackground, readInstalled, writeInstalled } from "../helper/background";
import { handBackgroundOver, moveWork } from "../helper/moveWork";
import { helperPlace } from "../helper/place";
import { SESSION_AGENT_FILE } from "../helper/runAgent";
import { isProfileRetired } from "../storage/retiredProfile";
import { runMove } from "./move";
import {
  olderRunAgent,
  runsUnderAgent,
  stopOlderCopyNow,
  type TakeOverDeps,
  takeOverOlderCopy,
} from "./takeOver";

/**
 * Taking over from the older copy that holds the saved work (INF-5468's
 * plan, piece 3). The intent is the second user's report: his legacy
 * Firstmate 3000, started from a terminal, held the folder until he found
 * and killed its process by hand, and only then could the update go
 * through. Each case starts a real process that holds a scratch older
 * folder the way an older copy does - background work by
 * `work/running.lock`, a run a command started or a window by Chromium's
 * `SingletonLock` - and reads its program and arguments as the system keeps
 * them. That process is Node, standing in for our program by name;
 * launchctl is a stand-in that writes down what it was asked.
 */

const OLDER_LABEL = workLabelOf("fm", "release");
const HOSTNAME = "builder-mac";
/** The stand-in older copy runs as Node, named as one of our programs here. */
const PROGRAMS = [basename(process.execPath)];

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
  log: string;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  said: () => string[];
};

async function hold(
  from: string,
  words: string[],
  options: { stubborn?: boolean } = {},
): Promise<Holder> {
  const dir = scratchDir("infinitary-take-over-holder-");
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
  return { child, log, ended, said };
}

function stillRunning(holder: Holder): boolean {
  return holder.child.exitCode === null && holder.child.signalCode === null;
}

/** An older folder with saved work, its background agent recorded, and a launchctl stand-in. */
function olderFolder() {
  const appData = scratchDir("infinitary-take-over-");
  const homeDir = scratchDir("infinitary-take-over-home-");
  const from = join(appData, "firstmate-3000");
  const work = join(from, "work");
  mkdirSync(work, { recursive: true });
  const file = join(homeDir, "Library", "LaunchAgents", `${OLDER_LABEL}.plist`);
  writeInstalled(work, { service: { label: OLDER_LABEL, file }, app: null });
  const asked: string[][] = [];
  const launchctl = async (args: readonly string[]) => {
    asked.push([...args]);
    return { ok: true, output: "" };
  };
  const deps: TakeOverDeps = {
    platform: process.platform,
    hostname: HOSTNAME,
    programs: PROGRAMS,
    runsUnder: () => false,
    unloadAgent: (service) =>
      pauseInBackground(
        { flavor: "release", dataDir: work, spelling: "fm", homeDir, uid: 502, launchctl },
        service,
      ),
    waitMs: 5000,
  };
  return { appData, homeDir, from, work, asked, deps, service: { label: OLDER_LABEL, file } };
}

const holders: Holder[] = [];
async function started(from: string, words: string[], options?: { stubborn?: boolean }) {
  const holder = await hold(from, words, options);
  holders.push(holder);
  return holder;
}

describe("taking over from the older copy that holds the saved work", () => {
  afterEach(() => {
    for (const holder of holders.splice(0)) if (stillRunning(holder)) holder.child.kill("SIGKILL");
  });

  it("lets go of the older copy's background agent first, then its work run saves and exits", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["work", "run"]);
    expect(await takeOverOlderCopy(at.from, at.deps)).toEqual({
      kind: "stopped",
      copy: "work",
      unloaded: at.service,
    });
    expect(at.asked).toEqual([["bootout", `gui/502/${OLDER_LABEL}`]]);
    expect(await holder.ended).toEqual({ code: 0, signal: null });
    expect(holder.said()).toEqual(["holding", "asked to stop", "saved"]);
    expect(existsSync(join(at.work, "running.lock"))).toBe(false);
  });

  it("stops a run a command started, which has no agent to let go", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["run"]);
    expect(await takeOverOlderCopy(at.from, at.deps)).toEqual({ kind: "stopped", copy: "run" });
    expect(at.asked).toEqual([]);
    expect(await holder.ended).toEqual({ code: 0, signal: null });
  });

  it("leaves an older copy with its window open to the person's own Quit", async () => {
    const at = olderFolder();
    const holder = await started(at.from, []);
    expect(await takeOverOlderCopy(at.from, at.deps)).toEqual({ kind: "left", why: "window" });
    expect(stillRunning(holder)).toBe(true);
    expect(holder.said()).toEqual(["holding"]);
    expect(at.asked).toEqual([]);
  });

  it("never stops a process that is not ours", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["work", "run"]);
    expect(
      await takeOverOlderCopy(at.from, { ...at.deps, programs: ["Infinitary", "infinitary"] }),
    ).toEqual({ kind: "left", why: "not-ours" });
    expect(stillRunning(holder)).toBe(true);
    expect(holder.said()).toEqual(["holding"]);
    expect(at.asked).toEqual([]);
  });

  it("never lets go of the agent this process itself runs under", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["work", "run"]);
    expect(
      await takeOverOlderCopy(at.from, {
        ...at.deps,
        runsUnder: (label) => label === OLDER_LABEL,
      }),
    ).toEqual({ kind: "stopped", copy: "work" });
    expect(at.asked).toEqual([]);
    expect(await holder.ended).toEqual({ code: 0, signal: null });
  });

  it("asks before forcing: a copy that ignores the stop runs on until Stop it now", async () => {
    const at = olderFolder();
    const holder = await started(at.from, ["run"], { stubborn: true });
    expect(await takeOverOlderCopy(at.from, { ...at.deps, waitMs: 500 })).toEqual({
      kind: "still-running",
      pid: holder.child.pid,
      copy: "run",
    });
    expect(stillRunning(holder)).toBe(true);
    expect(holder.said()).toEqual(["holding", "asked to stop"]);
    expect(await stopOlderCopyNow(at.from, holder.child.pid as number, at.deps)).toEqual({
      free: true,
    });
    expect(await holder.ended).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("lets go of a run's start entry before Stop it now, which it would count as a failure", async () => {
    const at = olderFolder();
    // With Start at login off, the window's run agent is loaded from the older data folder's file.
    const session = join(at.from, SESSION_AGENT_FILE);
    writeFileSync(session, "<plist/>\n");
    const runAgent = olderRunAgent({
      spelling: "fm",
      flavor: "release",
      platform: "darwin",
      homeDir: at.homeDir,
      unitsDir: join(at.homeDir, ".config", "systemd", "user"),
      dataDir: at.from,
    });
    expect(runAgent?.file).toBe(session);
    if (!runAgent) throw new Error("A Mac has a run agent's place.");
    const deps = { ...at.deps, runAgent, waitMs: 500 };
    const holder = await started(at.from, ["run"], { stubborn: true });
    expect((await takeOverOlderCopy(at.from, deps)).kind).toBe("still-running");
    expect(at.asked).toEqual([]);
    expect(await stopOlderCopyNow(at.from, holder.child.pid as number, deps)).toEqual({
      free: true,
      unloaded: runAgent,
    });
    expect(at.asked).toEqual([["bootout", `gui/502/${runAgent.label}`]]);
    expect(await holder.ended).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("knows the systemd agent it runs under by the unit name the agent is recorded with", () => {
    // A user service's line in /proc/self/cgroup, and the label the systemd adapter records.
    const group = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${OLDER_LABEL}.service\n`;
    expect(runsUnderAgent(`${OLDER_LABEL}.service`, {}, () => group)).toBe(true);
    expect(runsUnderAgent(OLDER_LABEL, {}, () => group)).toBe(true);
    expect(runsUnderAgent(`${workLabelOf("inf", "release")}.service`, {}, () => group)).toBe(false);
  });

  it("starts the older work's agent again when its run does not stop for the work run's move", async () => {
    const at = olderFolder();
    writeFileSync(join(at.work, "home.json"), '{"grant":"the home it joined"}\n', { mode: 0o600 });
    const holder = await started(at.from, ["work", "run"], { stubborn: true });
    const place = helperPlace({
      packaged: true,
      flavor: "release",
      appData: at.appData,
      env: {},
      spelling: "inf",
    });
    const moved = await moveWork({
      place,
      background: (dataDir, spelling) => ({
        flavor: "release",
        dataDir,
        spelling,
        homeDir: at.homeDir,
        uid: 502,
        launchctl: async (args) => {
          at.asked.push([...args]);
          return { ok: true, output: "" };
        },
      }),
      launcher: { executable: "/opt/infinitary/infinitary", args: [] },
      env: {},
      deps: {
        platform: "linux",
        claudeConfigDir: scratchDir("infinitary-take-over-claude-"),
        hostname: HOSTNAME,
      },
      takeOver: {
        platform: process.platform,
        programs: PROGRAMS,
        runsUnder: () => false,
        waitMs: 500,
      },
      log: () => {},
    });
    expect(moved).toEqual({ kind: "later" });
    expect(stillRunning(holder)).toBe(true);
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${OLDER_LABEL}`],
      ["bootstrap", "gui/502", at.service.file],
    ]);
    expect(isProfileRetired(at.from)).toBe(false);
  });

  it("brings the work over from a work run instead of ending to be started again", async () => {
    const at = olderFolder();
    writeFileSync(join(at.work, "home.json"), '{"grant":"the home it joined"}\n', { mode: 0o600 });
    const holder = await started(at.from, ["work", "run"]);
    const place = helperPlace({
      packaged: true,
      flavor: "release",
      appData: at.appData,
      env: {},
      spelling: "inf",
    });
    expect(place.dataDir).toBe(at.work);
    const notes: string[] = [];
    const moved = await moveWork({
      place,
      background: (dataDir, spelling) => ({
        flavor: "release",
        dataDir,
        spelling,
        homeDir: at.homeDir,
        uid: 502,
        launchctl: async (args) => {
          at.asked.push([...args]);
          return { ok: true, output: "" };
        },
      }),
      launcher: { executable: "/opt/infinitary/infinitary", args: [] },
      env: {},
      deps: {
        platform: "linux",
        claudeConfigDir: scratchDir("infinitary-take-over-claude-"),
        hostname: HOSTNAME,
      },
      takeOver: { platform: process.platform, programs: PROGRAMS, runsUnder: () => false },
      log: (line) => notes.push(line),
    });
    expect(moved).toEqual({ kind: "handed-over" });
    expect(await holder.ended).toEqual({ code: 0, signal: null });
    expect(at.asked[0]).toEqual(["bootout", `gui/502/${OLDER_LABEL}`]);
    expect(isProfileRetired(at.from)).toBe(true);
    expect(existsSync(join(at.appData, "infinitary", "work", "home.json"))).toBe(true);
    expect(notes[0]).toContain(`after letting its agent ${OLDER_LABEL} go`);
  });
  // The captain's choice on the review: background work, which nobody watches, stops only an older work run.
  it("leaves a run a command started to the person when the work run moves", async () => {
    const at = olderFolder();
    writeFileSync(join(at.work, "home.json"), '{"grant":"the home it joined"}\n', { mode: 0o600 });
    const holder = await started(at.from, ["run"]);
    const place = helperPlace({
      packaged: true,
      flavor: "release",
      appData: at.appData,
      env: {},
      spelling: "inf",
    });
    const moved = await moveWork({
      place,
      background: (dataDir, spelling) => ({
        flavor: "release",
        dataDir,
        spelling,
        homeDir: at.homeDir,
        uid: 502,
        launchctl: async (args) => {
          at.asked.push([...args]);
          return { ok: true, output: "" };
        },
      }),
      launcher: { executable: "/opt/infinitary/infinitary", args: [] },
      env: {},
      deps: {
        platform: "linux",
        claudeConfigDir: scratchDir("infinitary-take-over-claude-"),
        hostname: HOSTNAME,
      },
      takeOver: { platform: process.platform, programs: PROGRAMS, runsUnder: () => false },
      log: () => {},
    });
    expect(moved).toEqual({ kind: "stayed", dataDir: at.work });
    expect(stillRunning(holder)).toBe(true);
    expect(holder.said()).toEqual(["holding"]);
    expect(at.asked).toEqual([]);
    expect(isProfileRetired(at.from)).toBe(false);
  });

  // The captain's choice on the review: after the window's move the background goes to the new label, as the work run's does.
  it("hands the older background to Infinitary's label after the window's take-over and move", async () => {
    const at = olderFolder();
    writeFileSync(join(at.work, "home.json"), '{"grant":"the home it joined"}\n', { mode: 0o600 });
    mkdirSync(join(at.homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(at.service.file, "<plist/>\n");
    const holder = await started(at.from, ["work", "run"]);
    const place = helperPlace({
      packaged: true,
      flavor: "release",
      appData: at.appData,
      env: {},
      spelling: "inf",
    });
    const move = place.move;
    if (!move) throw new Error("The scratch older folder should be due to move.");
    expect(await takeOverOlderCopy(at.from, at.deps)).toMatchObject({ kind: "stopped" });
    expect(await holder.ended).toEqual({ code: 0, signal: null });
    const deps = {
      platform: process.platform,
      claudeConfigDir: scratchDir("infinitary-take-over-claude-"),
      hostname: HOSTNAME,
    };
    expect((await runMove(move, deps)).kind).toBe("moved");
    const dataDir = join(move.to, "work");
    const label = workLabelOf("inf", "release");
    const handed = await handBackgroundOver(dataDir, {
      spelling: "inf",
      flavor: "release",
      background: (dir, spelling) => ({
        flavor: "release",
        dataDir: dir,
        spelling,
        homeDir: at.homeDir,
        uid: 502,
        launchctl: async (args) => {
          at.asked.push([...args]);
          return { ok: true, output: "" };
        },
      }),
      launcher: { executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary", args: [] },
      env: {},
      log: () => {},
    });
    expect(handed).toBe(true);
    expect(readInstalled(dataDir).service?.label).toBe(label);
    expect(existsSync(at.service.file)).toBe(false);
    expect(existsSync(join(at.homeDir, "Library", "LaunchAgents", `${label}.plist`))).toBe(true);
    expect(at.asked[0]).toEqual(["bootout", `gui/502/${OLDER_LABEL}`]);
    expect(at.asked).toContainEqual([
      "bootstrap",
      "gui/502",
      join(at.homeDir, "Library", "LaunchAgents", `${label}.plist`),
    ]);
    expect(at.asked.at(-1)).toEqual(["bootout", `gui/502/${OLDER_LABEL}`]);
  });
});
