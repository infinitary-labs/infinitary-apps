import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
 * each run it started, by its process number, and ends its supervisors
 * when the journey ends.
 */

/** The supervisor and its job, in the stand-in's own program; `__STATE__` is its folder. */
const PROGRAM = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, writeSync, openSync } = require("node:fs");
const { join } = require("node:path");
const STATE = __STATE__;
const args = process.argv.slice(2);
const pidFile = (label) => join(STATE, label + ".pid");
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
  rmSync(goneFile(job.label), { force: true });
  const running = existsSync(pidFile(job.label)) && alive(Number(readFileSync(pidFile(job.label), "utf8")));
  if (running) return 0;
  writeFileSync(jobFile(job.label), JSON.stringify(job));
  const log = openSync(join(STATE, job.label + ".log"), "a");
  const supervisor = spawn(process.execPath, [__filename, "__supervise", job.label], { detached: true, stdio: ["ignore", log, log], env: process.env });
  supervisor.unref();
  // The service manager answers once the job is loaded, as launchctl does.
  for (let i = 0; i < 200 && !existsSync(pidFile(job.label)); i++) spawnSync("sleep", ["0.05"]);
  return 0;
}
const jobFile = (label) => join(STATE, label + ".job.json");
// Running: its supervisor is there, as systemd shows an active unit.
function running(label) {
  return existsSync(pidFile(label)) && alive(Number(readFileSync(pidFile(label), "utf8")));
}
// Stopping a job takes it away, as launchd's bootout unloads it, until it is started again.
const goneFile = (label) => join(STATE, label + ".gone");
// A stop the journey asked to race: the job's run fails just before the stop takes effect, and
// the stop waits until its supervisor has started it again as another process.
function restartFirst(label) {
  const file = join(STATE, label + ".restart-on-stop");
  if (!existsSync(file) || !running(label)) return;
  rmSync(file, { force: true });
  const runs = () => readFileSync(join(STATE, label + ".runs"), "utf8").split("\n").filter(Boolean);
  const before = runs();
  try { process.kill(Number(before[before.length - 1]), "SIGKILL"); } catch {}
  for (let i = 0; i < 600 && !(runs().length > before.length && alive(Number(runs()[before.length]))); i++) spawnSync("sleep", ["0.05"]);
}
function end(label) {
  restartFirst(label);
  writeFileSync(goneFile(label), "");
  if (!existsSync(pidFile(label))) return 3;
  const pid = Number(readFileSync(pidFile(label), "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 600 && alive(pid); i++) spawnSync("sleep", ["0.05"]);
  return 0;
}
// Ends the job's current run by force, as launchd's kickstart -k and systemd's kill with SIGKILL
// do; its supervisor starts it again, as after any failed exit.
function kill(label) {
  if (!existsSync(pidFile(label)) || !alive(Number(readFileSync(pidFile(label), "utf8")))) return 3;
  const runs = readFileSync(join(STATE, label + ".runs"), "utf8").split("\n").filter(Boolean);
  try { process.kill(Number(runs[runs.length - 1]), "SIGKILL"); } catch {}
  return 0;
}
// The job's run now, by its process number, as launchd's print shows its pid and systemd its
// MainPID: none while its supervisor waits to start it again, or once it is stopped.
function current(label) {
  if (!running(label) || !existsSync(join(STATE, label + ".runs"))) return null;
  const runs = readFileSync(join(STATE, label + ".runs"), "utf8").split("\n").filter(Boolean);
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
  let stopping = false;
  const start = () => {
    // Its own process group, as launchd and systemd start a job's program in a session of its own.
    child = spawn(job.words[0], job.words.slice(1), { stdio: "inherit", detached: true, env: { ...process.env, ...job.env } });
    appendFileSync(join(STATE, label + ".runs"), child.pid + "\n");
    child.on("exit", (code) => {
      appendFileSync(join(STATE, label + ".exits"), String(code) + "\n");
      if (stopping || code === 0) { rmSync(pidFile(label), { force: true }); process.exit(0); }
      setTimeout(start, 1000);
    });
  };
  process.on("SIGTERM", () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    else { rmSync(pidFile(label), { force: true }); process.exit(0); }
  });
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
  end(args[2]);
  code = begin(unitJob(join(__UNITS__, args[2]), args[2]));
}
// A job's ActiveState, as systemd shows it: active while its supervisor runs, inactive once stopped.
else if (args[0] === "--user" && args[1] === "show" && args[2] === "--property=MainPID") {
  writeSync(1, String(current(args[4]) ?? 0) + "\n");
}
else if (args[0] === "--user" && args[1] === "show" && args[2] === "--property=ActiveState" && existsSync(jobFile(args[4]))) {
  writeSync(1, running(args[4]) ? "active\n" : "inactive\n");
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
  /** Ends every supervisor and its job. */
  stopAll: () => void;
};

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
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    dir,
    env: {
      [process.platform === "linux" ? "INFINITARY_SYSTEMCTL" : "INFINITARY_LAUNCHCTL"]: program,
    },
    runs: (label) => lines(label, "runs").map(Number),
    exits: (label) => lines(label, "exits").map((code) => (code === "null" ? null : Number(code))),
    running: (label) => {
      const pid = supervisor(label);
      return pid !== null && alive(pid);
    },
    refuseStarts: (count) => writeFileSync(join(state, "refuse"), String(count)),
    restartOnStop: (label) => writeFileSync(join(state, `${label}.restart-on-stop`), ""),
    stopAll: () => {
      for (const name of readdirSync(state)) {
        if (!name.endsWith(".pid")) continue;
        const pid = Number(readFileSync(join(state, name), "utf8"));
        const runs = lines(name.slice(0, -".pid".length), "runs").map(Number);
        for (const each of [pid, ...runs])
          try {
            process.kill(each, "SIGKILL");
          } catch {
            // Already ended.
          }
      }
    },
  };
}
