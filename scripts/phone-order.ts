/**
 * The release order between the phone and the desktop app (INF-1649; docs/alpha.md,
 * "The phone goes first"). The captain's words: "alpha desktop builds wait for phone
 * build is on testflight. stable desktop releases wait for phone builds are live in
 * app store (which we haven't done yet, so enforce this only once the first ios app
 * release is live in app store)".
 *
 * A desktop release waits for a phone build that keeps changing things on it: one
 * whose contract the release's view floor reaches (`contractAccess` with a view,
 * src/shared/ipc.ts). An alpha waits for such a build on TestFlight, as Apple
 * confirmed it to ios-release.yml's availability job; a stable waits for such a
 * build live in the App Store, and waits for nothing until Apple shows a version
 * of Infinitary was ever released there. Once one was, a stable always waits,
 * also while no version is live (INF-1649 review R7, the captain's "Once the app
 * has been released, stable releases always need a compatible live phone version"). A major that kept views leaves the TestFlight build
 * already there enough; a major that broke views makes the phone build go first.
 *
 * release.yml's phone job runs it from the workflow's own commit, in a clone with
 * every branch and tag, and reads each contract from git. Plain Node type
 * stripping, no install.
 *
 *   CHANNEL=alpha|stable SOURCE_COMMIT=<sha> GH_TOKEN=... GITHUB_REPOSITORY=owner/name
 *   [DRY_RUN=true] [APP_STORE_CONNECT_*] node scripts/phone-order.ts
 *
 * A rehearsal says what a live release would wait for, and never fails on it.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { legacyJobName } from "./ci-job-names.mjs";
import { type AppleRead, appleReader, findPhoneApp } from "./phone-release.ts";

/** What one commit's contract says: its major, and its view floor (absent before INF-1649). */
export type Contract = { major: number; floor: number | null };

/** Reads a commit's src/shared/ipc.ts: `PROTOCOL_VERSION`'s major and `VIEW_FLOOR`. */
export function contractOf(ipcSource: string): Contract {
  const version = /export const PROTOCOL_VERSION = "(\d+)\.\d+\.\d+";/.exec(ipcSource);
  if (!version) throw new Error("This commit's src/shared/ipc.ts names no PROTOCOL_VERSION.");
  const floor = /export const VIEW_FLOOR = (\d+);/.exec(ipcSource);
  return { major: Number(version[1]), floor: floor ? Number(floor[1]) : null };
}

/**
 * Whether a phone built on one contract changes things on a desktop app built on
 * another: the version rule for a view, as `contractAccess` applies it
 * (src/shared/ipc.ts; tests/phone-order.test.ts holds the two together). The
 * desktop decides: one built before the floor answers any other major only its
 * reads, whatever the phone's hello says.
 */
export function phoneChanges(phone: Contract, desktop: Contract): boolean {
  if (phone.major === desktop.major) return true;
  if (desktop.floor === null) return false;
  if (phone.major < desktop.major) return phone.major >= desktop.floor;
  return phone.floor !== null && phone.floor <= desktop.major;
}

export type Run = {
  id: number;
  run_number: number;
  head_sha: string;
  display_title: string;
  status: string;
  conclusion: string | null;
};
type Job = { name: string; status: string; conclusion: string | null };

/** A phone build: its build number, as Apple shows it, and the commit it was built from. */
export type PhoneBuild = { build: string; source: string };

/**
 * The phone builds Apple confirmed on TestFlight, newest first, from
 * ios-release.yml's runs: a release run whose availability job passed, or a
 * status check of an earlier run's build (`check build <run>.<attempt>`) that
 * passed. The build number is the release run's number and attempt
 * (scripts/release-phone.sh), so the build's commit is that run's. A build
 * Apple once confirmed stays one: the captain's "A past success is enough"
 * (INF-1649 review R2), so nothing asks Apple whether it is still there.
 */
export async function testFlightBuilds(
  runs: readonly Run[],
  jobsOf: (run: Run) => Promise<readonly Job[]>,
): Promise<PhoneBuild[]> {
  const builds: PhoneBuild[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const jobs = await jobsOf(run);
    if (!jobs.some((job) => legacyJobName(job.name) === "availability" && job.conclusion === "success")) continue;
    const checked = /check build (\d+)\.(\d+)$/.exec(run.display_title);
    if (!checked) {
      builds.push({ build: `${run.run_number}.1`, source: run.head_sha });
      continue;
    }
    const built = runs.find((candidate) => String(candidate.run_number) === checked[1]);
    if (built) builds.push({ build: `${checked[1]}.${checked[2]}`, source: built.head_sha });
  }
  return builds;
}

/** Apple's states of a version that was released: live, replaced by a newer one, or removed from sale. */
const RELEASED_STATES = new Set([
  "READY_FOR_SALE",
  "READY_FOR_DISTRIBUTION",
  "REPLACED_WITH_NEW_VERSION",
  "REMOVED_FROM_SALE",
  "DEVELOPER_REMOVED_FROM_SALE",
]);

/**
 * What the App Store shows of Infinitary: whether any version was ever released
 * there, and the phone build live now, or null while none is. Apple's version
 * states: READY_FOR_SALE (appStoreState) and READY_FOR_DISTRIBUTION
 * (appVersionState) are live; a replaced or removed version was released.
 */
export async function storeRelease(
  read: AppleRead,
  app: string,
): Promise<{ released: boolean; live: string | null }> {
  const answer = await read(
    `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&include=build&limit=200`,
  );
  if (answer.links?.next) throw new Error("Apple's App Store version listing is incomplete.");
  const live = answer.data.find(
    (version) =>
      version.attributes?.appStoreState === "READY_FOR_SALE" ||
      version.attributes?.appVersionState === "READY_FOR_DISTRIBUTION",
  );
  const released = answer.data.some(
    (version) =>
      RELEASED_STATES.has(String(version.attributes?.appStoreState ?? "")) ||
      RELEASED_STATES.has(String(version.attributes?.appVersionState ?? "")),
  );
  if (!live) return { released, live: null };
  const buildId = live.relationships?.build?.data?.id;
  const build = answer.included?.find((part) => part.type === "builds" && part.id === buildId);
  const number = build?.attributes?.version;
  if (typeof number !== "string")
    throw new Error("Apple lists a live App Store version without its build.");
  return { released: true, live: number };
}

function contractAt(commit: string): Contract {
  return contractOf(
    execFileSync("git", ["show", `${commit}:src/shared/ipc.ts`], { encoding: "utf8" }),
  );
}

async function github<T>(path: string, env: NodeJS.ProcessEnv): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${env.GH_TOKEN ?? ""}`,
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
  return (await response.json()) as T;
}

/**
 * Every ios-release.yml run, newest first, read page by page to the last: a
 * build checked long after its run, or live in the App Store for a while, may
 * be past the first page.
 */
export async function phoneRuns(
  list: (page: number) => Promise<{ total_count: number; workflow_runs: Run[] }>,
): Promise<Run[]> {
  const runs: Run[] = [];
  for (let page = 1; ; page++) {
    const listed = await list(page);
    runs.push(...listed.workflow_runs);
    if (listed.workflow_runs.length === 0 || runs.length >= listed.total_count) return runs;
  }
}

function listPhoneRuns(repo: string, env: NodeJS.ProcessEnv) {
  return phoneRuns((page) =>
    github<{ total_count: number; workflow_runs: Run[] }>(
      `/repos/${repo}/actions/workflows/ios-release.yml/runs?branch=main&event=workflow_dispatch&per_page=100&page=${page}`,
      env,
    ),
  );
}

async function main() {
  const env = process.env;
  const channel = env.CHANNEL;
  const source = env.SOURCE_COMMIT ?? "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  const rehearsal = env.DRY_RUN === "true";
  if (channel !== "alpha" && channel !== "stable") throw new Error("Set CHANNEL to alpha or stable.");
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Set SOURCE_COMMIT to the release's commit.");
  const desktop = contractAt(source);
  const say = (line: string) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const refuse = (line: string) => {
    if (rehearsal) return say(`A live ${channel} would wait: ${line}`);
    console.log(`::error title=Waiting for the phone::${line}`);
    process.exitCode = 1;
  };

  if (channel === "alpha") {
    const runs = await listPhoneRuns(repo, env);
    const builds = await testFlightBuilds(runs, async (run) => {
      const answer = await github<{ jobs: Job[] }>(
        `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        env,
      );
      return answer.jobs;
    });
    const fits = builds.find((build) => phoneChanges(contractAt(build.source), desktop));
    if (fits)
      return say(
        `The phone build ${fits.build} on TestFlight keeps changing things on contract ${desktop.major}.`,
      );
    return refuse(
      `no phone build on TestFlight changes things on contract ${desktop.major} (view floor ${desktop.floor ?? desktop.major}). Run ios-release.yml from main and wait for its availability job before this alpha.`,
    );
  }

  const read = appleReader(env);
  const { released, live } = await storeRelease(read, await findPhoneApp(read));
  if (!released)
    return say("No version of Infinitary was released in the App Store yet, so this stable waits for no phone.");
  if (live === null)
    return refuse(
      `no version of Infinitary is live in the App Store, though one was released before. Release a phone build that changes things on contract ${desktop.major} to the App Store before this stable.`,
    );
  const run = live.split(".")[0];
  const built = (await listPhoneRuns(repo, env)).find((candidate) => String(candidate.run_number) === run);
  if (!built)
    return refuse(`the App Store's live phone build ${live} has no ios-release.yml run to read its contract from.`);
  if (phoneChanges(contractAt(built.head_sha), desktop))
    return say(`The phone build ${live} live in the App Store keeps changing things on contract ${desktop.major}.`);
  return refuse(
    `the phone build ${live} live in the App Store does not change things on contract ${desktop.major}. Release a phone build that does to the App Store before this stable.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const words = error instanceof Error ? error.message : "The phone order could not be read.";
    // A rehearsal publishes nothing, so what it could not read is said, never a failure.
    if (process.env.DRY_RUN === "true") return console.log(`A live release could not read the phone: ${words}`);
    console.error(words);
    process.exitCode = 1;
  });
}
