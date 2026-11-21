import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { execStart } from "../../../tests/helpers/unitExecStart";
import { bootPlist, bootUnit, runAgentEnv, wantedBy } from "./background";
import {
  loginAgentFile,
  type RunAgentContext,
  restartRunAgent,
  runAgentAtLogin,
  runAgentInPlace,
  sessionAgentFile,
  setRunAgentAtLogin,
  startRunAgent,
  stopRunAgent,
} from "./runAgent";
import {
  RUN_RECORD_FILE,
  RUN_STOP_FILE,
  RUN_STOP_FOR_FILE,
  readRunTask,
  registerRunTask,
  runTaskFile,
  runTaskXml,
} from "./windowsTask";

/**
 * The command the window starts (docs/run.md, "The window starts it";
 * INF-1352's plan, piece 7, the captain's answer starter=login-agent: "The
 * window sets it up in the background through the seam a work computer
 * uses, so a crash restarts it and Start at login keeps it"). launchctl
 * and systemctl are stand-ins that write down what they were asked: no
 * test ever loads an agent or starts a service.
 */

const LAUNCHER = {
  executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary",
  args: [],
};
const LABEL = "com.infinitary.app.dev.run";

/** How the service manager answers a stop: refused while it still holds the job, or the job already gone. */
type StopAnswer = "refused" | "gone" | "unreadable" | "restarting";

/** One run, by its process and the start its own record keeps. */
type Run = { pid: number; startedAt: string };

/** The run's own record in the data folder, as `<app> run` writes it, its agent's mark included. */
function recordRun(context: RunAgentContext, run: Run, agent: boolean): void {
  writeFileSync(
    join(context.dataDir, RUN_RECORD_FILE),
    `${JSON.stringify({ ...run, ...(agent ? { agent } : {}) })}\n`,
  );
}

/** The run a notice names, and others that may hold the folder by the time a button acts. */
const NAMED: Run = { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" };
/** The same process number taken by another run since: another start. */
const REUSED: Run = { pid: 4242, startedAt: "2026-10-25T17:05:00.000Z" };
/** A run started again in the named one's place, by the job or by hand. */
const REPLACEMENT: Run = { pid: 5151, startedAt: "2026-10-25T17:05:00.000Z" };
/** The named run's program was born just before it wrote its start. */
const BORN_NAMED = Date.parse(NAMED.startedAt) - 400;
/** A program born after the named run wrote its start: one that took its process number since. */
const BORN_LATER = Date.parse(REUSED.startedAt) - 400;

/**
 * This computer's programs, as a restart opens them by process number: the
 * program under each number now, with its birth. One is ended through the
 * instance it was opened as, as a Windows handle ends it, so a program that
 * took the number since is never ended, and each end is written down beside
 * the service manager's asks.
 */
function programTable(asked: string[][]) {
  const table = new Map<number, { bornMs: number | undefined }>();
  const programs = {
    /** A program runs under `pid`, born at `bornMs` (undefined where its birth cannot be read). */
    run: (pid: number, bornMs: number | undefined) => table.set(pid, { bornMs }),
    /** What happens as a program is ended, before anything reads again. */
    onEnd: undefined as ((pid: number) => void) | undefined,
    /** Whether ending a program is refused, as Windows refuses a program not this account's. */
    refused: false,
    processes: {
      alive: (pid: number) => table.has(pid),
      open: async (pid: number) => {
        const program = table.get(pid);
        if (!program) return null;
        return {
          bornMs: program.bornMs,
          end: () => {
            asked.push(["end", String(pid)]);
            if (programs.refused) throw new Error("Access is denied.");
            if (table.get(pid) === program) table.delete(pid);
            programs.onEnd?.(pid);
          },
          ended: async () => table.get(pid) !== program,
          close: () => {},
        };
      },
    },
  };
  return programs;
}

function mac(
  answers: { bootstrap?: boolean; session?: boolean; stop?: StopAnswer; job?: number } = {},
) {
  const asked: string[][] = [];
  const programs = programTable(asked);
  const context: RunAgentContext = {
    processes: programs.processes,
    label: LABEL,
    dataDir: scratchDir("infinitary-run-agent-data-"),
    homeDir: scratchDir("infinitary-run-agent-home-"),
    uid: 502,
    unitsDir: "/nowhere",
    launcher: LAUNCHER,
    env: { INFINITARY_USER_DATA_DIR: "/tmp/a & b" },
    launchctl: async (args) => {
      asked.push([...args]);
      if (args[0] === "bootstrap" && answers.bootstrap === false)
        return { ok: false, output: "Bootstrap failed: 5: Input/output error" };
      if (args[0] === "print" && answers.session === false)
        return { ok: false, output: `Could not find domain for user ${args[1]}` };
      if (args[0] === "bootout" && answers.stop)
        return { ok: false, output: "Boot-out failed: 5: Input/output error" };
      if (args[0] === "print" && args[1] === `gui/502/${LABEL}` && answers.stop === "gone")
        return {
          ok: false,
          output: `Could not find service "${LABEL}" in domain for user gui: 502`,
          code: 113,
        };
      // A launchctl that timed out, which answers nothing of the job.
      if (args[0] === "print" && args[1] === `gui/502/${LABEL}` && answers.stop === "unreadable")
        return { ok: false, output: "" };
      // The job's own instance: the process launchd runs for it now.
      if (args[0] === "print" && args[1] === `gui/502/${LABEL}` && answers.job !== undefined)
        return { ok: true, output: `${LABEL} = {\n\tstate = running\n\tpid = ${answers.job}\n}\n` };
      return { ok: true, output: "" };
    },
  };
  return { context, asked, programs, answers };
}

function linux(answers: { session?: boolean; stop?: StopAnswer; job?: number } = {}) {
  const asked: string[][] = [];
  const unitsDir = join(scratchDir("infinitary-run-agent-config-"), "systemd", "user");
  const programs = programTable(asked);
  const context: RunAgentContext = {
    processes: programs.processes,
    label: LABEL,
    dataDir: scratchDir("infinitary-run-agent-data-"),
    homeDir: scratchDir("infinitary-run-agent-home-"),
    uid: 1000,
    unitsDir,
    launcher: { executable: "/usr/bin/infinitary", args: [] },
    env: {},
    configHome: "/nowhere",
    runtime: () => "systemd",
    systemctl: async (args) => {
      asked.push([...args]);
      if (args.includes("show-environment") && answers.session === false)
        return { ok: false, output: "Failed to connect to bus" };
      if (args.includes("--system")) return { ok: true, output: "inactive\n" };
      // The unit's own instance: the process systemd runs for it now, 0 for none.
      if (args.includes("--property=MainPID")) return { ok: true, output: `${answers.job ?? 0}\n` };
      if (args[1] === "stop" && answers.stop)
        return { ok: false, output: `Failed to stop ${LABEL}.service: Access denied` };
      if (args[1] === "show" && answers.stop === "gone") return { ok: true, output: "inactive\n" };
      // A unit waiting out RestartSec to start its run again.
      if (args[1] === "show" && answers.stop === "restarting")
        return { ok: true, output: "activating\n" };
      // A user manager that refused the ask, which says nothing of the unit.
      if (args[1] === "show" && answers.stop === "unreadable")
        return { ok: false, output: "Failed to connect to bus: Connection refused", code: 1 };
      return { ok: true, output: "" };
    },
  };
  return { context, asked, programs, answers, unit: join(unitsDir, `${LABEL}.service`) };
}

describe("the command the window starts, on a Mac", () => {
  it("loads an agent from the data folder that runs the command and restarts it after a failure", async () => {
    const { context, asked } = mac();
    expect(await startRunAgent(context)).toBe("running");
    const file = sessionAgentFile(context);
    expect(asked).toEqual([
      ["bootout", `gui/502/${LABEL}`],
      ["bootstrap", "gui/502", file],
    ]);
    const plist = readFileSync(file, "utf8");
    expect(plist).toContain(
      `<array>\n\t\t<string>${LAUNCHER.executable}</string>\n\t\t<string>run</string>\n\t</array>`,
    );
    // Started again after a failed exit (a crash, an update's 75), never after a clean stop.
    expect(plist).toContain("<key>SuccessfulExit</key>\n\t\t<false/>");
    expect(plist).toContain(`<string>${join(context.dataDir, "run.log")}</string>`);
    expect(plist).toContain("<string>/tmp/a &amp; b</string>");
    // Start at login is off: launchd never reads the data folder by itself.
    expect(existsSync(loginAgentFile(context))).toBe(false);
    expect(runAgentAtLogin(context)).toBe(false);
    expect(runAgentInPlace(context)).toBe(true);
  });

  it("moves the agent into LaunchAgents for Start at login, and starts it from there", async () => {
    const { context, asked } = mac();
    await startRunAgent(context);
    setRunAgentAtLogin(context, true);
    expect(runAgentAtLogin(context)).toBe(true);
    expect(existsSync(sessionAgentFile(context))).toBe(false);
    asked.length = 0;
    expect(await startRunAgent(context)).toBe("running");
    expect(asked.at(-1)).toEqual(["bootstrap", "gui/502", loginAgentFile(context)]);
    setRunAgentAtLogin(context, false);
    expect(runAgentAtLogin(context)).toBe(false);
    expect(existsSync(sessionAgentFile(context))).toBe(true);
  });

  // start-at-boot writes this same agent on a Mac (docs/run.md, "Starting at boot"): the window
  // starting it again keeps the settings file and log the person gave it, as a Linux unit does.
  it("writes start-at-boot's agent again for this program, keeping its settings file and log", async () => {
    const { context } = mac();
    const file = loginAgentFile(context);
    const settings = "/Users/kai/run & co.json";
    const log = "/Users/kai/Library/Logs/run <1>.log";
    const moved = {
      executable: "/Users/kai/Old Infinitary.app/Contents/MacOS/Infinitary",
      args: [],
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bootPlist({ label: LABEL, launcher: moved, settings, log, env: {} }));
    expect(await startRunAgent(context)).toBe("running");
    const current = bootPlist({
      label: LABEL,
      launcher: context.launcher,
      settings,
      log,
      env: runAgentEnv(context.label, context.env),
    });
    expect(readFileSync(file, "utf8")).toBe(current);
    setRunAgentAtLogin(context, false);
    expect(readFileSync(sessionAgentFile(context), "utf8")).toBe(current);
  });

  it("says when it could not start, and with no login session that it waits for one", async () => {
    expect(await startRunAgent(mac({ bootstrap: false }).context)).toBe("failed");
    expect(await startRunAgent(mac({ bootstrap: false, session: false }).context)).toBe("at-login");
  });

  it("lets the agent go, and with forget leaves nothing to start it again", async () => {
    const { context, asked } = mac();
    await startRunAgent(context);
    setRunAgentAtLogin(context, true);
    asked.length = 0;
    await stopRunAgent(context, { forget: false });
    expect(asked).toEqual([["bootout", `gui/502/${LABEL}`]]);
    expect(runAgentAtLogin(context)).toBe(true);
    await stopRunAgent(context, { forget: true });
    expect(runAgentInPlace(context)).toBe(false);
  });

  // The review of INF-5409: launchd runs only this agent's own runs, so letting the agent go for a
  // join ends its job whichever run it holds now: one it started again during the join stops too,
  // never left holding the data folder beside the view. A run started by hand is never the job's.
  it("ends the agent's job for a join though the run it holds is not the one the window named", async () => {
    const { context, asked } = mac();
    await startRunAgent(context);
    asked.length = 0;
    await stopRunAgent(context, {
      forget: true,
      run: { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" },
    });
    expect(asked).toEqual([["bootout", `gui/502/${LABEL}`]]);
    expect(runAgentInPlace(context)).toBe(false);
  });

  // The review of INF-5409: a job launchd would not end, and still holds, may start its run again
  // beside the view, so letting it go says so; one already gone is let go quietly.
  it("rejects when launchd keeps the agent's job or cannot say, and not when it holds no such job", async () => {
    const refused = mac({ stop: "refused" });
    await expect(stopRunAgent(refused.context, { forget: true })).rejects.toThrow(
      "Boot-out failed",
    );
    const gone = mac({ stop: "gone" });
    await expect(stopRunAgent(gone.context, { forget: true })).resolves.toBeUndefined();
    // A launchctl that cannot say whether it still holds the job is not proof it is gone.
    const unreadable = mac({ stop: "unreadable" });
    await expect(stopRunAgent(unreadable.context, { forget: true })).rejects.toThrow(
      "Boot-out failed",
    );
    // Any other stop, as before an update replaces the copy, answers as it always has.
    await expect(stopRunAgent(refused.context, { forget: false })).resolves.toBeUndefined();
  });

  // The review of INF-5409: launchd's `kickstart -k` and bootout end whichever run the job holds by
  // then, so Restart it ends the named run through its own program, and asks launchd only to start
  // the job, which starts nothing where it already runs; Start it here lets the job go only while
  // it runs nothing, so a run it started again meanwhile keeps going.
  it("ends the named run its agent started by its program, then asks launchd only to start the job", async () => {
    const job = ["print", `gui/502/${LABEL}`];
    const restart = mac();
    recordRun(restart.context, NAMED, true);
    restart.programs.run(NAMED.pid, BORN_NAMED);
    expect(await restartRunAgent(restart.context, NAMED)).toBe("restarted");
    expect(restart.asked).toEqual([
      ["end", String(NAMED.pid)],
      ["kickstart", `gui/502/${LABEL}`],
    ]);
    expect(restart.programs.processes.alive(NAMED.pid)).toBe(false);

    const startHere = mac();
    recordRun(startHere.context, NAMED, true);
    startHere.programs.run(NAMED.pid, BORN_NAMED);
    await stopRunAgent(startHere.context, { forget: false, force: NAMED });
    expect(startHere.asked).toEqual([
      ["end", String(NAMED.pid)],
      job,
      ["bootout", `gui/502/${LABEL}`],
    ]);
  });

  it("keeps a run the job started again as the named one ended, on Start it here", async () => {
    const { context, asked, programs, answers } = mac();
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, BORN_NAMED);
    // launchd starts the job's run again the moment the named one ends.
    programs.onEnd = () => {
      programs.run(REPLACEMENT.pid, Date.parse(REPLACEMENT.startedAt));
      answers.job = REPLACEMENT.pid;
    };
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked).toEqual([
      ["end", String(NAMED.pid)],
      ["print", `gui/502/${LABEL}`],
    ]);
    expect(programs.processes.alive(REPLACEMENT.pid)).toBe(true);
    // A job launchd cannot say about is not let go either.
    const unreadable = mac({ stop: "unreadable" });
    recordRun(unreadable.context, NAMED, true);
    unreadable.programs.run(NAMED.pid, BORN_NAMED);
    await stopRunAgent(unreadable.context, { forget: false, force: NAMED });
    expect(unreadable.asked.filter(([verb]) => verb === "bootout")).toEqual([]);
  });

  // The review of INF-5409: a program that is not the named run, or cannot be shown to be, is
  // neither ended nor its job asked anything: one that took the named run's number since (born
  // after its start), one whose birth cannot be read, one started by hand, and another run there.
  it("ends nothing for a program that is not the named run its agent started", async () => {
    for (const [record, agent, born] of [
      [NAMED, true, BORN_LATER],
      [NAMED, true, undefined],
      [NAMED, false, BORN_NAMED],
      [REUSED, true, BORN_LATER],
    ] as const) {
      const other = mac();
      recordRun(other.context, record, agent);
      other.programs.run(NAMED.pid, born);
      expect(await restartRunAgent(other.context, NAMED)).toBe("untouched");
      await stopRunAgent(other.context, { forget: false, force: NAMED });
      expect(other.asked).toEqual([]);
      expect(other.programs.processes.alive(NAMED.pid)).toBe(true);
    }
  });
});

describe("the command the window starts, on Linux", () => {
  it("starts the user service start-at-boot writes, wanted by the login only for Start at login", async () => {
    const { context, asked, unit } = linux();
    expect(await startRunAgent(context)).toBe("running");
    expect(asked.slice(1)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "start", LABEL],
    ]);
    const text = readFileSync(unit, "utf8");
    expect(text).toContain(`ExecStart="/usr/bin/infinitary" "--ozone-platform=x11" "run"`);
    expect(text).toContain("Restart=on-failure");
    expect(runAgentAtLogin(context)).toBe(false);
    setRunAgentAtLogin(context, true);
    expect(lstatSync(wantedBy(unit)).isSymbolicLink()).toBe(true);
    expect(realpathSync(wantedBy(unit))).toBe(realpathSync(unit));
    expect(runAgentAtLogin(context)).toBe(true);
    setRunAgentAtLogin(context, false);
    expect(runAgentAtLogin(context)).toBe(false);
  });

  // The reviewer's finding on INF-1352's piece 7: a unit naming a program that moved (an AppImage
  // replaced under a new name) still starts, so the run never would.
  it("writes the unit again for a program that moved, keeping the settings file it names", async () => {
    const { context, unit } = linux();
    const settings = "/home/kai/run 100%.json";
    mkdirSync(dirname(unit), { recursive: true });
    const moved = { executable: "/home/kai/Infinitary-1.2.AppImage", args: [] };
    writeFileSync(unit, bootUnit({ launcher: moved, settings, env: {} }));
    await startRunAgent(context);
    const current = bootUnit({
      launcher: context.launcher,
      settings,
      env: runAgentEnv(context.label, context.env),
    });
    expect(readFileSync(unit, "utf8")).toBe(current);
  });

  // Found by the live proof on a real systemd for INF-1352's piece 7: a unit a run for another data
  // folder left names that folder, so the run it starts would never open this window's.
  it("writes the unit again when its settings are another run's", async () => {
    const { context, unit } = linux();
    mkdirSync(dirname(unit), { recursive: true });
    const other = { INFINITARY_USER_DATA_DIR: "/tmp/another-run" };
    writeFileSync(unit, bootUnit({ launcher: context.launcher, env: other }));
    await startRunAgent(context);
    expect(readFileSync(unit, "utf8")).toBe(
      bootUnit({ launcher: context.launcher, env: runAgentEnv(context.label, context.env) }),
    );
  });

  // A user's report on Infinitary 0.8.0 under niri, reproduced on a real niri session by INF-4321:
  // niri puts XDG_SESSION_TYPE=wayland into the user's systemd, Electron picks Wayland from it,
  // finds no display and ends, and systemd starts it again every ten seconds. Chromium chooses
  // before the app's code runs, so the unit's command names X11, the run's own display, and the
  // unit 0.8.0 wrote, word for word, is written again at the window's next start.
  it("starts the run on X11 whatever session the user's systemd describes, even over 0.8.0's unit", async () => {
    const { context, unit } = linux();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(
      unit,
      [
        '# Infinitary started at boot for this user (docs/run.md, "Starting at boot").',
        "[Unit]",
        "Description=Infinitary",
        "StartLimitIntervalSec=0",
        "",
        "[Service]",
        "Type=simple",
        "UnsetEnvironment=WAYLAND_DISPLAY",
        'ExecStart="/usr/bin/infinitary" "run"',
        "Restart=on-failure",
        "RestartSec=10",
        "RestartPreventExitStatus=78",
        "TimeoutStopSec=20",
        "KillMode=mixed",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    await startRunAgent(context);
    const text = readFileSync(unit, "utf8");
    expect(text).toBe(
      bootUnit({ launcher: context.launcher, env: runAgentEnv(context.label, context.env) }),
    );
    expect(execStart(text)).toEqual(["/usr/bin/infinitary", "--ozone-platform=x11", "run"]);
  });

  it("starts nothing with no user manager to start it, and forgets its unit on forget", async () => {
    const { context: none } = linux({ session: false });
    expect(await startRunAgent(none)).toBe("at-login");
    const { context, asked, unit } = linux();
    await startRunAgent(context);
    setRunAgentAtLogin(context, true);
    asked.length = 0;
    await stopRunAgent(context, { forget: true });
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(wantedBy(unit))).toBe(false);
    expect(asked).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "stop", LABEL],
    ]);
  });

  // The review of INF-5409: the user service runs only this agent's own runs, so a join ends it
  // whichever run it holds now, one systemd started again during the join included.
  it("stops the agent's service for a join though the run it holds is not the one the window named", async () => {
    const { context, asked } = linux();
    await startRunAgent(context);
    asked.length = 0;
    await stopRunAgent(context, {
      forget: true,
      run: { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" },
    });
    expect(asked).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "stop", LABEL],
    ]);
  });

  // The review of INF-5409: a service systemd would not stop, and still runs, says so.
  it("rejects when systemd keeps the agent's service running, waiting to start again or cannot say, and not when it is stopped", async () => {
    const refused = linux({ stop: "refused" });
    await expect(stopRunAgent(refused.context, { forget: true })).rejects.toThrow("Access denied");
    const gone = linux({ stop: "gone" });
    await expect(stopRunAgent(gone.context, { forget: true })).resolves.toBeUndefined();
    expect(gone.asked.at(-1)).toEqual([
      "--user",
      "show",
      "--property=ActiveState",
      "--value",
      LABEL,
    ]);
    const restarting = linux({ stop: "restarting" });
    await expect(stopRunAgent(restarting.context, { forget: true })).rejects.toThrow(
      "Access denied",
    );
    const unreadable = linux({ stop: "unreadable" });
    await expect(stopRunAgent(unreadable.context, { forget: true })).rejects.toThrow(
      "Access denied",
    );
    await expect(stopRunAgent(refused.context, { forget: false })).resolves.toBeUndefined();
  });

  // As on a Mac: systemd's kill and stop end whichever run the unit holds by then, so Restart it
  // ends the named run through its own program and asks systemd only to start the unit, and Start
  // it here stops the unit only while it runs nothing.
  it("ends the named run its agent started by its program, then asks systemd only to start the unit", async () => {
    const restart = linux();
    recordRun(restart.context, NAMED, true);
    restart.programs.run(NAMED.pid, BORN_NAMED);
    expect(await restartRunAgent(restart.context, NAMED)).toBe("restarted");
    expect(restart.asked).toEqual([
      ["end", String(NAMED.pid)],
      ["--user", "start", LABEL],
    ]);

    const startHere = linux();
    recordRun(startHere.context, NAMED, true);
    startHere.programs.run(NAMED.pid, BORN_NAMED);
    await stopRunAgent(startHere.context, { forget: false, force: NAMED });
    expect(startHere.asked).toEqual([
      ["end", String(NAMED.pid)],
      ["--user", "show", "--property=MainPID", "--value", LABEL],
      ["--user", "stop", LABEL],
    ]);
  });

  it("keeps a run the unit started again as the named one ended, and ends nothing for another program", async () => {
    const { context, asked, programs, answers } = linux();
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, BORN_NAMED);
    programs.onEnd = () => {
      programs.run(REPLACEMENT.pid, Date.parse(REPLACEMENT.startedAt));
      answers.job = REPLACEMENT.pid;
    };
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked.filter((args) => args[1] === "stop")).toEqual([]);
    expect(programs.processes.alive(REPLACEMENT.pid)).toBe(true);
    for (const born of [BORN_LATER, undefined]) {
      const other = linux();
      recordRun(other.context, NAMED, true);
      other.programs.run(NAMED.pid, born);
      expect(await restartRunAgent(other.context, NAMED)).toBe("untouched");
      await stopRunAgent(other.context, { forget: false, force: NAMED });
      expect(other.asked).toEqual([]);
      expect(other.programs.processes.alive(NAMED.pid)).toBe(true);
    }
  });
});

function windows(answers: { create?: boolean; remove?: boolean } = {}) {
  const asked: string[][] = [];
  const programs = programTable(asked);
  const context: RunAgentContext = {
    label: LABEL,
    dataDir: scratchDir("infinitary-run-agent-data-"),
    homeDir: scratchDir("infinitary-run-agent-home-"),
    uid: -1,
    unitsDir: "/nowhere",
    launcher: { executable: "C:\\Program Files\\Infinitary\\Infinitary.exe", args: [] },
    env: {},
    account: "DESKTOP-7Q2\\ada",
    processes: programs.processes,
    schtasks: Object.assign(
      async (args: readonly string[]) => {
        asked.push([...args]);
        if (args[0] === "/Create" && answers.create === false)
          return { ok: false, output: "ERROR: Access is denied." };
        if (args[0] === "/Delete" && answers.remove === false)
          return { ok: false, output: "ERROR: Access is denied." };
        return { ok: true, output: "SUCCESS" };
      },
      // Task Scheduler's own answer for the task: still there where it would not take it away.
      { lookup: async () => (answers.remove === false ? ("there" as const) : ("gone" as const)) },
    ),
  };
  return { context, asked, programs };
}

// INF-4243's plan, piece 5: "<app> run is registered at your login through Windows' Task
// Scheduler, and the window starts it as on Mac and Linux."
describe("the command the window starts, on Windows", () => {
  it("registers the task for this program and runs it, its sign-in trigger off until Start at login", async () => {
    const { context, asked } = windows();
    expect(runAgentInPlace(context)).toBe(false);
    expect(await startRunAgent(context)).toBe("running");
    const file = runTaskFile(context.dataDir);
    expect(asked).toEqual([
      ["/Create", "/TN", LABEL, "/XML", file, "/F"],
      ["/Run", "/TN", LABEL],
    ]);
    expect(runAgentInPlace(context)).toBe(true);
    expect(runAgentAtLogin(context)).toBe(false);
    setRunAgentAtLogin(context, true);
    expect(runAgentAtLogin(context)).toBe(true);
    setRunAgentAtLogin(context, false);
    expect(runAgentAtLogin(context)).toBe(false);
  });

  it("registers the task again for a program that moved, keeping start-at-boot's settings and trigger", async () => {
    const { context } = windows();
    const file = runTaskFile(context.dataDir);
    const settings = "C:\\Users\\Ada Lovelace\\run settings.json";
    const moved = { executable: "D:\\Old\\Infinitary.exe", args: [] };
    const xml = runTaskXml({ launcher: moved, account: "ada", atLogin: true, settings });
    await registerRunTask(async () => ({ ok: true, output: "" }), { label: LABEL, file, xml });
    await startRunAgent(context);
    const text = readFileSync(file).subarray(2).toString("utf16le");
    expect(text).toBe(
      runTaskXml({
        launcher: context.launcher,
        account: context.account,
        atLogin: true,
        settings,
        agent: LABEL,
      }),
    );
    expect(readRunTask(file)).toEqual({ atLogin: true, settings });
  });

  it("says it failed where Task Scheduler refused the task, so the window runs its first mate itself", async () => {
    const { context, asked } = windows({ create: false });
    expect(await startRunAgent(context)).toBe("failed");
    expect(asked.map((args) => args[0])).toEqual(["/Create"]);
  });

  it("asks the run to stop itself rather than ending it, and with forget takes the task away", async () => {
    const { context, asked } = windows();
    await startRunAgent(context);
    asked.length = 0;
    await stopRunAgent(context, { forget: false });
    expect(asked).toEqual([]);
    expect(existsSync(join(context.dataDir, RUN_STOP_FILE))).toBe(true);
    expect(runAgentInPlace(context)).toBe(true);
    await stopRunAgent(context, {
      forget: true,
      run: { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" },
    });
    expect(asked).toEqual([["/Delete", "/TN", LABEL, "/F"]]);
    expect(runAgentInPlace(context)).toBe(false);
    // The review of INF-5409: a window that joined asks only its own run, by its process and start,
    // in the file only a run that knows itself reads.
    expect(
      JSON.parse(readFileSync(join(context.dataDir, RUN_STOP_FOR_FILE), "utf8")),
    ).toMatchObject({
      pid: 4242,
      startedAt: "2026-10-25T17:00:00.000Z",
    });
  });

  // The review of INF-4930: a window that joined while no run ran takes the task away and asks no
  // stop at all, so a run started by hand meanwhile reads none.
  it("takes the task away for a join that named no run, asking no stop", async () => {
    const { context, asked } = windows();
    await startRunAgent(context);
    asked.length = 0;
    await stopRunAgent(context, { forget: true, run: null });
    expect(asked).toEqual([["/Delete", "/TN", LABEL, "/F"]]);
    expect(runAgentInPlace(context)).toBe(false);
    expect(existsSync(join(context.dataDir, RUN_STOP_FILE))).toBe(false);
    expect(existsSync(join(context.dataDir, RUN_STOP_FOR_FILE))).toBe(false);
  });

  // The review of INF-5409: a join that lets the agent go says so when Task Scheduler keeps its
  // task registered, and still asks only its own run to stop.
  it("rejects a join's forget when Task Scheduler keeps the task, keeping its file", async () => {
    const { context, asked } = windows({ remove: false });
    await startRunAgent(context);
    asked.length = 0;
    const run = { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" };
    await expect(stopRunAgent(context, { forget: true, run })).rejects.toThrow(
      "so it is still registered: ERROR: Access is denied.",
    );
    expect(asked).toEqual([["/Delete", "/TN", LABEL, "/F"]]);
    expect(runAgentInPlace(context)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(context.dataDir, RUN_STOP_FOR_FILE), "utf8")),
    ).toMatchObject({ pid: 4242 });
  });

  // The captain, on INF-4622's fix: "can we not give an option that's force restart the
  // background process?" The task runs no second copy beside one still going, so Restart it ends
  // the run's own program by force, through the one handle it opened, and runs the task again
  // once that program has ended; Task Scheduler's own end, which ends whichever run it holds, is
  // never asked.
  it("ends the run's program by force and runs the task again once it has ended, on Restart it", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, BORN_NAMED);
    asked.length = 0;
    expect(await restartRunAgent(context, NAMED)).toBe("restarted");
    expect(asked).toEqual([
      ["end", String(NAMED.pid)],
      ["/Run", "/TN", LABEL],
    ]);
  });

  // INF-4624's review: a run that does not answer never reads the ask to stop itself, so Start it
  // here over it ends it by force and waits for it to go, rather than joining it again.
  it("ends a run that does not answer by force and waits for it to go, on Start it here", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, BORN_NAMED);
    asked.length = 0;
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked).toEqual([["end", String(NAMED.pid)]]);
    expect(programs.processes.alive(NAMED.pid)).toBe(false);
    expect(runAgentInPlace(context)).toBe(true);
  });

  // The review of INF-5409: Restart it and Start it here end only the run their notice names, by
  // the program its number opens now: one born after the named run wrote its start took that
  // number since, one whose birth cannot be read proves nothing, and a run started by hand or
  // another run there is no run of the notice's. None is ended, and the task is asked nothing.
  it("ends nothing on Restart it or Start it here for a program that is not the named run", async () => {
    for (const [record, agent, born] of [
      [NAMED, true, BORN_LATER],
      [NAMED, true, undefined],
      [NAMED, false, BORN_NAMED],
      [REUSED, true, BORN_LATER],
    ] as const) {
      const { context, asked, programs } = windows();
      await startRunAgent(context);
      recordRun(context, record, agent);
      programs.run(NAMED.pid, born);
      asked.length = 0;
      expect(await restartRunAgent(context, NAMED)).toBe("untouched");
      await stopRunAgent(context, { forget: false, force: NAMED });
      expect(asked).toEqual([]);
      expect(programs.processes.alive(NAMED.pid)).toBe(true);
    }
  });

  // The review of INF-5409: the named run ended, and another program took its number as it went.
  // The handle the named run was opened with says it ended, so the task runs again, and the
  // program under its number now is never ended.
  it("ends no program that took the named run's process number as it ended", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, BORN_NAMED);
    programs.onEnd = (pid) => programs.run(pid, BORN_LATER);
    asked.length = 0;
    expect(await restartRunAgent(context, NAMED)).toBe("restarted");
    expect(asked).toEqual([
      ["end", String(NAMED.pid)],
      ["/Run", "/TN", LABEL],
    ]);
    expect(programs.processes.alive(NAMED.pid)).toBe(true);
  });
});
