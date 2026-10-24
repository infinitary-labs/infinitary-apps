import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { GRADES_BUDGETS } from "./budgets.ts";

// INF-804: on a fresh simulator Photos hands over a chosen photo only once it has opened its shared-with-you
// library, which took up to six minutes after boot with simulators booting side by side. A part that chooses a
// photo waits for Photos to say so, and fails rather than wait past its finite boot ceiling.
export const PHOTOS_LOG =
  'process == "assetsd" AND eventMessage CONTAINS "opened syndication photo library"';
const PHOTOS_OPENED = /\sassetsd\[[^\]]*\].* opened syndication photo library/;
/** The readiness stream's own output, kept in the part's evidence however the wait ends. */
export const PHOTOS_STREAM_LOG = "photos-stream.log";

export const logTime = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ` +
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;

/**
 * Waits for the owned simulator's Photos to open its shared-with-you library.
 * INF-907: a wait that fails before the part's tests start keeps what explains it - the readiness stream's
 * output and the simulator's log since boot (failureLog's processes) - before the gate deletes the simulator.
 */
export async function photosOpened({
  device,
  booting,
  env,
  evidence,
  children,
  run,
  failureLog,
}: {
  device: string;
  booting: Date;
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
  let listening!: () => void;
  const started = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const opened = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () =>
        reject(
          new Error(
            `Photos had not opened its shared-with-you library ${GRADES_BUDGETS ? "fifteen" : "twenty"} minutes after boot,` +
              " and a part that chooses a photo needs it",
          ),
        ),
      booting.getTime() + (GRADES_BUDGETS ? 15 : 20) * 60_000 - Date.now(),
    );
    stream.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    stream.once("close", () => {
      clearTimeout(deadline);
      children.delete(stream);
      reject(
        new Error(
          "The simulator's Photos log stopped before Photos opened its shared-with-you library",
        ),
      );
    });
    createInterface({ input: stream.stdout }).on("line", (line) => {
      heard.push(line);
      if (line.startsWith("Filtering the log data using ")) listening();
      else if (PHOTOS_OPENED.test(line)) resolve();
    });
    createInterface({ input: stream.stderr }).on("line", (line) => heard.push(line));
  });
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
    if (!PHOTOS_OPENED.test(before)) await opened;
    console.log(
      `Photos had opened its shared-with-you library ${Math.round((Date.now() - booting.getTime()) / 1000)} seconds after boot`,
    );
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
    stream.kill("SIGTERM");
    writeFileSync(join(evidence, PHOTOS_STREAM_LOG), heard.map((line) => `${line}\n`).join(""));
  }
}
