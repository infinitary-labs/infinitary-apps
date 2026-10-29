// INF-662 piece 1: the phone check builds once and gives each device's tests their own
// test home. Xcode writes the scheme's PHONE_TEST_HOME, empty, into each test target's
// environment in the built test plan (.xctestrun, format 1: one key per target).

/** The plutil key paths of every test target's PHONE_TEST_HOME in a built test plan, read as JSON. */
export function testHomeKeys(plan: Record<string, unknown>): string[] {
  const keys = Object.entries(plan).filter(([, target]) => {
    const environment = (target as { EnvironmentVariables?: Record<string, unknown> } | null)?.EnvironmentVariables;
    return typeof environment === "object" && environment !== null && "PHONE_TEST_HOME" in environment;
  }).map(([name]) => `${name}.EnvironmentVariables.PHONE_TEST_HOME`);
  if (keys.length === 0) throw new Error("The built test plan has no PHONE_TEST_HOME to name a test home in");
  return keys;
}

// INF-662 piece 2 (the captain's "Both at once, journey in parts"): the phone journey is six
// tests, and each runs alone from its own test home and a clean app on its device's one simulator
// (INF-1438), the devices side by side. The order is the start order, longest first as measured
// on Oct 19 and 20: join and recover 4.2 minutes, talk and tasks 3.7, cards 2.3, the character and
// past choices 0.7. INF-1878: INF-1735's 20 relaunch pairs took about 11 of the talk part's 20 minutes
// on the loaded Mac mini of run 40937645392, so they are a part of their own beside it.
// INF-804: `photos` marks a part that chooses a library photo; the gate waits for its device's Photos
// to open its shared-with-you library first, since Photos hands over no chosen photo before then.
export const PHONE_JOURNEY = "InfinitaryUITests/PhoneJourney";
export const PHONE_PARTS = [
  { name: "join", test: "testJoinAndRecover", photos: false },
  { name: "talk", test: "testTalkAndTasks", photos: true },
  { name: "relaunch", test: "testRelaunchThenTasks", photos: false },
  { name: "cards", test: "testCards", photos: false },
  // INF-1183: joining a home by its address, against the Mac's own sshd beside the test home.
  { name: "address", test: "testJoinByAddress", photos: false },
  // The last part runs every test no other part names: the app-hosted tests and any new one.
  { name: "rest", test: "testCharacterAndPastChoices", photos: true },
] as const;
export type PhonePart = (typeof PHONE_PARTS)[number]["name"];
export type PhoneDevice = "iphone" | "ipad";

/** INF-1083: ordinary XCTest must still stop a stuck test, not wait for the job limit.
 * Twenty minutes bounds each ordinary test while the outer gate keeps its own sixty-minute cap.
 * Quiet grading keeps Xcode's original allowances. Neither mode disables its timeouts.
 */
export function phoneExecutionArguments(grades: boolean): string[] {
  return ["-test-timeouts-enabled", "YES", ...(grades ? [] : [
    "-default-test-execution-time-allowance", "1200",
    "-maximum-test-execution-time-allowance", "1200",
  ])];
}

/** INF-1541 piece 1 (the captain's choice "The test code skips Apple's animation wait and checks each target itself"):
 * every journey replaces XCTest's private quiescence wait so no wait asks for the app's animation reply, and prints
 * "Phone animation wait skipped: " once it has (ios/Infinitary/InfinitaryUITests/PhoneAnimationWait.swift); a part whose
 * log never says so ran with Apple's wait. `missed` counts XCTest's own line for an animation wait that ran out, which
 * INF-1538's stalled part printed 18 times; the replacement leaves none, so any the gate counts got past it. */
export function phoneAnimationWaits(output: string): { skipped: boolean; missed: number } {
  const lines = output.split("\n");
  return {
    skipped: lines.some((line) => line.includes("Phone animation wait skipped: ")),
    missed: lines.filter((line) => line.includes("App animations complete notification not received")).length,
  };
}

/** The xcodebuild arguments that choose one part's tests from the built test plan. */
export function partSelection(name: string, waitsOnly = false): string[] {
  // INF-1083: prove the native clock in either mode without grading unrelated UI journeys.
  if (waitsOnly) {
    if (name !== "rest") throw new Error("Native wait-clock tests belong to the rest part");
    return ["-only-testing:InfinitaryUITests/PhoneWaitsTests"];
  }
  const index = PHONE_PARTS.findIndex((part) => part.name === name);
  if (index < 0) throw new Error(`No phone journey part is named ${name}`);
  if (index < PHONE_PARTS.length - 1) return [`-only-testing:${PHONE_JOURNEY}/${PHONE_PARTS[index]!.test}`];
  return PHONE_PARTS.slice(0, -1).map((part) => `-skip-testing:${PHONE_JOURNEY}/${part.test}`);
}

/** Every device's parts in start order: each part on the slower iPad first, then on the iPhone.
 * INF-1438: the gate runs each device's parts in this order on the one simulator it starts for that device. */
export function phoneJobs(devices: PhoneDevice[], parts: readonly string[] = PHONE_PARTS.map((part) => part.name)) {
  for (const part of parts) partSelection(part);
  const order: PhoneDevice[] = ["ipad", "iphone"];
  return PHONE_PARTS.filter((part) => parts.includes(part.name))
    .flatMap((part) => order.filter((device) => devices.includes(device)).map((device) => ({ device, part: part.name })));
}

/** Runs each job once, at most `slots` at a time, in order; one job's failure stops none of the others,
 * unless `stopAfter` holds for a job's result or the job throws: then no further job starts and the
 * signal each running job holds aborts. A job that never started leaves its result undefined. */
export async function runSideBySide<Job, Result>(jobs: Job[], slots: number, run: (job: Job, signal: AbortSignal) => Promise<Result>,
  stopAfter?: (result: Result) => boolean): Promise<(Result | undefined)[]> {
  if (!Number.isInteger(slots) || slots < 1) throw new Error("Run at least one simulator at a time");
  const results: (Result | undefined)[] = jobs.map(() => undefined);
  const errors: unknown[] = [];
  const stopping = new AbortController();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !stopping.signal.aborted) {
      const index = next++;
      try {
        results[index] = await run(jobs[index]!, stopping.signal);
        if (stopAfter?.(results[index]!)) stopping.abort();
      } catch (error) {
        errors.push(error);
        if (stopAfter) stopping.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, jobs.length) }, worker));
  if (errors.length) throw errors[0];
  return results;
}

/** What a device's lane needs from the gate: the device it starts once, each of its jobs on that device, and its end. */
export type DeviceLane<Job extends { device: string }, Device, Result> = {
  /** Starts the device once, before its first job; a failure here leaves every job of the lane unstarted. */
  open: (device: Job["device"], stopping: AbortSignal) => Promise<Device>;
  /** Runs one job on the opened device; the signal aborts when the lanes stop. */
  run: (job: Job, opened: Device, stopping: AbortSignal) => Promise<Result>;
  /** Ends the device after the lane's last job, whether it ran, failed or stopped. */
  close: (opened: Device) => Promise<void>;
};

/** INF-1438 (the captain's "Start each simulated device once per phone check, not once per part"): runs
 * the jobs of each device in order on one device the lane opens once and closes at its end, the devices'
 * lanes side by side, at most `slots` at a time. One job's failure stops none of the others, unless
 * `stopAfter` holds for a job's result or a job throws: then no lane starts another job and the signal each
 * running job holds aborts, while every opened device still closes. A job that never started leaves its
 * result undefined, and the first error is thrown once every lane has ended. */
export async function runDeviceLanes<Job extends { device: string }, Device, Result>(jobs: Job[], slots: number,
  lane: DeviceLane<Job, Device, Result>, stopAfter?: (result: Result) => boolean): Promise<(Result | undefined)[]> {
  const devices = [...new Set(jobs.map((job) => job.device))] as Job["device"][];
  const results: (Result | undefined)[] = jobs.map(() => undefined);
  const errors: unknown[] = [];
  const stopping = new AbortController();
  const failed = (error: unknown) => {
    errors.push(error);
    if (stopAfter) stopping.abort();
  };
  await runSideBySide(devices, slots, async (device) => {
    if (stopping.signal.aborted) return;
    let opened: Device;
    try { opened = await lane.open(device, stopping.signal); }
    catch (error) { return failed(error); }
    try {
      for (const [index, job] of jobs.entries()) {
        if (job.device !== device || stopping.signal.aborted) continue;
        try {
          results[index] = await lane.run(job, opened, stopping.signal);
          if (stopAfter?.(results[index]!)) stopping.abort();
        } catch (error) { failed(error); }
      }
    } finally {
      await lane.close(opened).catch((error) => errors.push(error));
    }
  });
  if (errors.length) throw errors[0];
  return results;
}
