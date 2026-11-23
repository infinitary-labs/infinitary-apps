import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratchDirs";

/**
 * A stand-in for this account's service manager (launchd's `launchctl` on a
 * Mac, systemd's `systemctl --user` on Linux) that really runs the job it
 * is given, as the window that starts the command asks it to (docs/run.md,
 * "The window starts it"), so no journey loads a real agent or starts a
 * real service. A job runs under a small supervisor that starts it again
 * after a failed exit and never after a clean one, as the agent and the
 * unit the window writes ask (`bootPlist`, `bootUnit`). It writes down
 * each run it started, by its process number, and each start or stop it
 * was asked for, and ends its supervisors when the journey ends. A run is
 * signalled only by the supervisor that started it, named by its run number
 * (its place in that record) and only while that run has not ended, so no
 * signal reaches a process that took an ended run's number; a stop goes
 * through the supervisor too, and is said done only once it exited.
 */

/** The supervisor and its job, in the stand-in's own program; `__STATE__` is its folder. */
const PROGRAM = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync, openSync } = require("node:fs");
const { join } = require("node:path");
const STATE = __STATE__;
const args = process.argv.slice(2);
const pidFile = (label) => join(STATE, label + ".pid");
// Every start or stop it is asked for, as the journey reads it; a reading is not written down.
if (args[0] !== "__supervise" && args[0] !== "print" && !(args[0] === "--user" && args[1] === "show"))
  appendFileSync(join(STATE, "asks"), args.join(" ") + "\n");
// Asks the job's supervisor to signal its run: the one it started as its run number gen (its
// line in the runs record, from 1), or the one now for null. It signals that run only while it has
// not ended, and answers "sent", "gone" when it ended or another run is the job's now, or
// "timeout" when no answer came: the ask is then taken back unless the supervisor already took it,
// whose answer is then read.
function signalRun(label, signal, gen) {
  if (!running(label)) return "gone";
  const ask = join(STATE, label + ".signal-" + process.pid + "-" + Date.now());
  writeFileSync(ask + ".tmp", JSON.stringify({ signal, gen }));
  renameSync(ask + ".tmp", ask + ".ask");
  const answer = (tries) => {
    for (let i = 0; i < tries && !existsSync(ask + ".said") && running(label); i++) spawnSync("sleep", ["0.05"]);
    return existsSync(ask + ".said") ? readFileSync(ask + ".said", "utf8") : null;
  };
  const said = answer(200);
  if (said !== null) return said;
  try { renameSync(ask + ".ask", ask + ".withdrawn"); return running(label) ? "timeout" : "gone"; } catch {}
  return answer(200) ?? "timeout";
}
const recordOf = (label, kind) => existsSync(join(STATE, label + "." + kind)) ? readFileSync(join(STATE, label + "." + kind), "utf8").split("\n").filter(Boolean) : [];
const runsOf = (label) => recordOf(label, "runs");
// A run its supervisor started and never saw exit: read only once that supervisor is gone, whose
// records are then final, so nothing can stop that run.
const unmatched = (label) => runsOf(label).length > recordOf(label, "exits").length;
const outstanding = (label) => !running(label) && unmatched(label);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const xml = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function plistJob(file) {
  const text = readFileSync(file, "utf8");
  const label = xml(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)[1]);
  const words = [.../<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xml(m[1]));
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  const env = {};
  if (envBlock) for (const m of envBlock[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[xml(m[1])] = xml(m[2]);
  return { label, words, env };
}
function unitWords(line) {
  const words = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return words;
}
function unitJob(file, label) {
  const lines = readFileSync(file, "utf8").split("\n");
  const exec = lines.find((line) => line.startsWith("ExecStart="));
  const env = {};
  for (const line of lines.filter((l) => l.startsWith("Environment="))) {
    const [pair] = unitWords(line.slice("Environment=".length));
    const at = pair.indexOf("=");
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { label, words: unitWords(exec.slice("ExecStart=".length)), env };
}
// A start the journey asked to be refused, as launchd refuses an agent while
// the person turned its background item off: the count left goes down by one.
function refused() {
  const file = join(STATE, "refuse");
  const left = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (left <= 0) return false;
  writeFileSync(file, String(left - 1));
  return true;
}
function begin(job) {
  if (refused()) return 5;
  // Read once: a job already running is left as it is, and one whose supervisor died before a run
  // it started was seen to exit, which shows as active, is refused, so no second run starts beside it.
  if (running(job.label)) return 0;
  if (unmatched(job.label)) return 1;
  rmSync(goneFile(job.label), { force: true });
  writeFileSync(jobFile(job.label), JSON.stringify(job));
  const log = openSync(join(STATE, job.label + ".log"), "a");
  const supervisor = spawn(process.execPath, [__filename, "__supervise", job.label], { detached: true, stdio: ["ignore", log, log], env: process.env });
  supervisor.unref();
  // The service manager answers once the job is loaded, as launchctl does.
  for (let i = 0; i < 200 && !existsSync(pidFile(job.label)); i++) spawnSync("sleep", ["0.05"]);
  return 0;
}
const jobFile = (label) => join(STATE, label + ".job.json");
// Its supervisor's process number, or null once it took its file away as it exited.
function supervisorOf(label) {
  try { return Number(readFileSync(pidFile(label), "utf8")); } catch { return null; }
}
// Running: its supervisor is there, as systemd shows an active unit.
function running(label) {
  const supervisor = supervisorOf(label);
  return supervisor !== null && alive(supervisor);
}
// Stopping a job takes it away, as launchd's bootout unloads it, until it is started again.
const goneFile = (label) => join(STATE, label + ".gone");
// A stop the journey asked to race: the job's run fails just before the stop takes effect, and
// the stop waits until its supervisor has started it again as another process.
function restartFirst(label) {
  const file = join(STATE, label + ".restart-on-stop");
  if (!existsSync(file) || !running(label)) return;
  rmSync(file, { force: true });
  const before = runsOf(label);
  signalRun(label, "SIGKILL", before.length);
  for (let i = 0; i < 600 && !(runsOf(label).length > before.length && alive(Number(runsOf(label)[before.length]))); i++) spawnSync("sleep", ["0.05"]);
}
// Stops the job through its supervisor, as bootout and systemctl stop do, and says it is unloaded
// only once that supervisor has exited: a stop that did not end it in time fails (code 1), as does
// one whose supervisor died before a run it started was seen to exit.
function end(label) {
  restartFirst(label);
  // Its supervisor read once: one gone by then is gone for good and its records are final, so a run
  // it never saw exit leaves the job as it was, and only a job with none is called stopped.
  const supervisor = supervisorOf(label);
  if (supervisor === null || !alive(supervisor)) {
    if (unmatched(label)) return 1;
    writeFileSync(goneFile(label), "");
    return 3;
  }
  const said = signalRun(label, "stop", null);
  for (let i = 0; i < 600 && said !== "timeout" && alive(supervisor); i++) spawnSync("sleep", ["0.05"]);
  // Unloaded only once its supervisor exited having seen its run exit: one that died first, its run
  // never seen to exit, leaves the job as it was.
  if (alive(supervisor) || unmatched(label)) return 1;
  writeFileSync(goneFile(label), "");
  return 0;
}
// Ends the job's current run by force, as launchd's kickstart -k and systemd's kill with SIGKILL
// do; its supervisor starts it again, as after any failed exit.
function kill(label) {
  if (!running(label)) return 3;
  signalRun(label, "SIGKILL", null);
  return 0;
}
// The job's run now, by its process number, as launchd's print shows its pid and systemd its
// MainPID: none while its supervisor waits to start it again, or once it is stopped.
function current(label) {
  const runs = runsOf(label);
  if (!running(label) || runs.length === 0) return null;
  const pid = Number(runs[runs.length - 1]);
  return alive(pid) ? pid : null;
}
// Starts the job unless it runs, as launchd's kickstart without -k and systemd's start do: a job
// already running is left as it is.
function startLoaded(label) {
  if (running(label)) return 0;
  if (!existsSync(jobFile(label))) return 113;
  return begin(JSON.parse(readFileSync(jobFile(label), "utf8")));
}
function supervise(label) {
  const job = JSON.parse(readFileSync(join(STATE, label + ".job.json"), "utf8"));
  writeFileSync(pidFile(label), String(process.pid));
  let child = null;
  // The run number of the child now: its line in the runs record, from 1.
  let gen = runsOf(label).length;
  let stopping = false;
  const start = () => {
    // Its own process group, as launchd and systemd start a job's program in a session of its own.
    child = spawn(job.words[0], job.words.slice(1), { stdio: "inherit", detached: true, env: { ...process.env, ...job.env } });
    appendFileSync(join(STATE, label + ".runs"), child.pid + "\n");
    gen += 1;
    child.on("exit", (code) => {
      appendFileSync(join(STATE, label + ".exits"), String(code) + "\n");
      if (stopping || code === 0) { rmSync(pidFile(label), { force: true }); process.exit(0); }
      setTimeout(start, 1000);
    });
  };
  const live = () => child !== null && child.exitCode === null && child.signalCode === null;
  const ending = (signal) => {
    stopping = true;
    if (live()) child.kill(signal);
    else setImmediate(() => { rmSync(pidFile(label), { force: true }); process.exit(0); });
  };
  // Asks of this job (signalRun, and the journey's own), each taken by renaming it so an ask taken
  // back is never acted on: a signal reaches only the child it started as that run number, while
  // that child has not ended; "state" says whether that child is "stopped" (suspended) or
  // "running"; "stop" ends the job as bootout and systemctl stop do, and "teardown" by force.
  setInterval(() => {
    for (const name of readdirSync(STATE)) {
      if (!name.startsWith(label + ".signal-") || !name.endsWith(".ask")) continue;
      const base = join(STATE, name.slice(0, -".ask".length));
      try { renameSync(base + ".ask", base + ".taken"); } catch { continue; }
      const { signal, gen: asked } = JSON.parse(readFileSync(base + ".taken", "utf8"));
      const ours = live() && (asked === null || asked === gen);
      let said = "gone";
      // A crash the journey asked for at the job's next stop: the supervisor dies before it stops
      // its run, as a supervisor that crashed leaves its run behind.
      const crash = join(STATE, label + ".crash-on-stop");
      if (signal === "stop" && existsSync(crash)) {
        rmSync(crash, { force: true });
        process.exit(1);
      }
      if (signal === "stop" || signal === "teardown") {
        ending(signal === "stop" ? "SIGTERM" : "SIGKILL");
        said = "sent";
      } else if (signal === "state") {
        if (ours) said = spawnSync("ps", ["-o", "stat=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim().startsWith("T") ? "stopped" : "running";
      } else if (ours) {
        child.kill(signal);
        said = "sent";
      }
      writeFileSync(base + ".tmp", said);
      renameSync(base + ".tmp", base + ".said");
      rmSync(base + ".taken", { force: true });
    }
  }, 50);
  start();
}
let code = 0;
if (args[0] === "__supervise") supervise(args[1]);
else if (args[0] === "bootstrap") code = begin(plistJob(args[2]));
else if (args[0] === "bootout") code = end(args[1].split("/").pop());
// A domain is always there, and a job until it is stopped, as launchd holds what it loaded.
else if (args[0] === "print") {
  const label = args[1].split("/").length < 3 ? null : args[1].split("/").pop();
  code = label === null || !existsSync(goneFile(label)) ? 0 : 113;
  const pid = label === null || code !== 0 ? null : current(label);
  if (pid !== null) writeSync(1, "\tpid = " + pid + "\n");
}
else if (args[0] === "kickstart" && args[1] === "-k") code = kill(args[2].split("/").pop());
else if (args[0] === "kickstart") code = startLoaded(args[1].split("/").pop());
else if (args[0] === "--user" && args[1] === "kill" && args[2] === "--signal=SIGKILL") code = kill(args[3]);
else if (args[0] === "--user" && args[1] === "start") code = begin(unitJob(join(__UNITS__, args[2] + ".service"), args[2]));
else if (args[0] === "--user" && args[1] === "stop") code = end(args[2]);
else if (args[0] === "--user" && args[1] === "restart") {
  code = end(args[2]) === 1 ? 1 : begin(unitJob(join(__UNITS__, args[2]), args[2]));
}
// A job's ActiveState, as systemd shows it: active while its supervisor runs, or while a run it
// started was never seen to exit, its supervisor gone first; inactive once stopped.
else if (args[0] === "--user" && args[1] === "show" && args[2] === "--property=MainPID") {
  writeSync(1, String(current(args[4]) ?? 0) + "\n");
}
else if (args[0] === "--user" && args[1] === "show" && args[2] === "--property=ActiveState" && existsSync(jobFile(args[4]))) {
  writeSync(1, running(args[4]) || outstanding(args[4]) ? "active\n" : "inactive\n");
}
else if (args[0] === "--user") code = 0;
else code = 1;
if (args[0] !== "__supervise") process.exit(code);
`;

export type ServiceManagerStandIn = {
  /** Its folder: the stand-in, its records and each job's output. */
  dir: string;
  /** The settings that name it to the app: `INFINITARY_LAUNCHCTL` or `INFINITARY_SYSTEMCTL`. */
  env: Record<string, string>;
  /** Each run of the job it started, by process number, in order. */
  runs: (label: string) => number[];
  /** Each run's exit code, in order; null for a signal. */
  exits: (label: string) => (number | null)[];
  /** Whether it is running the job now. */
  running: (label: string) => boolean;
  /** Refuses the next `count` starts it is asked for, as launchd refuses an agent whose background item is off. */
  refuseStarts: (count: number) => void;
  /** At the job's next stop, its run fails first and the job starts it again as another process before the stop takes effect. */
  restartOnStop: (label: string) => void;
  /** At the job's next stop, its supervisor dies before it stops its run, which it leaves running. */
  crashOnStop: (label: string) => void;
  /**
   * Signals the job's run with process number `pid` through the supervisor that started it, named
   * by its run number (its first place in `runs`), only while that run has not ended: "sent";
   * "gone" when it ended, another run is the job's now, or its supervisor is not there; "timeout"
   * when the supervisor did not answer, the ask then taken back unless it was already taken.
   */
  signal: (label: string, signal: NodeJS.Signals, pid: number) => Promise<SupervisorAnswer>;
  /** Whether that run is "stopped" (suspended) or "running", as its supervisor reads it, or "gone". */
  state: (label: string, pid: number) => Promise<SupervisorAnswer>;
  /** Every start or stop it was asked for, by its words, in order; readings are left out. */
  asks: () => string[];
  /**
   * Ends every supervisor and its job, through each supervisor; throws naming any still running, or
   * any run whose supervisor ended before seeing it exit.
   */
  stopAll: () => void;
};

export type SupervisorAnswer = "sent" | "gone" | "timeout" | "stopped" | "running";

/** The stand-in, for a window whose HOME is `homeDir` (its systemd units sit under its `.config`). */
export function serviceManagerStandIn(homeDir: string): ServiceManagerStandIn {
  const dir = scratchDir("infinitary-service-manager-");
  const program = join(dir, process.platform === "linux" ? "systemctl" : "launchctl");
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    program,
    `#!${process.execPath}\n${PROGRAM.replace("__STATE__", JSON.stringify(state)).replaceAll(
      "__UNITS__",
      JSON.stringify(join(homeDir, ".config", "systemd", "user")),
    )}`,
  );
  chmodSync(program, 0o755);
  const lines = (label: string, kind: "runs" | "exits") => {
    const file = join(state, `${label}.${kind}`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  };
  const supervisor = (label: string) => {
    const file = join(state, `${label}.pid`);
    try {
      return Number(readFileSync(file, "utf8"));
    } catch (error) {
      // The supervisor can remove its PID record while teardown is checking it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let asked = 0;
  /** Leaves an ask for the job's supervisor, naming the run by its run number; its file's base. */
  const ask = (label: string, signal: string, gen: number | null) => {
    asked += 1;
    const file = join(state, `${label}.signal-journey-${process.pid}-${asked}`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ signal, gen }));
    renameSync(`${file}.tmp`, `${file}.ask`);
    return file;
  };
  const running = (label: string) => {
    const pid = supervisor(label);
    return pid !== null && alive(pid);
  };
  const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const said = (file: string) =>
    existsSync(`${file}.said`) ? (readFileSync(`${file}.said`, "utf8") as SupervisorAnswer) : null;
  /** Asks the supervisor of the run with process number `pid`, and waits for its answer. */
  const request = async (label: string, signal: string, pid: number): Promise<SupervisorAnswer> => {
    const gen = lines(label, "runs").map(Number).indexOf(pid) + 1;
    if (gen === 0 || !running(label)) return "gone";
    const file = ask(label, signal, gen);
    const answer = async () => {
      for (let i = 0; i < 200 && said(file) === null && running(label); i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return said(file);
    };
    const first = await answer();
    if (first !== null) return first;
    try {
      // Taken back before the supervisor took it, so it is never acted on.
      renameSync(`${file}.ask`, `${file}.withdrawn`);
      return running(label) ? "timeout" : "gone";
    } catch {
      return (await answer()) ?? "timeout";
    }
  };
  return {
    dir,
    env: {
      [process.platform === "linux" ? "INFINITARY_SYSTEMCTL" : "INFINITARY_LAUNCHCTL"]: program,
    },
    runs: (label) => lines(label, "runs").map(Number),
    exits: (label) => lines(label, "exits").map((code) => (code === "null" ? null : Number(code))),
    running,
    refuseStarts: (count) => writeFileSync(join(state, "refuse"), String(count)),
    restartOnStop: (label) => writeFileSync(join(state, `${label}.restart-on-stop`), ""),
    crashOnStop: (label) => writeFileSync(join(state, `${label}.crash-on-stop`), ""),
    signal: (label, signal, pid) => request(label, signal, pid),
    state: (label, pid) => request(label, "state", pid),
    asks: () => {
      const file = join(state, "asks");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    },
    stopAll: () => {
      const labels = readdirSync(state)
        .filter((name) => name.endsWith(".runs"))
        .map((name) => name.slice(0, -".runs".length));
      const asks = labels.filter(running).map((label) => ask(label, "teardown", null));
      for (let i = 0; i < 200 && labels.some(running); i++) pause(50);
      // Still running, or a run its supervisor started and never saw exit, as where that supervisor
      // died first: nothing here signals its saved number, so the run may still be there.
      const left = labels.filter(
        (label) => running(label) || lines(label, "runs").length > lines(label, "exits").length,
      );
      // An ask no supervisor took is taken back, so nothing acts on it after the journey.
      for (const file of asks)
        try {
          renameSync(`${file}.ask`, `${file}.withdrawn`);
        } catch {}
      if (left.length > 0)
        throw new Error(
          `the stand-in service manager did not stop ${left
            .map((label) =>
              running(label)
                ? `${label} (supervisor ${supervisor(label)})`
                : `${label} (run ${lines(label, "runs").at(-1)}, its supervisor gone before it exited)`,
            )
            .join(", ")}`,
        );
    },
  };
}

/**
 * A journey's cleanup after a test that used the stand-in: stops it
 * (`stopAll`) and runs each of `steps`, each whatever another's fails; keeps
 * its records and each command's output at `keepTo` when the test failed or
 * any of those failed; and throws what failed, the first teardown failure
 * first, with a failure to keep the records after it, which fails the
 * cleanup even alone.
 */
export function afterStandIn(
  kept: ServiceManagerStandIn | null,
  failed: boolean,
  keepTo: () => string,
  steps: (() => void)[] = [],
): void {
  const failures: unknown[] = [];
  for (const step of [() => kept?.stopAll(), ...steps])
    try {
      step();
    } catch (error) {
      failures.push(error);
    }
  if (kept && (failed || failures.length > 0))
    try {
      cpSync(kept.dir, keepTo(), { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const said = failures.map((failure) =>
      failure instanceof Error ? failure.message : String(failure),
    );
    throw new AggregateError(failures, `${said[0]} (and then: ${said.slice(1).join("; ")})`);
  }
}
