/**
 * What GitHub's job service last heard from this job's runner, read inside the job
 * while it can still report (docs/alpha.md, "The update check").
 *
 * An alpha's update check passed every step and GitHub still ended its job as
 * "lost communication": the runner's once-a-minute lease renewals had stopped
 * reaching GitHub's job service, and the virtual Mac was deleted with the runner's
 * own diagnostics folder, so nothing showed why. The job's log and artifact uploads
 * still went through. This step reads the runner's renewal record from that folder,
 * takes a fresh reading of the guest's path to the job service through the system's
 * own TLS and trust (as the runner's client uses them), prints both and keeps them
 * as `runner-link.json` beside the job's evidence.
 *
 * It never fails the job: the readings are for the next diagnosis, and a missing
 * runner folder or tool is printed as such.
 *
 *   node scripts/runner-link-readings.ts [evidence-dir]   (default: $INSTALLER_EVIDENCE)
 */

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The runner's listener renews its job lease once a minute (actions/runner, JobDispatcher). */
export const RENEWAL_PERIOD_SECONDS = 60;

export type RunnerLogLine = { at: Date; level: string; source: string; message: string };

export type Renewal = {
  at: Date;
  /** The lease end the job service answered, as the runner wrote it. */
  validTill: string;
  /** How long after its once-a-minute turn the answer arrived: about how long the request took. */
  secondsAfterTurn: number;
};

export type RenewalRecord = {
  jobId: string | null;
  started: Date | null;
  renewals: Renewal[];
  /** The listener's own errors and warnings since this job started, one line each. */
  errors: RunnerLogLine[];
};

// `[2026-11-06 05:41:54Z INFO JobDispatcher] message`: the runner's trace header
// (actions/runner, HostTraceListener); an error's level is written `ERR ` with its pad.
const HEADER = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})Z (\S+)\s+([^\]]+)\] (.*)$/;
const START = /^Start renew job request \S+ for job ([0-9a-f-]{36})\.$/i;
const RENEWED = /^Successfully renew job ([0-9a-f-]{36}), job is valid till (.+)$/i;

/** The runner's trace lines; a continuation line (an exception's stack) has no header and is left out. */
export function parseRunnerLog(text: string): RunnerLogLine[] {
  const lines: RunnerLogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = HEADER.exec(raw);
    if (!match) continue;
    const [, day = "", time = "", level = "", source = "", message = ""] = match;
    lines.push({ at: new Date(`${day}T${time}Z`), level, source: source.trim(), message });
  }
  return lines;
}

/** The renewals and errors of the last job this listener started; a reused runner's log holds earlier jobs too. */
export function readRenewals(text: string): RenewalRecord {
  const lines = parseRunnerLog(text);
  let start = -1;
  let jobId: string | null = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const found = START.exec(lines[index]?.message ?? "");
    if (found) {
      start = index;
      jobId = found[1] ?? null;
      break;
    }
  }
  const started = lines[start]?.at ?? null;
  if (start < 0 || !jobId || !started) return { jobId: null, started: null, renewals: [], errors: [] };
  const renewals: Renewal[] = [];
  const errors: RunnerLogLine[] = [];
  let previous = started;
  let turn = 0;
  for (const line of lines.slice(start + 1)) {
    const renewed = RENEWED.exec(line.message);
    if (renewed && renewed[1] === jobId) {
      // The first renewal is sent at once; each later one a period after the last answer.
      const due = previous.getTime() + (turn === 0 ? 0 : RENEWAL_PERIOD_SECONDS * 1000);
      renewals.push({
        at: line.at,
        validTill: renewed[2] ?? "",
        secondsAfterTurn: Math.max(0, Math.round((line.at.getTime() - due) / 1000)),
      });
      previous = line.at;
      turn++;
    } else if (line.level === "ERR" || line.level === "WARN") {
      errors.push(line);
    }
  }
  return { jobId, started, renewals, errors };
}

// The job service's names the runner wrote, and the results service as the
// comparison the job's own uploads go through.
const SERVICE_NAME =
  /https:\/\/((?:broker|run|run-actions-[a-z0-9-]+|results-receiver)\.actions\.githubusercontent\.com)/g;

export function serviceNames(...texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(SERVICE_NAME)) names.add(match[1] ?? "");
  names.delete("");
  for (const fallback of [
    "broker.actions.githubusercontent.com",
    "results-receiver.actions.githubusercontent.com",
  ])
    names.add(fallback);
  return [...names].sort();
}

type Ran = { code: number | string | null; stdout: string; stderr: string };

function run(file: string, args: string[], timeout = 30_000): Promise<Ran> {
  return new Promise((resolve) => {
    if (!existsSync(file)) {
      resolve({ code: "missing", stdout: "", stderr: `${file} is not on this computer` });
      return;
    }
    execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** This job's runner folder: the Runner.Worker this step descends from, or the folder above the job's temporary one. */
async function runnerRoot(): Promise<string | null> {
  let pid = process.ppid;
  for (let hops = 0; pid > 1 && hops < 16; hops++) {
    const ps = await run("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(ps.stdout);
    if (!match) break;
    const command = match[2] ?? "";
    if (basename(command) === "Runner.Worker") return dirname(dirname(command));
    pid = Number(match[1]);
  }
  const temp = process.env.RUNNER_TEMP;
  return temp && existsSync(join(temp, "..", "..", "_diag")) ? join(temp, "..", "..") : null;
}

function newest(folder: string, prefix: string): string | null {
  if (!existsSync(folder)) return null;
  const names = readdirSync(folder)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .sort();
  const last = names.at(-1);
  return last ? join(folder, last) : null;
}

type CurlReading = {
  http_code?: number;
  remote_ip?: string;
  time_namelookup?: number;
  time_connect?: number;
  time_appconnect?: number;
  time_total?: number;
  exitcode?: number;
  errormsg?: string | null;
};

type Probe = {
  name: string;
  addresses: string[];
  lookupError?: string;
  https?: CurlReading & { stderr?: string };
};

/** One address's route and every TCP socket to it with its state, the runner's among them. */
type AddressReading = { address: string; route: string; sockets: string };

async function probe(name: string): Promise<Probe> {
  const reading: Probe = { name, addresses: [] };
  try {
    reading.addresses = (await lookup(name, { all: true })).map((answer) => answer.address);
  } catch (error) {
    const failed = error as NodeJS.ErrnoException;
    reading.lookupError = failed.code ?? failed.message;
  }
  // macOS's own curl uses SecureTransport and the system trust, the TLS the runner's client uses.
  const curl = await run("/usr/bin/curl", [
    "-sS",
    "-o",
    "/dev/null",
    "--connect-timeout",
    "10",
    "--max-time",
    "20",
    "-w",
    "%{json}",
    `https://${name}/`,
  ]);
  try {
    reading.https = JSON.parse(curl.stdout) as CurlReading;
  } catch {
    reading.https = { exitcode: typeof curl.code === "number" ? curl.code : -1 };
  }
  if (curl.stderr.trim()) reading.https.stderr = curl.stderr.trim();
  return reading;
}

async function readAddress(address: string): Promise<AddressReading> {
  const route = await run("/sbin/route", ["-n", "get", address]);
  const sockets = await run("/usr/sbin/lsof", ["-nP", `-iTCP@${address}`]);
  return {
    address,
    route: (route.stdout || route.stderr).trim(),
    sockets: (sockets.stdout || sockets.stderr).trim() || "none",
  };
}

const clock = (at: Date) => `${at.toISOString().slice(11, 19)}Z`;
const seconds = (value: number | undefined) =>
  value === undefined ? "?" : `${Math.round(value * 100) / 100} s`;

function describeProbe(reading: Probe): string[] {
  const https = reading.https ?? {};
  const where = reading.lookupError
    ? `no address (${reading.lookupError})`
    : reading.addresses.join(", ");
  const answer =
    https.exitcode === 0
      ? `HTTPS ${https.http_code} in ${seconds(https.time_total)} (connect ${seconds(https.time_connect)}, TLS ${seconds(https.time_appconnect)})`
      : `HTTPS failed: ${https.errormsg || https.stderr || `exit ${https.exitcode}`}`;
  return [`  ${reading.name}: ${where}; ${answer}`];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main(): Promise<void> {
  const evidence = process.argv[2] || process.env.INSTALLER_EVIDENCE;
  const readAt = new Date();
  const notes: string[] = [];
  const warnings: string[] = [];
  const root = await runnerRoot();
  const diag = root ? join(root, "_diag") : null;
  const listenerLog = diag ? newest(diag, "Runner_") : null;
  const workerLog = diag ? newest(diag, "Worker_") : null;
  if (!listenerLog) notes.push("The runner's diagnostics folder was not found; no renewal record.");
  const readLog = (path: string | null) => (path ? readFileSync(path, "utf8") : "");

  const names = serviceNames(readLog(listenerLog), readLog(workerLog));
  const probes = Promise.all(names.map(probe));

  // A renewal older than one period is late: watch for the next one until a whole
  // turn has gone by without it, which is a missed renewal.
  let record = readRenewals(readLog(listenerLog));
  const lastAt = () => record.renewals.at(-1)?.at ?? record.started;
  const since = () => {
    const last = lastAt();
    return last ? Math.round((Date.now() - last.getTime()) / 1000) : null;
  };
  const firstSince = since();
  let watched = false;
  if (listenerLog && firstSince !== null && firstSince > RENEWAL_PERIOD_SECONDS) {
    watched = true;
    const before = record.renewals.length;
    while ((since() ?? 0) <= 2 * RENEWAL_PERIOD_SECONDS && record.renewals.length === before) {
      await sleep(2000);
      record = readRenewals(readLog(listenerLog));
    }
  }
  const finalSince = since();
  const missed = finalSince !== null && finalSince > 2 * RENEWAL_PERIOD_SECONDS;
  const readings = await probes;
  const addresses = new Set<string>();
  for (const reading of readings) {
    const address = reading.https?.remote_ip || reading.addresses.find((one) => isIPv4(one));
    if (address) addresses.add(address);
  }
  const routes = await Promise.all([...addresses].sort().map(readAddress));

  const lines = [`The runner's link to GitHub's job service, read ${clock(readAt)}:`];
  if (record.started) {
    lines.push(`  job ${record.jobId}, renewing since ${clock(record.started)}`);
    for (const renewal of record.renewals)
      lines.push(
        `  renewed ${clock(renewal.at)}, ${renewal.secondsAfterTurn} s after its turn; valid till ${renewal.validTill}`,
      );
    lines.push(
      `  last renewal ${firstSince} s before the reading${watched ? `; ${missed ? "no renewal came in the next turn" : "the next renewal came"} (${finalSince} s at the end)` : ""}`,
    );
    for (const error of record.errors)
      lines.push(`  listener ${error.level} ${clock(error.at)} ${error.source}: ${error.message}`);
  }
  for (const note of notes) lines.push(`  ${note}`);
  for (const reading of readings) lines.push(...describeProbe(reading));
  console.log(lines.join("\n"));
  for (const reading of routes) {
    console.log(`::group::Route and sockets to ${reading.address}`);
    console.log(`${reading.route}\n${reading.sockets}`);
    console.log("::endgroup::");
  }

  if (missed) warnings.push(`The runner has not renewed its job for ${finalSince} s.`);
  if (record.errors.length > 0)
    warnings.push(`The runner's listener wrote ${record.errors.length} errors during this job.`);
  for (const reading of readings)
    if (reading.https?.exitcode !== 0)
      warnings.push(`This Mac could not reach ${reading.name} over HTTPS.`);
  for (const warning of warnings) console.log(`::warning title=Runner link::${warning}`);

  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, "runner-link.json"),
      `${JSON.stringify(
        {
          readAt,
          runnerFolder: root,
          listenerLog: listenerLog && basename(listenerLog),
          ...record,
          secondsSinceRenewal: firstSince,
          watchedForNextRenewal: watched,
          missedRenewal: missed,
          probes: readings,
          addresses: routes,
          notes,
        },
        null,
        2,
      )}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Readings only: a failure here never fails the job it describes.
    console.log(`Could not read the runner's link: ${error instanceof Error ? error.stack : error}`);
  });
}
