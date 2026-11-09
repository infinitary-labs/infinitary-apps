// INF-662 piece 1: the phone check builds once and gives each device's tests their own
// test home. Xcode writes the scheme's PHONE_TEST_HOME, empty, into each test target's
// environment in the built test plan (.xctestrun, format 1: one key per target).

/** INF-2014's accepted fail-fast repeats: local gates stop at their first failed part so shell
 * repeat loops return their place promptly. CI keeps full discovery unless explicitly requested;
 * the same explicit 0 preserves deliberate full-discovery local runs. */
export function phoneStopsEarly(env: Record<string, string | undefined>): boolean {
  return env.INFINITARY_PHONE_STOP_EARLY === undefined
    ? !env.CI
    : env.INFINITARY_PHONE_STOP_EARLY === "1";
}

/** The plutil key paths of every test target's PHONE_TEST_HOME in a built test plan, read as JSON. */
export function testHomeKeys(plan: Record<string, unknown>): string[] {
  const keys = Object.entries(plan).filter(([, target]) => {
    const environment = (target as { EnvironmentVariables?: Record<string, unknown> } | null)?.EnvironmentVariables;
    return typeof environment === "object" && environment !== null && "PHONE_TEST_HOME" in environment;
  }).map(([name]) => `${name}.EnvironmentVariables.PHONE_TEST_HOME`);
  if (keys.length === 0) throw new Error("The built test plan has no PHONE_TEST_HOME to name a test home in");
  return keys;
}

// INF-662 piece 2 (the captain's "Both at once, journey in parts"): the phone journey is in parts,
// and each runs alone from its own test home and a clean app on its device's one simulator
// (INF-1438), the devices side by side. The order is each device's start order. INF-1878: INF-1735's
// 20 relaunch pairs are parts of their own.
// INF-2125 direction C (the captain's "Shared fixes, then short parts", so each pull request's phone
// check finishes quickly): join, talk, cards and relaunch are each split into short tests, named for
// the part they came from, so a check of the parts a change reaches can run the closest one alone.
// INF-804: `photos` marks a part that chooses a library photo; the gate waits for its device's Photos
// to open its shared-with-you library first, since Photos hands over no chosen photo before then.
// INF-2052: the parts that choose a photo run last, so their device's library photo goes in after the
// device's other parts; a photo added during Photos' background migration held the first part's app
// install on each device for 1 to 13 minutes in runs 41045215266, 41145496442 and 41146815994, and a
// photo added last can still be held (536 seconds before the iPhone's talk in run 41247888712), but
// it holds no part before it.
export const PHONE_JOURNEY = "InfinitaryUITests/PhoneJourney";
export const PHONE_PARTS = [
  { name: "join-read", test: "testJoinAndRead", photos: false },
  { name: "join-activity", test: "testActivityAndCatchUp", photos: false },
  { name: "join-away", test: "testAwayLeaveAndRemoved", photos: false },
  { name: "talk-tasks", test: "testTasksAndSteer", photos: false },
  { name: "talk-drafts", test: "testDraftsAcrossHomes", photos: false },
  { name: "relaunch-first", test: "testRelaunchPairsFirstTen", photos: false },
  { name: "relaunch-second", test: "testRelaunchPairsSecondTen", photos: false },
  { name: "cards-merge", test: "testMergeCard", photos: false },
  { name: "cards-form", test: "testCardForm", photos: false },
  { name: "cards-media", test: "testCardMediaAndBody", photos: false },
  // INF-1183: joining a home by its address, against the Mac's own sshd beside the test home.
  { name: "address", test: "testJoinByAddress", photos: false },
  // INF-2095: the pager pick journey launches fresh, so it needs a simulator no other journey joined first.
  { name: "pick", test: "testMenuPickSurvivesAWorkspaceRedraw", photos: false },
  // INF-2565: a revision while the thread shows keeps the card on its back.
  { name: "cards-revise", test: "testRevisionKeepsTheThreadShowing", photos: false },
  // INF-2568: the message box and a card's reply with the keyboard up; each launches fresh and the merge fixture runs once a home.
  { name: "keyboard-pinned", test: "testKeyboardOverPinnedCard", photos: false },
  { name: "keyboard-scrolling", test: "testKeyboardOverScrollingCard", photos: false },
  // INF-3106: each way out of a card's reply keyboard and the message box's, the keyboard-down button among them.
  { name: "keyboard-ways-out", test: "testKeyboardWaysOut", photos: false },
  // INF-2989: the weak link checks (INF-2668, INF-2669) wait out real links and silences, about five minutes a
  // device, which doubled the rest part they joined. An app-hosted class of their own, so a change to the other
  // app-hosted tests repeats only the rest part and a change to these repeats only them.
  { name: "weak-link", suite: "InfinitaryTests/PhoneWeakLinkTests", photos: false },
  { name: "talk-compose", test: "testComposeAndSend", photos: true },
  // The last part runs every test no other part names: the app-hosted tests and any new one that
  // needs no fresh app, since its simulator already holds the character journey's join.
  { name: "rest", test: "testCharacterAndPastChoices", photos: true },
] as const;
export type PhonePart = (typeof PHONE_PARTS)[number]["name"];

/** The XCTest identifier a part runs: its journey test, or the whole test class it names as its `suite`. */
export function partIdentifier(part: { test: string } | { suite: string }): string {
  return "suite" in part ? part.suite : `${PHONE_JOURNEY}/${part.test}`;
}
export type PhoneDevice = "iphone" | "ipad";

/** INF-1083: ordinary XCTest must still stop a stuck test, not wait for the job limit.
 * Twenty minutes bounds each ordinary test while the outer gate keeps its own ninety-minute cap.
 * Quiet grading keeps Xcode's original allowances. Neither mode disables its timeouts.
 * INF-2052 (the captain's choice "Also stop Xcode collecting diagnostics after a failed part"): after a failed test
 * Xcode waited 600 seconds for the simulator's diagnostics and timed out with none, in each failed part of run
 * 41196507458; the gate keeps its own failure logs.
 */
export function phoneExecutionArguments(grades: boolean): string[] {
  return ["-test-timeouts-enabled", "YES", "-collect-test-diagnostics", "never", ...(grades ? [] : [
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
  if (index < PHONE_PARTS.length - 1) return [`-only-testing:${partIdentifier(PHONE_PARTS[index]!)}`];
  return PHONE_PARTS.slice(0, -1).map((part) => `-skip-testing:${partIdentifier(part)}`);
}

/** Whether a part drives the app through a UI journey test, rather than running an app-hosted class alone. */
export function partRunsJourney(name: string): boolean {
  const part = PHONE_PARTS.find((each) => each.name === name);
  if (!part) throw new Error(`No phone journey part is named ${name}`);
  return "test" in part;
}

/** INF-2625's phone guard: a part passes on xcodebuild's exit status, and a test XCTest never found fails nothing, so
 * the gate also asks that the part's own journey test started, read from XCTest's own "Test Case ... started" line,
 * or, for a part that runs a whole class, its "Test Suite ... started" line. */
export function partTestStarted(name: string, output: string): boolean {
  const part = PHONE_PARTS.find((each) => each.name === name);
  if (!part) throw new Error(`No phone journey part is named ${name}`);
  if ("suite" in part) return output.includes(`Test Suite '${part.suite.split("/").at(-1)}' started at `);
  return output.includes(`Test Case '-[${PHONE_JOURNEY.replace("/", ".")} ${part.test}]' started.`);
}

/** Every device's parts in start order: each part on the slower iPad first, then on the iPhone.
 * INF-1438: the gate runs each device's parts in this order on the one simulator it starts for that device. */
export function phoneJobs(devices: PhoneDevice[], parts: readonly string[] = PHONE_PARTS.map((part) => part.name)) {
  for (const part of parts) partSelection(part);
  const order: PhoneDevice[] = ["ipad", "iphone"];
  return PHONE_PARTS.filter((part) => parts.includes(part.name))
    .flatMap((part) => order.filter((device) => devices.includes(device)).map((device) => ({ device, part: part.name })));
}

/** INF-1735's soak: each relaunch part runs ten dark/light relaunch pairs, twenty across the two parts
 * (PhoneJourney's testRelaunchPairsFirstTen and testRelaunchPairsSecondTen). */
export const RELAUNCH_PAIRS_PER_PART = 10;

/** How many relaunch pairs each relaunch part runs: every one unless a count is given. INF-2582 direction A:
 * a request on a branch gives 1, so it runs 2 of the 20 pairs, and the release check keeps all 20. */
export function relaunchPairs(value: string | undefined): number {
  if (value === undefined || value === "") return RELAUNCH_PAIRS_PER_PART;
  const pairs = Number(value);
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > RELAUNCH_PAIRS_PER_PART)
    throw new Error(`Relaunch pairs per part must be a whole number from 1 to ${RELAUNCH_PAIRS_PER_PART}, not ${value}`);
  return pairs;
}

/** One part's run in a gate: its device, its part, and which pass of the gate it belongs to. */
export type PhoneJob = { device: PhoneDevice; part: string; round: number };

/** The passes after the ordinary one that a part whose test code changed takes (INF-2259: three in all). */
export const PHONE_REPEAT_ROUNDS = [2, 3] as const;

/** INF-2582 direction A (the captain's choices "A: wait once and trim the soak" and "iPhone only; iPad
 * waits for the release check"): one gate runs every pass on the build and simulators it started.
 * Round one runs `parts` on every device and `iphoneOnly` on the iPhone alone; rounds two and three
 * then run `repeats` again on the iPhone alone, after its round one; the iPad runs a repeated part
 * once (INF-2732, the captain's "run each edited phone part three times on the iPhone and once on the iPad").
 * Each device's jobs are in the order its lane runs them (`runDeviceLanes`), and the iPad's lane starts
 * first, as `phoneJobs`. */
export function phonePasses(devices: PhoneDevice[], { parts = [], iphoneOnly = [], repeats = [] }: {
  parts?: readonly string[]; iphoneOnly?: readonly string[]; repeats?: readonly string[];
}): PhoneJob[] {
  for (const part of [...parts, ...iphoneOnly, ...repeats]) partSelection(part);
  const first = phoneJobs(devices, [...parts, ...iphoneOnly])
    .filter(({ device, part }) => device === "iphone" || !iphoneOnly.includes(part) || parts.includes(part))
    .map((job) => ({ ...job, round: 1 }));
  const order: PhoneDevice[] = ["ipad", "iphone"];
  return order.filter((device) => devices.includes(device)).flatMap((device) => [
    ...first.filter((job) => job.device === device),
    ...(device === "iphone"
      ? PHONE_REPEAT_ROUNDS.flatMap((round) => phoneJobs([device], repeats).map((job) => ({ ...job, round })))
      : []),
  ]);
}

/** INF-2052: a device's Photos, made ready in two stages. `watched` begins the wait for Photos to open its library
 * once, when the device starts, since that wait reads the library's opening since boot and ends at a ceiling after
 * boot. `ready` adds the library photo once, after that wait, only when the device's first part that chooses a photo
 * asks, and every later part that chooses one hears the same outcome. `restarted` forgets both, for a device that
 * started again; its next `watched` waits from the new start. */
export function devicePhotos(watch: () => Promise<void>, add: () => Promise<void>) {
  let watching: Promise<void> | undefined;
  let adding: Promise<void> | undefined;
  const watched = () => (watching ??= watch());
  return {
    watched,
    ready: () => (adding ??= watched().then(add)),
    restarted: () => {
      watching = adding = undefined;
    },
  };
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
