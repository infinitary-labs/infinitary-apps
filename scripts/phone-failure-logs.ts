import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { logTime } from "../tests/helpers/phonePhotos.ts";
import type { phoneWebContentStartup } from "../tests/helpers/phoneWebContent.ts";
import { keepPhoneDiagnostic } from "./phone-checks.ts";

/** INF-1885: log show can exceed V8's largest string. Keep both pipes on disk with
 * backpressure, and join the child and writer even when collection fails. */
export async function runPhoneLog({ command, args, cwd, env, children, log }: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  children: Set<ChildProcess>;
  log: string;
}): Promise<void> {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const merged = new PassThrough();
  let problem: Error | undefined;
  const failed = (error: Error) => {
    if (problem) return;
    problem = error;
    child.kill("SIGTERM");
    child.stdout.destroy(error);
    child.stderr.destroy(error);
    merged.destroy(error);
  };
  // An error (including a failed spawn) is followed by close; keep ownership until then.
  child.once("error", failed);
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const written = pipeline(merged, createWriteStream(log)).catch(failed);
  const read = Promise.all([child.stdout, child.stderr].map((stream) => {
    stream.pipe(merged, { end: false });
    return finished(stream);
  })).then(() => { merged.end(); }).catch(failed);
  try {
    const [status] = await Promise.all([exited, read, written]);
    if (problem) throw new Error(`Could not keep ${log}: ${problem.message}`, { cause: problem });
    if (status !== 0) throw new Error(`${command} failed (${status}); see ${log}`);
  } finally {
    children.delete(child);
  }
}

/** A failed diagnostic must neither hide the next one nor replace the test failure.
 * The caller keeps the original error and its outer cleanup. */
export async function keepPhoneFailureLogs({ device, testing, appPredicate, systemPredicate,
  keepLog, nextLog, evidence, webContent, closeLive, report = console.log }: {
  device: string;
  testing: Date;
  appPredicate: string;
  systemPredicate: string;
  keepLog: (args: string[], log: string) => Promise<void>;
  nextLog: () => string;
  evidence: string;
  webContent: ReturnType<typeof phoneWebContentStartup>;
  closeLive: () => Promise<void>;
  report?: (message: string) => void;
}): Promise<void> {
  for (const [name, predicate, readWitnesses] of [
    ["log", appPredicate, true],
    ["system log", systemPredicate, false],
  ] as const) {
    try {
      const log = nextLog();
      await keepLog(["simctl", "spawn", device, "log", "show", "--start", logTime(testing),
        "--style", "compact", "--info", "--predicate", predicate], log);
      report(`The simulator's ${name} is in ${basename(log)}`);
      if (readWitnesses) {
        // Read the saved file incrementally, not a second whole-output string or split array.
        const input = createReadStream(log);
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) webContent.receive(line);
        } finally {
          lines.close();
          input.destroy();
        }
      }
    } catch (problem) {
      report(`The simulator's ${name} could not be kept or read: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }
  // INF-1936 / INF-2185: join the live reader before the snapshot, but a failed
  // diagnostic close must not hide that snapshot or replace the native failure.
  await keepPhoneDiagnostic("Simulator log", closeLive, report);
  await keepPhoneDiagnostic("WebContent startup evidence", async () => {
    const startup = webContent.report();
    report(startup);
    await writeFile(join(evidence, "webcontent-startup.log"), startup + "\n");
  }, report);
}
