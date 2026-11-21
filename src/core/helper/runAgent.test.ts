import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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
import { RUN_FORCE_DIR } from "./runForce";
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

/**
 * The run's own record in the data folder, as `<app> run` writes it, its agent's mark and Windows
 * birth included; an agent's run says a force stop can end it (`recovers`) unless `recovers` is
 * false, as before its reading and helper are up.
 */
function recordRun(
  context: RunAgentContext,
  run: Run,
  agent: boolean,
  birth?: string,
  recovers = agent,
): void {
  writeFileSync(
    join(context.dataDir, RUN_RECORD_FILE),
    `${JSON.stringify({
      ...run,
      ...(agent ? { agent } : {}),
      ...(recovers ? { recovers } : {}),
      ...(birth ? { birth } : {}),
    })}\n`,
  );
}

/** The run a notice names, and others that may hold the folder by the time a button acts. */
const NAMED: Run = { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" };
/** The same process number taken by another run since: another start. */
const REUSED: Run = { pid: 4242, startedAt: "2026-10-25T17:05:00.000Z" };
/** A run started again in the named one's place, by the job or by hand. */
const REPLACEMENT: Run = { pid: 5151, startedAt: "2026-10-25T17:05:00.000Z" };

/**
 * This computer's programs under each process number, and each run's own
 * reading of force stops (`watchRunForce`, whose thread runs in a process
 * of its own in ./runForce.test.ts): a run knows itself by its start and
 * ends itself where a stop in its folder names it; any other program, one
 * that took a run's number included, knows no start and reads none. Each
 * end is written down beside the service manager's asks.
 */
function programTable(asked: string[][], dataDir: () => string) {
  const table = new Map<number, { startedAt: string | null; birth?: string }>();
  const programs = {
    /**
     * A program runs under `pid`: a run that knows itself by `startedAt`, or another program (null),
     * born at `birth` where Windows keeps one.
     */
    run: (pid: number, startedAt: string | null, birth?: string) =>
      table.set(pid, { startedAt, ...(birth ? { birth } : {}) }),
    /** The program under `pid` ends on its own. */
    gone: (pid: number) => table.delete(pid),
    /** What happens as a run ends, before anything reads again. */
    onEnd: undefined as ((pid: number) => void) | undefined,
    /** Whether the runs read no force stop, as one stuck past its own thread or from before it. */
    deaf: false,
    /** Whether the runs' whole processes are stopped, reading nothing until a force stop wakes them. */
    frozen: false,
    /** Each run a force stop let go on, by its number and recorded birth: no real process is woken. */
    woken: [] as [number, string | undefined][],
    processes: {
      // With a birth, only while the program born then holds the number, as Windows says.
      alive: (pid: number, birth?: string) => {
        deliver();
        const program = table.get(pid);
        return Boolean(
          program && (!birth || program.birth === undefined || program.birth === birth),
        );
      },
      forceWaitMs: 300,
      wake: (run: Run, birth?: string) => {
        programs.woken.push([run.pid, birth]);
        programs.frozen = false;
      },
    },
  };
  // A run reads each force stop in the folder and claims one that names it, as its own thread does.
  const deliver = () => {
    if (programs.frozen) return;
    const dir = join(dataDir(), RUN_FORCE_DIR);
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      let request: { pid?: number; startedAt?: string };
      try {
        request = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const pid = request.pid ?? -1;
      if (programs.deaf || table.get(pid)?.startedAt !== request.startedAt) continue;
      // Claimed, then committed within its time, as the run ends by its own hand.
      const taken = file.replace(/\.json$/, ".taken");
      renameSync(file, taken);
      renameSync(taken, taken.replace(/\.taken$/, ".ended"));
      table.delete(pid);
      asked.push(["end", String(pid)]);
      programs.onEnd?.(pid);
    }
  };
  return programs;
}

function mac(
  answers: { bootstrap?: boolean; session?: boolean; stop?: StopAnswer; job?: number } = {},
) {
  const asked: string[][] = [];
  const dataDir = scratchDir("infinitary-run-agent-data-");
  const programs = programTable(asked, () => dataDir);
  const context: RunAgentContext = {
    processes: programs.processes,
    label: LABEL,
    dataDir,
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
  const dataDir = scratchDir("infinitary-run-agent-data-");
  const programs = programTable(asked, () => dataDir);
  const context: RunAgentContext = {
    processes: programs.processes,
    label: LABEL,
    dataDir,
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
    // Letting the job go after Start it here's force stop keeps the agent but names no run: a job
    // launchd keeps may start its run beside the recovered window, so it says so too.
    await expect(stopRunAgent(refused.context, { forget: false, run: null })).rejects.toThrow(
      "Boot-out failed",
    );
    await expect(stopRunAgent(gone.context, { forget: false, run: null })).resolves.toBeUndefined();
    // Any other stop, as before an update replaces the copy, answers as it always has.
    await expect(stopRunAgent(refused.context, { forget: false })).resolves.toBeUndefined();
  });

  // The review of INF-5409: launchd's `kickstart -k`, bootout and kill end whichever run the job
  // holds by then, and a signal goes to whichever program holds a process number by then. So the
  // named run ends itself, read by its own process and start, and launchd is asked only to start
  // the job on Restart it, which starts nothing where it already runs, and nothing on Start it here.
  it("has the named run its agent started end itself, then asks launchd only to start the job", async () => {
    // Each run is wholly stopped until the button lets it go on.
    const restart = mac();
    recordRun(restart.context, NAMED, true);
    restart.programs.run(NAMED.pid, NAMED.startedAt);
    restart.programs.frozen = true;
    restart.programs.processes.forceWaitMs = 2_000;
    expect(await restartRunAgent(restart.context, NAMED)).toBe("restarted");
    expect(restart.asked).toEqual([
      ["end", String(NAMED.pid)],
      ["kickstart", `gui/502/${LABEL}`],
    ]);

    const startHere = mac();
    recordRun(startHere.context, NAMED, true);
    startHere.programs.run(NAMED.pid, NAMED.startedAt);
    startHere.programs.frozen = true;
    startHere.programs.processes.forceWaitMs = 2_000;
    await stopRunAgent(startHere.context, { forget: false, force: NAMED });
    expect(startHere.asked).toEqual([["end", String(NAMED.pid)]]);
    expect(startHere.programs.processes.alive(NAMED.pid)).toBe(false);
    // Each button lets the named run go on through the process operation it was given, never
    // through the host's own.
    expect(restart.programs.woken).toEqual([[NAMED.pid, undefined]]);
    expect(startHere.programs.woken).toEqual([[NAMED.pid, undefined]]);
  });

  // The review of INF-5409: a run that ends on its own after its stop was written, before it claimed
  // it, was not ended by that stop: Start it here hears that it is gone, which never lets the
  // window that starts here retire the job.
  it("answers gone, never ended, for a run that ended before claiming its stop", async () => {
    const { context, asked, programs } = mac();
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, NAMED.startedAt);
    programs.deaf = true;
    setTimeout(() => programs.gone(NAMED.pid), 100);
    expect(await stopRunAgent(context, { forget: false, force: NAMED })).toBe("gone");
    expect(asked).toEqual([]);
    expect(forceStopsLeft(context.dataDir)).toEqual([]);
  });

  // The review of INF-5409: a run the job started again after the named one ended keeps going on
  // either button; Start it here asks the job nothing, so it never ends that replacement.
  it("keeps a run the job started again as the named one ended", async () => {
    for (const press of ["restart", "start-here"] as const) {
      const { context, asked, programs } = mac();
      recordRun(context, NAMED, true);
      programs.run(NAMED.pid, NAMED.startedAt);
      // launchd starts the job's run again the moment the named one ends.
      programs.onEnd = () => programs.run(REPLACEMENT.pid, REPLACEMENT.startedAt);
      if (press === "restart") expect(await restartRunAgent(context, NAMED)).toBe("restarted");
      else await stopRunAgent(context, { forget: false, force: NAMED });
      expect(asked.filter(([verb]) => verb === "bootout" || verb === "kill")).toEqual([]);
      expect(programs.processes.alive(REPLACEMENT.pid)).toBe(true);
    }
  });

  // The review of INF-5409: no program but the named run ends. A program that took its number
  // knows another start and reads no stop for it; a run that does not act on the stop in time
  // is reported as lasting, never as ended, and the job is not started beside it. A run started
  // by hand, or another run there, is no run of the notice's, and nothing is asked at all.
  it("ends nothing but the named run its agent started, and starts nothing beside one that lasts", async () => {
    for (const [record, agent, holder, deaf, outcome] of [
      [NAMED, true, null, false, "failed"],
      [NAMED, true, REUSED.startedAt, false, "failed"],
      [NAMED, true, NAMED.startedAt, true, "failed"],
      [NAMED, false, NAMED.startedAt, false, "untouched"],
      [REUSED, true, REUSED.startedAt, false, "untouched"],
    ] as const) {
      const other = mac();
      recordRun(other.context, record, agent);
      other.programs.run(NAMED.pid, holder);
      other.programs.deaf = deaf;
      expect(await restartRunAgent(other.context, NAMED)).toBe(outcome);
      await stopRunAgent(other.context, { forget: false, force: NAMED });
      expect(other.asked).toEqual([]);
      expect(other.programs.processes.alive(NAMED.pid)).toBe(true);
      // A stop the run did not act on is taken away, so it never ends later.
      expect(forceStopsLeft(other.context.dataDir)).toEqual([]);
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
    await expect(stopRunAgent(refused.context, { forget: false, run: null })).rejects.toThrow(
      "Access denied",
    );
    await expect(stopRunAgent(refused.context, { forget: false })).resolves.toBeUndefined();
  });

  // As on a Mac: the named run ends itself, and systemd is asked only to start the unit on
  // Restart it, and nothing on Start it here.
  it("has the named run its agent started end itself, then asks systemd only to start the unit", async () => {
    const restart = linux();
    recordRun(restart.context, NAMED, true);
    restart.programs.run(NAMED.pid, NAMED.startedAt);
    expect(await restartRunAgent(restart.context, NAMED)).toBe("restarted");
    expect(restart.asked).toEqual([
      ["end", String(NAMED.pid)],
      ["--user", "start", LABEL],
    ]);

    const startHere = linux();
    recordRun(startHere.context, NAMED, true);
    startHere.programs.run(NAMED.pid, NAMED.startedAt);
    await stopRunAgent(startHere.context, { forget: false, force: NAMED });
    expect(startHere.asked).toEqual([["end", String(NAMED.pid)]]);
  });

  it("keeps a run the unit started again as the named one ended, and ends nothing for another program", async () => {
    const { context, asked, programs } = linux();
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, NAMED.startedAt);
    programs.onEnd = () => programs.run(REPLACEMENT.pid, REPLACEMENT.startedAt);
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked.filter((args) => args[1] === "stop" || args[1] === "kill")).toEqual([]);
    expect(programs.processes.alive(REPLACEMENT.pid)).toBe(true);
    for (const holder of [REUSED.startedAt, null]) {
      const other = linux();
      recordRun(other.context, NAMED, true);
      other.programs.run(NAMED.pid, holder);
      expect(await restartRunAgent(other.context, NAMED)).toBe("failed");
      await stopRunAgent(other.context, { forget: false, force: NAMED });
      expect(other.asked).toEqual([]);
      expect(other.programs.processes.alive(NAMED.pid)).toBe(true);
    }
  });
});

function windows(answers: { create?: boolean; remove?: boolean } = {}) {
  const asked: string[][] = [];
  const dataDir = scratchDir("infinitary-run-agent-data-");
  const programs = programTable(asked, () => dataDir);
  const context: RunAgentContext = {
    label: LABEL,
    dataDir,
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
  // background process?" The task runs no second copy beside one still going, so Restart it has
  // the run end itself by force and runs the task again once no program runs under its number;
  // Task Scheduler's own end, which ends whichever run it holds, is never asked.
  it("has the run end itself by force and runs the task again once it has ended, on Restart it", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, NAMED.startedAt);
    asked.length = 0;
    expect(await restartRunAgent(context, NAMED)).toBe("restarted");
    expect(asked).toEqual([
      ["end", String(NAMED.pid)],
      ["/Run", "/TN", LABEL],
    ]);
  });

  // INF-4624's review: a run that does not answer never reads the ask to stop itself, so Start it
  // here over it has it end itself by force and waits for it to go, rather than joining it again.
  it("has a run that does not answer end itself by force and waits for it to go, on Start it here", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true);
    programs.run(NAMED.pid, NAMED.startedAt);
    asked.length = 0;
    await stopRunAgent(context, { forget: false, force: NAMED });
    expect(asked).toEqual([["end", String(NAMED.pid)]]);
    expect(programs.processes.alive(NAMED.pid)).toBe(false);
    expect(runAgentInPlace(context)).toBe(true);
  });

  // The review of INF-5409: Restart it and Start it here end only the run their notice names. A
  // program under its number that knows another start reads no stop, and a run that does not
  // act on it in time lasts: neither is ended, nor is the task run beside it. A run started by
  // hand or another run there is no run of the notice's, and the task is asked nothing.
  it("ends nothing on Restart it or Start it here but the named run", async () => {
    for (const [record, agent, holder, deaf, outcome] of [
      [NAMED, true, REUSED.startedAt, false, "failed"],
      [NAMED, true, NAMED.startedAt, true, "failed"],
      [NAMED, false, NAMED.startedAt, false, "untouched"],
      [REUSED, true, REUSED.startedAt, false, "untouched"],
    ] as const) {
      const { context, asked, programs } = windows();
      await startRunAgent(context);
      recordRun(context, record, agent);
      programs.run(NAMED.pid, holder);
      programs.deaf = deaf;
      asked.length = 0;
      expect(await restartRunAgent(context, NAMED)).toBe(outcome);
      await stopRunAgent(context, { forget: false, force: NAMED });
      expect(asked).toEqual([]);
      expect(programs.processes.alive(NAMED.pid)).toBe(true);
    }
  });

  // The review of INF-5409: the named run committed its stop, and another program took its number
  // as it went. The run is read by the birth its record keeps, so the program there now, born
  // later, is not it: the named run's own end starts the task once, which Task Scheduler never does
  // by itself, while that other program keeps running and is never ended.
  it("starts the task once the named run ended though another program took its number", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true, "133800000000000000");
    programs.run(NAMED.pid, NAMED.startedAt, "133800000000000000");
    programs.onEnd = (pid) => programs.run(pid, null, "133800000000500000");
    asked.length = 0;
    expect(await restartRunAgent(context, NAMED)).toBe("restarted");
    expect(asked).toEqual([
      ["end", String(NAMED.pid)],
      ["/Run", "/TN", LABEL],
    ]);
    expect(programs.processes.alive(NAMED.pid)).toBe(true);
    expect(forceStopsLeft(context.dataDir)).toEqual([]);
  });

  // The review of INF-5409: another program already holds the named run's number at the press, as
  // its birth shows. That is no run of this stop, never an exit the stop saw: nothing is asked of
  // it, woken or started, and both buttons stand as before.
  it("asks and starts nothing where another program already holds the named run's number", async () => {
    const { context, asked, programs } = windows();
    await startRunAgent(context);
    recordRun(context, NAMED, true, "133800000000000000");
    programs.run(NAMED.pid, NAMED.startedAt, "133800000000500000");
    asked.length = 0;
    expect(await restartRunAgent(context, NAMED)).toBe("untouched");
    expect(await stopRunAgent(context, { forget: false, force: NAMED })).toBe("untouched");
    expect(asked).toEqual([]);
    expect(programs.woken).toEqual([]);
    expect(programs.processes.alive(NAMED.pid)).toBe(true);
    expect(forceStopsLeft(context.dataDir)).toEqual([]);
  });

  // The review of INF-5409: a notice drawn while the run could be ended by force can still be
  // pressed after its reading or helper stopped and its note took that back. The starter reads
  // the note as it asks, so such a run is asked nothing and nothing is started.
  it("asks nothing of the named run once its note no longer says a force stop can end it", async () => {
    const { context, asked, programs } = mac();
    recordRun(context, NAMED, true, undefined, false);
    programs.run(NAMED.pid, NAMED.startedAt);
    expect(await restartRunAgent(context, NAMED)).toBe("untouched");
    expect(await stopRunAgent(context, { forget: false, force: NAMED })).toBe("untouched");
    expect(asked).toEqual([]);
    expect(programs.woken).toEqual([]);
    expect(programs.processes.alive(NAMED.pid)).toBe(true);
    expect(forceStopsLeft(context.dataDir)).toEqual([]);
  });
});

/** The force stops left in a data folder, pending or claimed. */
function forceStopsLeft(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, RUN_FORCE_DIR));
  } catch {
    return [];
  }
}
