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
  RUN_STOP_FILE,
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

function mac(answers: { bootstrap?: boolean; session?: boolean } = {}) {
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
      return { ok: true, output: "" };
    },
  };
  return { context, asked };
}

function linux(answers: { session?: boolean } = {}) {
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
});

function windows(answers: { create?: boolean; running?: number } = {}) {
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
    schtasks: async (args) => {
      asked.push([...args]);
      if (args[0] === "/Create" && answers.create === false)
        return { ok: false, output: "ERROR: Access is denied." };
      return { ok: true, output: "SUCCESS" };
    },
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
      runTaskXml({ launcher: context.launcher, account: context.account, atLogin: true, settings }),
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
    await stopRunAgent(context, { forget: true });
    expect(asked).toEqual([["/Delete", "/TN", LABEL, "/F"]]);
    expect(runAgentInPlace(context)).toBe(false);
  });

  // The captain, on INF-4622's fix: "can we not give an option that's force restart the
  // background process?" Task Scheduler's own end returns before the program has closed, and the
  // task runs no second copy beside one still going, so Restart it ends the run's process by force
  // and runs the task again only once that process is gone.
  it("ends the run by force and runs the task again once its process is gone, on Restart it", async () => {
    const { context, asked } = windows({ running: 4242 });
    await startRunAgent(context);
    asked.length = 0;
    expect(await restartRunAgent(context, { pid: 4242 })).toBe(true);
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
    asked.length = 0;
    await stopRunAgent(context, { forget: false, force: { pid: 4242 } });
    expect(asked).toEqual([
      ["/End", "/TN", LABEL],
      ["end", "4242"],
      ["gone", "4242"],
    ]);
    expect(runAgentInPlace(context)).toBe(true);
  });
});
