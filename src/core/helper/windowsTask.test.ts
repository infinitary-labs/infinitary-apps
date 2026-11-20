import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { Launchctl } from "./background";
import {
  RUN_STOP_FILE,
  RUN_STOP_FOR_FILE,
  readRunTask,
  registerRunTask,
  removeRunTask,
  requestRunStop,
  runTaskFile,
  runTaskXml,
  watchRunStop,
  windowsAccount,
  windowsWord,
} from "./windowsTask";

/**
 * The command's start entry on Windows (docs/run.md, "On Windows"; INF-4243's
 * plan, piece 5: "<app> run is registered at your login through Windows'
 * Task Scheduler, and the window starts it as on Mac and Linux"). schtasks
 * is a stand-in that writes down what it was asked: no test registers a task.
 */

const LAUNCHER = {
  executable: "C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Infinitary\\Infinitary.exe",
  args: [],
};
const LABEL = "com.getinfinitary.infinitary.run";

function schtasks(ok = true) {
  const asked: string[][] = [];
  const program: Launchctl = async (args) => {
    asked.push([...args]);
    return { ok, output: ok ? "SUCCESS" : "ERROR: Access is denied." };
  };
  return { asked, program };
}

describe("the task's command line", () => {
  it("quotes each word the way Windows reads a program's command line back", () => {
    expect(windowsWord("run")).toBe("run");
    expect(windowsWord("C:\\Program Files\\a.json")).toBe('"C:\\Program Files\\a.json"');
    expect(windowsWord('say "hi"')).toBe('"say \\"hi\\""');
    // Backslashes before the closing quote are doubled so the quote still closes.
    expect(windowsWord("C:\\My Folder\\")).toBe('"C:\\My Folder\\\\"');
    expect(windowsWord("")).toBe('""');
  });

  it("names the account as Task Scheduler does, by its domain", () => {
    expect(windowsAccount({ USERDOMAIN: "DESKTOP-7Q2" }, "ada")).toBe("DESKTOP-7Q2\\ada");
    expect(windowsAccount({}, "ada")).toBe("ada");
  });
});

describe("the task", () => {
  it("runs the command as this account in its signed-in session, at an app's priority", () => {
    const xml = runTaskXml({ launcher: LAUNCHER, account: "DESKTOP-7Q2\\ada", atLogin: true });
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<UserId>DESKTOP-7Q2\\ada</UserId>");
    expect(xml).toContain("<Priority>4</Priority>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain(`<Command>${LAUNCHER.executable}</Command>`);
    expect(xml).toContain("<Arguments>run</Arguments>");
    // This app's own task names its agent, as a variable does elsewhere.
    expect(
      runTaskXml({ launcher: LAUNCHER, account: "ada", atLogin: true, agent: LABEL }),
    ).toContain(`<Arguments>run --agent ${LABEL}</Arguments>`);
  });

  it("keeps a settings file with a space, a quote and an ampersand, read back as written", () => {
    const settings = 'C:\\Users\\Ada Lovelace\\run "a" & b.json';
    const file = join(scratchDir("windows-task-"), "run-task.xml");
    const xml = runTaskXml({ launcher: LAUNCHER, account: "ada", atLogin: false, settings });
    expect(xml).toContain("&amp;");
    return registerRunTask(schtasks().program, { label: LABEL, file, xml }).then(() => {
      expect(readRunTask(file)).toEqual({ atLogin: false, settings });
    });
  });

  it("is written as UTF-16 with its mark, which schtasks reads, and registered from that file", async () => {
    const { asked, program } = schtasks();
    const dataDir = scratchDir("windows-task-");
    const file = runTaskFile(dataDir);
    const xml = runTaskXml({ launcher: LAUNCHER, account: "ada", atLogin: true });
    expect(await registerRunTask(program, { label: LABEL, file, xml })).toBe(true);
    const bytes = readFileSync(file);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(xml);
    expect(asked).toEqual([["/Create", "/TN", LABEL, "/XML", file, "/F"]]);
    expect(readRunTask(file)).toEqual({ atLogin: true });
  });

  it("answers false where Task Scheduler refused it", async () => {
    const file = runTaskFile(scratchDir("windows-task-"));
    const xml = runTaskXml({ launcher: LAUNCHER, account: "ada", atLogin: true });
    expect(await registerRunTask(schtasks(false).program, { label: LABEL, file, xml })).toBe(false);
  });

  it("goes with its file, and says whether one was there", async () => {
    const { asked, program } = schtasks();
    const file = runTaskFile(scratchDir("windows-task-"));
    const xml = runTaskXml({ launcher: LAUNCHER, account: "ada", atLogin: true });
    await registerRunTask(program, { label: LABEL, file, xml });
    expect(await removeRunTask(program, { label: LABEL, file })).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(asked.at(-1)).toEqual(["/Delete", "/TN", LABEL, "/F"]);
    expect(await removeRunTask(program, { label: LABEL, file })).toBe(false);
  });

  // The review of INF-5409: a task Task Scheduler would not take away, or may still hold, is said,
  // and its file kept; only Task Scheduler's own record of that task, certainly not there, lets
  // the file go, since a list of tasks leaves out one this account cannot read.
  it("keeps its file and rejects unless Task Scheduler's record of the task is certainly gone", async () => {
    const file = runTaskFile(scratchDir("windows-task-"));
    const xml = runTaskXml({ launcher: LAUNCHER, account: "ada", atLogin: true });
    // Windows' own folder, as `%SystemRoot%` names it, with Task Scheduler's record of the task.
    const systemRoot = scratchDir("windows-root-");
    const tasks = join(systemRoot, "System32", "Tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, LABEL), "<Task/>");
    vi.stubEnv("SystemRoot", systemRoot);
    try {
      const refused: Launchctl = async (args) =>
        args[0] === "/Delete"
          ? { ok: false, output: "ERROR: Access is denied." }
          : { ok: true, output: "SUCCESS" };
      await registerRunTask(refused, { label: LABEL, file, xml });
      await expect(removeRunTask(refused, { label: LABEL, file })).rejects.toThrow(
        "so it is still registered: ERROR: Access is denied.",
      );
      expect(existsSync(file)).toBe(true);
      // A record this account may not read is not a record that is gone.
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        chmodSync(tasks, 0o000);
        try {
          await expect(removeRunTask(refused, { label: LABEL, file })).rejects.toThrow(
            "could not say whether it is still registered",
          );
        } finally {
          chmodSync(tasks, 0o700);
        }
        expect(existsSync(file)).toBe(true);
      }
      rmSync(join(tasks, LABEL));
      expect(await removeRunTask(refused, { label: LABEL, file })).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a stop asked of the run on Windows", () => {
  it("stops a run that started before the request, and only once", async () => {
    const dataDir = scratchDir("windows-stop-");
    let stops = 0;
    const end = watchRunStop(dataDir, new Date(Date.now() - 1_000), () => (stops += 1), 10);
    try {
      expect(requestRunStop(dataDir)).toBe(true);
      await expect.poll(() => stops).toBe(1);
      expect(existsSync(join(dataDir, RUN_STOP_FILE))).toBe(false);
      requestRunStop(dataDir);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stops).toBe(1);
    } finally {
      end();
    }
  });

  // The review of INF-5409: a window that joined or followed along asks its own run to stop by its
  // process and start, and a run started by hand in its place, a reused process number included,
  // reads that request as another's.
  it("leaves a run alone for a request naming another run, and takes that request away", async () => {
    const dataDir = scratchDir("windows-stop-");
    const own = { pid: 5151, startedAt: "2026-10-25T17:05:00.000Z" };
    let stops = 0;
    const end = watchRunStop(dataDir, new Date(Date.now() - 1_000), () => (stops += 1), 10, own);
    try {
      for (const other of [
        { pid: 4242, startedAt: own.startedAt },
        { pid: own.pid, startedAt: "2026-10-25T17:00:00.000Z" },
      ]) {
        expect(requestRunStop(dataDir, new Date(), other)).toBe(true);
        // It goes in a file of its own, which a run from an earlier version never reads.
        expect(existsSync(join(dataDir, RUN_STOP_FILE))).toBe(false);
        await expect.poll(() => existsSync(join(dataDir, RUN_STOP_FOR_FILE))).toBe(false);
        expect(stops).toBe(0);
      }
      requestRunStop(dataDir, new Date(), own);
      await expect.poll(() => stops).toBe(1);
    } finally {
      end();
    }
  });

  // The review of INF-5409: a request naming a run is never for a reader that knows no run of its
  // own, such as a work run.
  it("leaves a run that knows no identity alone for a request naming a run", async () => {
    const dataDir = scratchDir("windows-stop-");
    let stops = 0;
    const end = watchRunStop(dataDir, new Date(Date.now() - 1_000), () => (stops += 1), 10);
    try {
      requestRunStop(dataDir, new Date(), { pid: 5151, startedAt: "2026-10-25T17:05:00.000Z" });
      await expect.poll(() => existsSync(join(dataDir, RUN_STOP_FOR_FILE))).toBe(false);
      expect(stops).toBe(0);
    } finally {
      end();
    }
  });

  // The review of INF-5409: Stop and older callers name no run, and whichever runs here stops.
  it("stops for a request naming no run", async () => {
    const dataDir = scratchDir("windows-stop-");
    let stops = 0;
    const own = { pid: 5151, startedAt: "2026-10-25T17:05:00.000Z" };
    const end = watchRunStop(dataDir, new Date(Date.now() - 1_000), () => (stops += 1), 10, own);
    try {
      requestRunStop(dataDir);
      await expect.poll(() => stops).toBe(1);
    } finally {
      end();
    }
  });

  // The review of INF-5409: a stop file that holds no request, such as JSON null, is no stop, and
  // reading it as a run starts throws nothing.
  it("reads a stop file that holds no request as no stop", async () => {
    const dataDir = scratchDir("windows-stop-");
    const own = { pid: 5151, startedAt: "2026-10-25T17:05:00.000Z" };
    for (const name of [RUN_STOP_FILE, RUN_STOP_FOR_FILE])
      for (const content of ["null", "42", '"stop"']) {
        writeFileSync(join(dataDir, name), content);
        let stops = 0;
        const end = watchRunStop(
          dataDir,
          new Date(Date.now() - 1_000),
          () => (stops += 1),
          10,
          own,
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(stops).toBe(0);
          expect(existsSync(join(dataDir, name))).toBe(false);
        } finally {
          end();
        }
      }
  });

  // The review of INF-5409: a stop file that cannot be taken away cancels no other request, and
  // reading it throws nothing as the run starts.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "stops for Stop's request though neither request can be taken away",
    () => {
      const dataDir = scratchDir("windows-stop-");
      requestRunStop(dataDir);
      requestRunStop(dataDir, new Date(), { pid: 4242, startedAt: "2026-10-25T17:05:00.000Z" });
      // A folder whose files cannot be removed, as a file another program holds open on Windows.
      chmodSync(dataDir, 0o500);
      let stops = 0;
      try {
        watchRunStop(dataDir, new Date(Date.now() - 1_000), () => (stops += 1), 10, {
          pid: 5151,
          startedAt: "2026-10-25T17:05:00.000Z",
        })();
        expect(stops).toBe(1);
      } finally {
        chmodSync(dataDir, 0o700);
      }
    },
  );

  it("leaves a run alone for a request older than its own start, and takes that request away", async () => {
    const dataDir = scratchDir("windows-stop-");
    requestRunStop(dataDir, new Date(Date.now() - 60_000));
    let stops = 0;
    const end = watchRunStop(dataDir, new Date(), () => (stops += 1), 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stops).toBe(0);
      expect(existsSync(join(dataDir, RUN_STOP_FILE))).toBe(false);
    } finally {
      end();
    }
  });
});
