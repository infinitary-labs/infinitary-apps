/** INF-5387's plan, piece 1: every command the phone check runs has a deadline on the load clock, clean-up on a frozen
 * simulator included. A command past it is ended with its processes, what it waited on is kept in the evidence, and
 * the check fails naming it. Nothing is retried. A screenshot that froze one simulator held a part's restart of its
 * test program, and with it the whole job, for 3 hours 50 minutes, until GitHub's own step limit (run 44682920550). */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { budgetTimer, type DeadlineTimer } from "../tests/helpers/budgets.ts";

/** A simulator-control command or any other small one: `simctl`, `plutil`, `ps`, `sample`. The longest such command the
 * 3-hour check's own evidence shows (a photo import, about 106 seconds between its logs) doubled and rounded up. */
export const PHONE_COMMAND_BUDGET_MS = 4 * 60_000;
/** Building the app for testing, measured at 2.0 to 2.4 minutes on the phone Macs. */
export const PHONE_BUILD_BUDGET_MS = 10 * 60_000;
/** The phone's Swift package tests, measured at 0.7 to 1.1 minutes on the phone Macs. */
export const PHONE_PACKAGE_TESTS_BUDGET_MS = 5 * 60_000;
/** The least a part is given, however short its recorded time: its app's start and its own test home. */
export const PHONE_PART_BUDGET_FLOOR_MS = 3 * 60_000;

/** INF-5387's plan, piece 2, and INF-5546: the recorded minutes (`scripts/phone-part-times.json`) one job of a manual
 * request holds at most, each device past its first counted as `PHONE_DEVICE_START_MS` (`phoneJobMs`). The recorded
 * times come from a full gate that ran two simulators at once. A job may land on a phone Mac with one simulator, which
 * runs its parts one after another at up to 1.08 of their recorded minutes (a job of twelve short iPhone parts, run
 * 44868118991; a job of six long ones ran at 0.69). Its gate step also builds the app for up to 3.1 minutes, starts
 * the first part about a minute late and cleans up. INF-6058: it also starts no part until the simulator's wallpaper
 * prewarm has finished, which on the phone Macs came 1.1 and 2.0 minutes after the build ended (runs 44868828667 and
 * 44965884426). So a job of 20 recorded minutes ends near 27.7 minutes there (20 × 1.08 + 3.1 + 1 + 2.0), inside the
 * gate step's 30-minute limit
 * in phone.yml, and sooner on a phone Mac with two simulators. The first job's package tests add about a minute,
 * which its Mac part, counted here though it runs beside the simulators, covers.
 * INF-6039's plan, part 1: in a request dealt into several jobs, the first job builds the app in a step of its own
 * before its gate and uploads it for the others, and its gate and theirs skip the build when they take it; the first
 * job's build and upload then come before its gate, so that job's limit in phone.yml is 12 minutes longer, 46, the
 * build step's own limit, and its gate's 30 still ends inside it.
 * INF-6234's plan: raised from 14 recorded minutes to 20, since about 40% of each job is start-up and clean-up and the
 * phone Macs were nearly full at peak, so fewer, longer jobs finish a check sooner. */
export const PHONE_JOB_BUDGET_MS = 20 * 60_000;
/** INF-5546: what each device past a job's first adds on a phone Mac with one simulator, which starts a device only
 * after the last one's parts end: deleting that simulator and starting the next took 40 to 72 seconds, and the new
 * device's first part ran about a minute past its recorded time (runs 44868118991 and 44868828667). INF-6058 adds a
 * minute for the new simulator's wallpaper prewarm, which its first part now waits for: on the phone Macs a later
 * device's start, that wait included, took 1.8 and 2.3 minutes, and its first part then ran inside its recorded time
 * (run 45005056719). */
export const PHONE_DEVICE_START_MS = 3 * 60_000;

export const phoneMinutes = (ms: number): string => (ms / 60_000).toFixed(1);

/** A part's recorded time, from each part's longer device time; a part with no recorded time counts as the median
 * recorded part, and with no record at all as nothing. */
export function recordedPartMs(part: string, times: ReadonlyMap<string, number> | undefined): number {
  const recorded = [...(times?.values() ?? [])].toSorted((a, b) => a - b);
  return times?.get(part) ?? recorded[Math.floor(recorded.length / 2)] ?? 0;
}

/** A part's deadline: twice its recorded time (`scripts/phone-part-times.json`, `recordedPartMs`), and at least the
 * floor. XCTest's per-test allowance is this too. */
export function phonePartBudget(part: string, times: ReadonlyMap<string, number> | undefined): number {
  return Math.max(2 * recordedPartMs(part, times), PHONE_PART_BUDGET_FLOOR_MS);
}

/** The deadline of one command `run` starts, unless its caller names its own, as a part's test does. */
export function phoneCommandBudget(command: string, args: readonly string[]): number {
  const name = basename(command);
  if (name === "xcodebuild" && args.includes("build-for-testing")) return PHONE_BUILD_BUDGET_MS;
  if (name === "swift" && args[0] === "test") return PHONE_PACKAGE_TESTS_BUDGET_MS;
  return PHONE_COMMAND_BUDGET_MS;
}

/** How a command is named when it passes its deadline: the program and what it was asked to do, never a path. */
export function phoneCommandName(command: string, args: readonly string[]): string {
  const name = basename(command);
  const words = args.filter((arg) => /^[a-z][a-z_-]*$/.test(arg));
  if (name === "xcodebuild")
    return [name, args.find((arg) => ["build-for-testing", "test-without-building"].includes(arg)) ?? args[0] ?? ""].join(" ").trim();
  return [name, ...words.slice(0, name === "xcrun" ? 2 : 1)].join(" ");
}

/** A deadline that passed. Its message names what passed it, its minutes, and where what it waited on is kept. */
export class PhoneDeadlinePassed extends Error {}

/** Waits for `work` within `budget` on the load clock. Past it, `late` keeps what the work waited on and ends it, and
 * the wait fails naming `name` and its minutes; the work is never started again, and its own end is not awaited. */
export async function withinPhoneDeadline<T>(name: string, budget: number, work: Promise<T>,
  late: () => Promise<string | undefined>): Promise<T> {
  let timer: DeadlineTimer | undefined;
  const passed = new Promise<"passed">((resolve) => { timer = budgetTimer(() => resolve("passed"), budget); });
  try {
    const first = await Promise.race([work.then((value) => ({ value })), passed]);
    if (first !== "passed") return first.value;
  } finally {
    timer?.cancel();
  }
  work.catch(() => {});
  const kept = await late().catch((error: unknown) => `what it waited on could not be kept: ${String(error)}`);
  throw new PhoneDeadlinePassed(`${name} did not finish within its ${phoneMinutes(budget)}-minute deadline, so the check `
    + `ended it and retried nothing${kept ? `; ${kept}` : ""}`);
}

type Run = (command: string, args: string[]) => Promise<string>;

/** A command for the record of a hang, itself within the command deadline; it never throws, it says what failed. */
const recordRun = (env: NodeJS.ProcessEnv): Run => (command, args) => new Promise((resolve) => {
  execFile(command, args, { env, timeout: PHONE_COMMAND_BUDGET_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => resolve(error ? `${command} ${args[0] ?? ""} failed: ${error.message}\n${stderr}` : stdout));
});

type Process = { pid: number; ppid: number; line: string };

/** `pid` and every process under it, from one `ps` reading of this account's processes, the deepest last. */
export function phoneProcessTree(pid: number, reading: string): Process[] {
  const all = reading.split("\n").flatMap((line) => {
    const [own, parent] = line.trim().split(/\s+/).map(Number);
    return own && parent !== undefined && !Number.isNaN(parent) ? [{ pid: own, ppid: parent, line: line.trim() }] : [];
  });
  const tree = all.filter((each) => each.pid === pid);
  for (let index = 0; index < tree.length; index++)
    tree.push(...all.filter((each) => each.ppid === tree[index]!.pid && !tree.some((kept) => kept.pid === each.pid)));
  return tree;
}

/** Keeps what a command past its deadline waited on, then ends it: its processes as `ps` lists them, a sample of each,
 * and its simulator's state, in `hung-<name>.txt` and its samples beside it in `evidence`. Answers where they are. */
export async function endPhoneHang({ name, pid, evidence, simulator, env, run = recordRun(env), end = process.kill }: {
  name: string;
  pid: number | undefined;
  evidence: string;
  simulator?: string;
  env: NodeJS.ProcessEnv;
  run?: Run;
  end?: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<string> {
  const file = `hung-${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now()}`;
  const tree = pid ? phoneProcessTree(pid, await run("/bin/ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,comm="])) : [];
  const lines = [`${name} passed its deadline at ${new Date().toISOString()}.`, "", "Its processes (pid, parent, state, running for, program):",
    ...(tree.length ? tree.map((each) => each.line) : ["none found"])];
  await Promise.all(tree.map(async ({ pid: each }) => {
    const said = await run("/usr/bin/sample", [String(each), "3", "-mayDie", "-file", join(evidence, `${file}-${each}.sample.txt`)]);
    if (/failed:/.test(said)) lines.push(`The sample of ${each}: ${said.split("\n")[0]}`);
  }));
  if (simulator) {
    const listed = await run("xcrun", ["simctl", "list", "devices", "-j"]);
    let state = listed.split("\n")[0]!;
    try {
      const devices = Object.values((JSON.parse(listed) as { devices: Record<string, { udid: string; state: string }[]> }).devices).flat();
      state = devices.find((device) => device.udid === simulator)?.state ?? "not listed";
    } catch { /* the reading's own failure is the state */ }
    lines.push("", `Its simulator ${simulator}: ${state}`);
  }
  await writeFile(join(evidence, `${file}.txt`), `${lines.join("\n")}\n`);
  // The deepest first, so no parent restarts a child it lost.
  for (const { pid: each } of tree.toReversed()) {
    try { end(each, "SIGKILL"); } catch { /* it ended on its own */ }
  }
  return `what it waited on is in ${file}.txt`;
}
