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

function mac(answers: { bootstrap?: boolean; session?: boolean; stop?: StopAnswer } = {}) {
  const asked: string[][] = [];
  const context: RunAgentContext = {
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
      return { ok: true, output: "" };
    },
  };
  return { context, asked };
}

function linux(answers: { session?: boolean; stop?: StopAnswer } = {}) {
  const asked: string[][] = [];
  const unitsDir = join(scratchDir("infinitary-run-agent-config-"), "systemd", "user");
  const context: RunAgentContext = {
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
  return { context, asked, unit: join(unitsDir, `${LABEL}.service`) };
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

  // The review of INF-5409: launchd's kickstart and bootout end whichever run the job holds, so
  // Restart it and Start it here act only while the record names the run their notice names, and
  // that run is the agent's own: a run the job started again in its place, one with its process
  // number, and one started by hand are left alone, and the job with them.
  it("restarts or stops the job only for the named run its agent started", async () => {
    const named = { pid: process.pid, startedAt: NAMED.startedAt };
    const owned = mac();
    recordRun(owned.context, named, true);
    expect(await restartRunAgent(owned.context, named)).toBe(true);
    await stopRunAgent(owned.context, { forget: false, force: named });
    expect(owned.asked).toEqual([
      ["kickstart", "-k", `gui/502/${LABEL}`],
      ["bootout", `gui/502/${LABEL}`],
    ]);
    for (const [there, agent] of [
      [{ pid: process.pid, startedAt: REUSED.startedAt }, true],
      [named, false],
    ] as const) {
      const other = mac();
      recordRun(other.context, there, agent);
      expect(await restartRunAgent(other.context, named)).toBe(false);
      await stopRunAgent(other.context, { forget: false, force: named });
      expect(other.asked).toEqual([]);
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

  // As on a Mac: systemd's kill and stop end whichever run the unit holds, so only the named run
  // its agent started is ended, and a run started again in its place keeps going.
  it("restarts or stops the unit only for the named run its agent started", async () => {
    const named = { pid: process.pid, startedAt: NAMED.startedAt };
    const owned = linux();
    recordRun(owned.context, named, true);
    expect(await restartRunAgent(owned.context, named)).toBe(true);
    expect(owned.asked.map((args) => args[1])).toEqual(["kill", "start"]);
    const replaced = linux();
    recordRun(replaced.context, { pid: process.pid, startedAt: REUSED.startedAt }, true);
    expect(await restartRunAgent(replaced.context, named)).toBe(false);
    await stopRunAgent(replaced.context, { forget: false, force: named });
    expect(replaced.asked).toEqual([]);
  });
});

function windows(answers: { create?: boolean; running?: number; remove?: boolean } = {}) {
  const asked: string[][] = [];
  // The run's process, as its record names it: ended by force, it is gone a moment later.
  const live = new Set<number>();
  const context: RunAgentContext = {
    label: LABEL,
    dataDir: scratchDir("infinitary-run-agent-data-"),
    homeDir: scratchDir("infinitary-run-agent-home-"),
    uid: -1,
    unitsDir: "/nowhere",
    launcher: { executable: "C:\\Program Files\\Infinitary\\Infinitary.exe", args: [] },
    env: {},
    account: "DESKTOP-7Q2\\ada",
    processes: {
      alive: (pid) => live.has(pid),
      end: (pid) => {
        asked.push(["end", String(pid)]);
        setTimeout(() => {
          live.delete(pid);
          asked.push(["gone", String(pid)]);
        }, 250);
      },
    },
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
  if (answers.running !== undefined) live.add(answers.running);
  return { context, asked };
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
  // background process?" Task Scheduler's own end returns before the program has closed, and the
  // task runs no second copy beside one still going, so Restart it ends the run's process by force
  // and runs the task again only once that process is gone.
  it("ends the run by force and runs the task again once its process is gone, on Restart it", async () => {
    const { context, asked } = windows({ running: 4242 });
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    asked.length = 0;
    expect(await restartRunAgent(context, NAMED)).toBe(true);
    expect(asked).toEqual([
      ["/End", "/TN", LABEL],
      ["end", "4242"],
      ["gone", "4242"],
      ["/Run", "/TN", LABEL],
    ]);
  });

  // INF-4624's review: a run that does not answer never reads the ask to stop itself, so Start it
  // here over it ends it by force and waits for it to go, rather than joining it again.
  it("ends a run that does not answer by force and waits for it to go, on Start it here", async () => {
    const { context, asked } = windows({ running: 4242 });
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    asked.length = 0;
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked).toEqual([
      ["/End", "/TN", LABEL],
      ["end", "4242"],
      ["gone", "4242"],
    ]);
    expect(runAgentInPlace(context)).toBe(true);
  });

  // The review of INF-5409: Restart it and Start it here act on the run their notice names, by its
  // process and start as its record reads when they act. Another run there - its process number
  // reused, or a run started again in its place - is neither ended nor its task's end asked.
  it("ends nothing on Restart it or Start it here for another run there, its process number reused included", async () => {
    for (const there of [REUSED, REPLACEMENT]) {
      const { context, asked } = windows({ running: there.pid });
      await startRunAgent(context);
      recordRun(context, there, true);
      asked.length = 0;
      expect(await restartRunAgent(context, NAMED)).toBe(false);
      await stopRunAgent(context, { forget: false, force: NAMED });
      expect(asked).toEqual([]);
      expect(context.processes?.alive(there.pid)).toBe(true);
    }
  });

  // A run started by hand is no run of the task's: Task Scheduler's end, which ends whatever the
  // task runs, is not asked, and the named run's own process alone is ended.
  it("ends a run started by hand by its process alone, never the task's run", async () => {
    const { context, asked } = windows({ running: 4242 });
    await startRunAgent(context);
    recordRun(context, NAMED, false);
    asked.length = 0;
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked).toEqual([
      ["end", "4242"],
      ["gone", "4242"],
    ]);
  });
});
