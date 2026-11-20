import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { UPDATE_RETURN_MS } from "@shared/work";
import { z } from "zod";
import { writePrivate } from "../devices/identity";
import { hostEnv } from "../hostEnv";
import type { BackgroundContext, Service } from "./background";

/**
 * A copy that does not start (docs/helper.md, "A copy that does not start").
 * An update over the connection keeps the copy it replaces beside the new
 * one (`<app>.previous`) and writes a trial (`app/trial.json`). The new
 * copy's run ends the trial the first time it reaches the home: the
 * previous copy goes. Should it not reach the home within the update's
 * wait (`UPDATE_RETURN_MS`) - it exits at start, or starts and never
 * connects - a watcher the old run left behind puts the previous copy back
 * at the same path, keeps what failed (`app/went-back.json`) and has the
 * service manager start the background again, now from the previous copy.
 * That run's hello tells the home that the copy it sent did not start here,
 * once: the home names its own version, the one it sent.
 *
 * Whoever renames the trial file first decides: the new run to keep its
 * copy, or the watcher to go back. A rename is one step, so the two never
 * both act.
 */

const TRIAL_FILE = "trial.json";
const WENT_BACK_FILE = "went-back.json";
const PREVIOUS = ".previous";

const trialSchema = z.strictObject({
  version: z.literal(1),
  /** The copy the background starts: the new one while the trial lasts. */
  app: z.string().min(1),
  /** The copy it replaced, kept until the new one reached the home. */
  previous: z.string().min(1),
});
type Trial = z.infer<typeof trialSchema>;

/** Where a copy kept for a trial keeps the one it replaced. */
export function previousOf(app: string): string {
  return `${app}${PREVIOUS}`;
}

function trialPath(dataDir: string): string {
  return join(dataDir, "app", TRIAL_FILE);
}

function wentBackPath(dataDir: string): string {
  return join(dataDir, "app", WENT_BACK_FILE);
}

/** Writes the trial for a copy just kept at `app`, with the one it replaced beside it. */
export function beginTrial(dataDir: string, app: string): void {
  const trial: Trial = { version: 1, app, previous: previousOf(app) };
  writePrivate(trialPath(dataDir), `${JSON.stringify(trial, null, 2)}\n`);
}

/**
 * The new copy reached the home: the trial ends, and the copy it replaced
 * goes, with any earlier note of a version that did not start. Answers
 * whether a trial ended here; false when none was open, or the watcher went
 * back first.
 */
export function endTrial(dataDir: string): boolean {
  const path = trialPath(dataDir);
  if (!existsSync(path)) return false;
  let trial: Trial | null = null;
  try {
    trial = trialSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    trial = null;
  }
  const ending = `${path}.ending`;
  try {
    renameSync(path, ending);
  } catch {
    // The watcher took it first: it goes back.
    return false;
  }
  if (trial) rmSync(trial.previous, { recursive: true, force: true });
  rmSync(ending, { force: true });
  rmSync(wentBackPath(dataDir), { force: true });
  return true;
}

/**
 * Whether a watcher went back here from a copy the home sent, which the next
 * hello says until the home has heard it (`forgetWentBack`).
 */
export function readWentBack(dataDir: string): boolean {
  return existsSync(wentBackPath(dataDir));
}

/** The home heard that the copy it sent did not start here: it is not said again. */
export function forgetWentBack(dataDir: string): void {
  rmSync(wentBackPath(dataDir), { force: true });
}

/**
 * The watcher, in the system's own shell so it needs nothing of the copy it
 * watches: it waits while the trial is open, up to its seconds; a trial
 * still open then is taken (one rename), the new copy is set aside and the
 * previous one put back at its path, the trial is kept as what went back,
 * and the service manager's own restart command runs last.
 */
const WATCHER = [
  'trial="$1"; app="$2"; previous="$3"; back="$4"; seconds="$5"; shift 5',
  "i=0",
  'while [ -e "$trial" ] && [ "$i" -lt "$seconds" ]; do sleep 1; i=$((i+1)); done',
  'mv "$trial" "$trial.going" 2>/dev/null || exit 0',
  'if [ ! -e "$previous" ]; then rm -f "$trial.going"; exit 0; fi',
  'rm -rf "$app.failed"',
  'if [ -e "$app" ]; then mv "$app" "$app.failed" || exit 1; fi',
  'mv "$previous" "$app" || { mv "$app.failed" "$app"; rm -f "$trial.going"; exit 1; }',
  'mv "$trial.going" "$back"',
  'rm -rf "$app.failed"',
  '"$@"',
].join("\n");

/**
 * How this computer's service manager starts the background again from
 * outside its run, and how a process outlives that run: none when it cannot
 * be asked from a program of its own, and then no trial is kept.
 *
 * On a Mac a shell in a session of its own outlives the agent's run, as
 * `reloadInBackground`'s does, and `launchctl kickstart -k` starts the
 * agent again. On Linux the service's own stop takes every process it
 * started with it, so the watcher runs as a transient service of the
 * user's own systemd (`systemd-run`), and `systemctl --user restart` starts
 * the service again.
 */
export type TrialWatch = { wrap: readonly string[]; restart: readonly string[] };

export function trialWatchOf(context: BackgroundContext, service: Service): TrialWatch | null {
  if ("launchctl" in context) {
    const program = context.launchctl.program;
    if (!program) return null;
    return {
      wrap: [],
      restart: [program, "kickstart", "-k", `gui/${context.uid}/${service.label}`],
    };
  }
  // A Windows PC gets a newer Infinitary only by an install there, with no trial here.
  if ("schtasks" in context) return null;
  const program = context.systemctl.program;
  if (!program) return null;
  // The system's own systemd-run sits beside its systemctl; a stand-in
  // systemctl with none beside it keeps no trial.
  const run = join(dirname(program), "systemd-run");
  if (!existsSync(run)) return null;
  return {
    wrap: [run, "--user", "--collect", "--quiet", "--"],
    restart: [program, "--user", "restart", service.label],
  };
}

/**
 * Leaves the watcher running once the run let the folder go: what an update
 * that kept a trial does last. The watcher itself is never waited for; a
 * wrapped one (`systemd-run`) is waited for until its transient service
 * started, since the run's own service stop takes the wrapper with it.
 */
export async function watchTrial(
  dataDir: string,
  watch: TrialWatch,
  options: { seconds?: number } = {},
): Promise<void> {
  const path = trialPath(dataDir);
  let trial: Trial;
  try {
    trial = trialSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return;
  }
  const seconds = options.seconds ?? Math.ceil(UPDATE_RETURN_MS / 1000);
  const args = [
    "/bin/sh",
    "-c",
    WATCHER,
    "infinitary-update-watch",
    path,
    trial.app,
    trial.previous,
    wentBackPath(dataDir),
    String(seconds),
    ...watch.restart,
  ];
  const [program, ...rest] = [...watch.wrap, ...args] as [string, ...string[]];
  const child = spawn(program, rest, { detached: true, stdio: "ignore", env: hostEnv() });
  if (watch.wrap.length === 0) {
    child.unref();
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}
