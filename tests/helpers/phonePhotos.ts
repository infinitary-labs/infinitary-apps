import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { budgetTimer, type DeadlineTimer, GRADES_BUDGETS } from "./budgets.ts";

// INF-804: on a fresh simulator Photos hands over a chosen photo only once it has opened its shared-with-you
// library, which took up to six minutes after boot with simulators booting side by side. A part that chooses a
// photo waits for Photos to say so, and fails rather than wait past its finite boot ceiling.
// INF-1170: Photos can also fail to open that library, or wait on a call that never comes back, and then the
// message never arrives. The wait reads both in Photos' own log and recovers each once, so a slow start still
// waits, a failed one ends at once if it fails again, and a stalled one gets its call answered.
const PHOTOS_SAYS =
  'eventMessage CONTAINS "opened syndication photo library" OR eventMessage CONTAINS "failed to open syndication library"' +
  ' OR eventMessage CONTAINS "Submitting task request for background migration"';
export const PHOTOS_LOG =
  `(process == "assetsd" AND (${PHOTOS_SAYS}))` +
  ' OR (process == "dasd" AND eventMessage CONTAINS "SUBMITTING: com.apple.assetsd.migration")';
const PHOTOS_OPENED = /\sassetsd\[[^\]]*\].* opened syndication photo library/;
// Photos' own words when that library did not open, such as error 46110; Photos does not try again by itself.
const PHOTOS_FAILED = /\sassetsd\[[^\]]*\].* failed to open syndication library/;
// While Photos sets up a library it asks the simulator's background-task scheduler (dasd) to take a task, and
// waits until the scheduler takes it up.
const PHOTOS_ASKED =
  /\sassetsd\[[^\]]*\].* Submitting task request for background migration with identifier (\S+)/;
const SCHEDULER_TOOK = /\sdasd\[[^\]]*\].* SUBMITTING: (com\.apple\.assetsd\.migration\.[^:\s]+):/;
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/;
// A healthy simulator's scheduler took up Photos' call within 17 seconds on a quiet Mac mini, and within one on
// the virtual Macs; the stalled one in run 40124610875 took 970 seconds, and stalled again after.
export const SCHEDULER_ANSWER_BUDGET_MS = 30_000;
// The Photos app: an app asking for the library makes a restarted Photos open its libraries again.
const PHOTOS_APP = "com.apple.mobileslideshow";
/** The readiness stream's own output, kept in the part's evidence however the wait ends. */
export const PHOTOS_STREAM_LOG = "photos-stream.log";

export const logTime = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ` +
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
const logStamp = (date: Date) =>
  `${logTime(date)}.${String(date.getMilliseconds()).padStart(3, "0")}`;

/**
 * Waits for the owned simulator's Photos to open its shared-with-you library.
 * INF-907: a wait that fails before the part's tests start keeps what explains it - the readiness stream's
 * output and the simulator's log since boot (failureLog's processes) - before the gate deletes the simulator.
 * INF-1170: when Photos says it failed to open the library, the wait restarts Photos once and asks it for its
 * libraries again; when Photos' call to the scheduler goes unanswered past its budget, the wait restarts the
 * scheduler, which takes the call up again. The ceiling after boot is the same either way.
 * INF-1438: on the simulator the gate starts once for a device's every part, the wait begins when the device
 * starts, beside its first part; the query since boot finds a library Photos opened before the stream began,
 * and `stopping` ends the wait when the gate stops.
 */
export async function photosOpened({
  device,
  booting,
  stopping,
  env,
  evidence,
  children,
  run,
  failureLog,
}: {
  device: string;
  booting: Date;
  stopping?: AbortSignal;
  env: NodeJS.ProcessEnv;
  evidence: string;
  children: Set<ChildProcess>;
  run: (command: string, args: string[]) => Promise<string>;
  failureLog: string;
}): Promise<void> {
  const stream = spawn(
    "xcrun",
    ["simctl", "spawn", device, "log", "stream", "--style", "compact", "--predicate", PHOTOS_LOG],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(stream);
  const heard: string[] = [];
  const afterBoot = () => Math.round((Date.now() - booting.getTime()) / 1000);
  // Every Photos line once, whether the stream or the query since boot brought it.
  const read = new Set<string>();
  // Each library task Photos asked the scheduler to take, its latest asking and the scheduler's latest take-up.
  const asked = new Map<string, { at: string; line: string }>();
  const taken = new Map<string, string>();
  const stalls = new Map<string, DeadlineTimer>();
  const rescued = new Set<string>();
  let photosRestarted: string | undefined;
  let photosApp = false;
  let recovering = Promise.resolve();
  let settled = false;
  let listening!: () => void;
  const started = new Promise<void>((resolve) => {
    listening = resolve;
  });
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    ready = () => {
      settled = true;
      resolve();
    };
    fail = (error) => {
      settled = true;
      reject(error);
    };
  });
  // One recovery at a time, and none once the wait has ended.
  const recover = (step: () => Promise<void>) => {
    recovering = recovering.then(() => (settled ? undefined : step())).catch(fail);
  };
  const pending = (task: string) => {
    const ask = asked.get(task);
    if (!ask || (photosRestarted && ask.at < photosRestarted)) return false;
    const take = taken.get(task);
    return !take || take < ask.at;
  };
  const restartScheduler = async (task: string) => {
    const ask = asked.get(task);
    if (!ask || !pending(task) || rescued.has(task)) return;
    for (const each of asked.keys()) if (pending(each)) rescued.add(each);
    console.log(
      `Photos' call to the simulator's background-task scheduler went unanswered; restarting the scheduler` +
        ` ${afterBoot()} seconds after boot: ${ask.line.trim()}`,
    );
    await run("xcrun", [
      "simctl",
      "spawn",
      device,
      "launchctl",
      "kickstart",
      "-k",
      "user/foreground/com.apple.dasd",
    ]).catch((error: Error) => {
      throw new Error(
        `The simulator's background-task scheduler left Photos' call unanswered and could not be restarted: ${error.message}`,
      );
    });
  };
  const restartPhotos = async (line: string) => {
    if (photosRestarted) return;
    photosRestarted = logStamp(new Date());
    console.log(
      `Photos failed to open its shared-with-you library; restarting Photos ${afterBoot()} seconds after boot: ${line.trim()}`,
    );
    try {
      await run("xcrun", [
        "simctl",
        "spawn",
        device,
        "launchctl",
        "kickstart",
        "-k",
        "user/foreground/com.apple.assetsd",
      ]);
      photosApp = true;
      await run("xcrun", ["simctl", "launch", device, PHOTOS_APP]);
    } catch (error) {
      throw new Error(
        `Photos failed to open its shared-with-you library and could not be restarted: ${(error as Error).message}`,
      );
    }
  };
  const hear = (line: string) => {
    if (read.has(line)) return;
    const at = STAMP.exec(line)?.[0];
    if (!at) return;
    read.add(line);
    if (PHOTOS_OPENED.test(line)) return ready();
    if (PHOTOS_FAILED.test(line)) {
      if (!photosRestarted) return recover(() => restartPhotos(line));
      if (at >= photosRestarted)
        return fail(
          new Error(
            "Photos failed to open its shared-with-you library again after the gate restarted it," +
              ` and a part that chooses a photo needs it: ${line.trim()}`,
          ),
        );
      return;
    }
    const task = PHOTOS_ASKED.exec(line)?.[1];
    if (task) {
      if (at > (asked.get(task)?.at ?? "")) asked.set(task, { at, line });
      // A failure deadline for the scheduler's answer, not a delay: only a call still unanswered restarts it.
      if (pending(task) && !stalls.has(line))
        stalls.set(
          line,
          budgetTimer(() => recover(() => restartScheduler(task)), SCHEDULER_ANSWER_BUDGET_MS),
        );
      return;
    }
    const took = SCHEDULER_TOOK.exec(line)?.[1];
    if (took && at > (taken.get(took) ?? "")) taken.set(took, at);
  };
  const deadline = setTimeout(
    () =>
      fail(
        new Error(
          `Photos had not opened its shared-with-you library ${GRADES_BUDGETS ? "fifteen" : "twenty"} minutes after boot,` +
            " and a part that chooses a photo needs it",
        ),
      ),
    Math.max(0, booting.getTime() + (GRADES_BUDGETS ? 15 : 20) * 60_000 - Date.now()),
  );
  const stop = () =>
    fail(new Error("The gate stopped before Photos opened its shared-with-you library"));
  stopping?.addEventListener("abort", stop, { once: true });
  if (stopping?.aborted) stop();
  stream.once("error", fail);
  stream.once("close", () => {
    children.delete(stream);
    fail(
      new Error(
        "The simulator's Photos log stopped before Photos opened its shared-with-you library",
      ),
    );
  });
  createInterface({ input: stream.stdout }).on("line", (line) => {
    heard.push(line);
    if (line.startsWith("Filtering the log data using ")) listening();
    else hear(line);
  });
  createInterface({ input: stream.stderr }).on("line", (line) => heard.push(line));
  opened.catch(() => {});
  try {
    await Promise.race([started, opened]);
    // The stream sees only what follows its start; the kept log covers the time from boot until then.
    const before = await run("xcrun", [
      "simctl",
      "spawn",
      device,
      "log",
      "show",
      "--style",
      "compact",
      "--start",
      logTime(booting),
      "--predicate",
      PHOTOS_LOG,
    ]);
    for (const line of before.split("\n")) hear(line);
    await opened;
    console.log(`Photos had opened its shared-with-you library ${afterBoot()} seconds after boot`);
  } catch (error) {
    // Whether Photos never opened its library or only its message went unseen, its own processes say.
    await run("xcrun", [
      "simctl",
      "spawn",
      device,
      "log",
      "show",
      "--start",
      logTime(booting),
      "--style",
      "compact",
      "--info",
      "--predicate",
      failureLog,
    ])
      .then(() => console.log("The simulator's log since boot is kept with the command logs"))
      .catch((problem: Error) =>
        console.log(`The simulator's log since boot could not be kept: ${problem.message}`),
      );
    throw error;
  } finally {
    settled = true;
    clearTimeout(deadline);
    stopping?.removeEventListener("abort", stop);
    for (const stall of stalls.values()) stall.cancel();
    stream.kill("SIGTERM");
    writeFileSync(join(evidence, PHOTOS_STREAM_LOG), heard.map((line) => `${line}\n`).join(""));
    await recovering;
    // The part's own app starts on a simulator with nothing else in front.
    if (photosApp) await run("xcrun", ["simctl", "terminate", device, PHOTOS_APP]).catch(() => {});
  }
}

// INF-1438: minutes after boot Photos runs a background migration of its library whose actions wait on services
// the simulator lacks, until the simulator's scheduler ends the migration ten to sixteen minutes later, and a
// photo added meanwhile waits as long (Oct 26's talk parts: 13.7 and 18.8 minutes). A healthy Photos takes the
// photo within a second, and a restarted one within a second more.
export const PHOTO_TAKEN_BUDGET_MS = 30_000;
// A restarted Photos opened its libraries again within two seconds; the wait asks every few seconds.
export const PHOTOS_REOPEN_BUDGET_MS = 120_000;
const REOPEN_ASK_MS = 5_000;
const PHOTOS_DAEMON = "user/foreground/com.apple.assetsd";

/**
 * Puts the library photo in the simulator's Photos, which has opened its library. When Photos has not taken it
 * within its budget, its background migration holds the library (INF-1438): the wait restarts Photos, which
 * starts that migration over later, adds the photo again, and ends once Photos has opened its shared-with-you
 * library again, which a part that chooses a photo needs as much as the photo.
 */
export async function libraryPhotoAdded({
  device,
  picture,
  run,
}: {
  device: string;
  picture: string;
  run: (command: string, args: string[]) => Promise<string>;
}): Promise<void> {
  const add = () => {
    const adding = run("xcrun", ["simctl", "addmedia", device, picture]);
    adding.catch(() => {});
    return adding;
  };
  // Whether Photos took the photo within the budget, the add failed, or Photos is still holding it.
  const within = async (adding: Promise<string>) => {
    let budget: DeadlineTimer | undefined;
    const stalled = new Promise<"stalled">((resolve) => {
      budget = budgetTimer(() => resolve("stalled"), PHOTO_TAKEN_BUDGET_MS);
    });
    try {
      return await Promise.race([
        adding.then(
          () => "taken" as const,
          () => "failed" as const,
        ),
        stalled,
      ]);
    } finally {
      budget?.cancel();
    }
  };
  const seconds = PHOTO_TAKEN_BUDGET_MS / 1000;
  const added = Date.now();
  const first = add();
  const outcome = await within(first);
  if (outcome === "taken") {
    console.log(
      `Photos took the library photo ${Math.round((Date.now() - added) / 1000)} seconds after the gate added it`,
    );
    return;
  }
  if (outcome === "failed") throw await first.catch((error: Error) => error);
  const restarted = new Date();
  console.log(
    `Photos had not taken the library photo ${seconds} seconds after the gate added it;` +
      " its background migration holds the library, so the gate restarts Photos and adds the photo again",
  );
  await run("xcrun", [
    "simctl",
    "spawn",
    device,
    "launchctl",
    "kickstart",
    "-k",
    PHOTOS_DAEMON,
  ]).catch((error: Error) => {
    throw new Error(
      `Photos had not taken the library photo and could not be restarted: ${error.message}`,
    );
  });
  // The add the migration held ends with the restart, taken or not, and no longer counts.
  const again = add();
  const after = await within(again);
  if (after === "failed") throw await again.catch((error: Error) => error);
  if (after === "stalled")
    throw new Error(
      `Photos had not taken the library photo ${seconds} seconds after the gate added it again, after restarting Photos,` +
        " and a part that chooses a photo needs it",
    );
  let late = false;
  const limit = budgetTimer(() => {
    late = true;
  }, PHOTOS_REOPEN_BUDGET_MS);
  try {
    for (;;) {
      const since = await run("xcrun", [
        "simctl",
        "spawn",
        device,
        "log",
        "show",
        "--style",
        "compact",
        "--start",
        logTime(restarted),
        "--predicate",
        PHOTOS_LOG,
      ]);
      const reopened = since
        .split("\n")
        .some(
          (line) =>
            PHOTOS_OPENED.test(line) && (STAMP.exec(line)?.[0] ?? "") >= logStamp(restarted),
        );
      if (reopened) {
        console.log(
          `Photos took the library photo and opened its shared-with-you library again ${Math.round((Date.now() - restarted.getTime()) / 1000)} seconds after its restart`,
        );
        return;
      }
      if (late)
        throw new Error(
          `Photos had not opened its shared-with-you library ${PHOTOS_REOPEN_BUDGET_MS / 60_000} minutes after the gate restarted it,` +
            " and a part that chooses a photo needs it",
        );
      await new Promise((resolve) => setTimeout(resolve, REOPEN_ASK_MS));
    }
  } finally {
    limit.cancel();
  }
}
