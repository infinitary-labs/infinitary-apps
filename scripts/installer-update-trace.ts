import { appendFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * What the installed-update proof can see of a native replacement from outside
 * the signed app, without changing the app (which would void reused signed
 * copies): whether the app and ShipIt are running, the installed version, and
 * the app's own update phase while its page still answers.
 */
export type InstallSample = {
  appRunning: boolean;
  shipItRunning: boolean;
  installedVersion: string | null;
  phase: string | null;
  problem: string | null;
};

/** The files Squirrel.Mac's ShipIt writes into its cache beside the staged update. */
export const SHIPIT_FILES = ["ShipIt_stderr.log", "ShipIt_stdout.log", "ShipItState.plist"];

/** ShipIt's cache for an app id under a (scratch) home. */
export function shipItCache(home: string, appId: string): string {
  return join(home, "Library/Caches", `${appId}.ShipIt`);
}

/**
 * Copy ShipIt's own logs and state into the evidence folder under a label, so a
 * stalled replacement shows whether ShipIt ran, what it verified and why it
 * stopped. Returns the evidence names it kept; a missing file is not an error.
 */
export function keepShipItLogs(
  home: string,
  appId: string,
  evidence: string,
  label: string,
): string[] {
  const cache = shipItCache(home, appId);
  mkdirSync(evidence, { recursive: true });
  const kept: string[] = [];
  for (const name of SHIPIT_FILES) {
    const from = join(cache, name);
    if (!existsSync(from)) continue;
    const to = `${label}-${name}`;
    copyFileSync(from, join(evidence, to));
    kept.push(to);
  }
  return kept;
}

/**
 * Samples a native replacement and appends each change of stage to
 * `install-stages.jsonl`, with the time it was first seen. Consecutive equal
 * samples are one stage, so the file reads as the replacement's timeline.
 */
export function installStageRecorder(
  evidence: string,
  label: string,
  now: () => Date = () => new Date(),
) {
  let last: string | undefined;
  return (sample: InstallSample): boolean => {
    const key = JSON.stringify(sample);
    if (key === last) return false;
    last = key;
    appendFileSync(
      join(evidence, "install-stages.jsonl"),
      `${JSON.stringify({ at: now().toISOString(), label, ...sample })}\n`,
    );
    return true;
  };
}
