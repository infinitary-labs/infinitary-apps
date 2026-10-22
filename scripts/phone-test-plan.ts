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

// INF-662 piece 2 (the captain's "Both at once, journey in parts"): the phone journey is four
// tests, and each runs alone from its own fresh simulator and test home, side by side with the
// others. The order is the start order, longest first as measured on Oct 19 and 20: join and
// recover 4.2 minutes, talk and tasks 3.7, cards 2.3, the character and past choices 0.7.
// INF-804: `photos` marks a part that chooses a library photo; its runner waits for Photos to open
// its shared-with-you library first, since Photos hands over no chosen photo before then.
export const PHONE_JOURNEY = "InfinitaryUITests/PhoneJourney";
export const PHONE_PARTS = [
  { name: "join", test: "testJoinAndRecover", photos: false },
  { name: "talk", test: "testTalkAndTasks", photos: true },
  { name: "cards", test: "testCards", photos: false },
  // The last part runs every test no other part names: the app-hosted tests and any new one.
  { name: "rest", test: "testCharacterAndPastChoices", photos: true },
] as const;
export type PhonePart = (typeof PHONE_PARTS)[number]["name"];
export type PhoneDevice = "iphone" | "ipad";

/** The xcodebuild arguments that choose one part's tests from the built test plan. */
export function partSelection(name: string): string[] {
  const index = PHONE_PARTS.findIndex((part) => part.name === name);
  if (index < 0) throw new Error(`No phone journey part is named ${name}`);
  if (index < PHONE_PARTS.length - 1) return [`-only-testing:${PHONE_JOURNEY}/${PHONE_PARTS[index]!.test}`];
  return PHONE_PARTS.slice(0, -1).map((part) => `-skip-testing:${PHONE_JOURNEY}/${part.test}`);
}

/** Every device's parts in start order: each part on the slower iPad first, then on the iPhone. */
export function phoneJobs(devices: PhoneDevice[], parts: readonly string[] = PHONE_PARTS.map((part) => part.name)) {
  for (const part of parts) partSelection(part);
  const order: PhoneDevice[] = ["ipad", "iphone"];
  return PHONE_PARTS.filter((part) => parts.includes(part.name))
    .flatMap((part) => order.filter((device) => devices.includes(device)).map((device) => ({ device, part: part.name })));
}

/** Runs each job once, at most `slots` at a time, in order; one job's failure stops none of the others. */
export async function runSideBySide<Job, Result>(jobs: Job[], slots: number, run: (job: Job) => Promise<Result>): Promise<Result[]> {
  if (!Number.isInteger(slots) || slots < 1) throw new Error("Run at least one simulator at a time");
  const results: Result[] = [];
  const errors: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      try {
        results[index] = await run(jobs[index]!);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, jobs.length) }, worker));
  if (errors.length) throw errors[0];
  return results;
}
