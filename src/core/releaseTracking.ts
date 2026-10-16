import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseIdentity, ReleaseTrackingRecord } from "@shared/releaseTracking";
import { compareSemver, parseSemver } from "./update/semver";

/**
 * Durable version tracking (docs/release-notes.md "Version tracking"): the
 * app records which logical version last ran, so a later build can say what is
 * new since. This keeps the record and shows nothing; the startup note
 * (`releaseNotes/startup.ts`) uses it for every launch that writes no note.
 *
 * The baseline is the previous successfully reconciled launch. An installed
 * version that never opened is not recoverable from today's installer, and an
 * unreadable version is never recorded: nothing here invents a previous
 * version.
 */

export type TrackingStore = {
  getReleaseTracking(): ReleaseTrackingRecord;
  setReleaseTracking(record: ReleaseTrackingRecord): void;
};

export type LaunchOutcome =
  /** First known baseline; recorded silently. */
  | "seeded"
  /** Same logical version as the baseline: a restart, a reinstall or a channel switch. */
  | "unchanged"
  | "upgraded"
  /** A compatible downgrade: the lower version becomes the baseline. */
  | "downgraded"
  /** The running version is not a SemVer, so nothing was recorded. */
  | "unreadable";

/** The source commit a packaged build was made from, or null when it carries none. */
export function bundledSource(resourcesDir: string, version: string): string | null {
  try {
    const catalog = JSON.parse(readFileSync(join(resourcesDir, "release-notes.json"), "utf8")) as {
      release?: { version?: unknown; sourceCommit?: unknown };
    };
    const release = catalog.release;
    return release?.version === version && typeof release.sourceCommit === "string"
      ? release.sourceCommit
      : null;
  } catch {
    return null;
  }
}

/**
 * Records this launch. The previous identity is read before the new one is
 * written and returned through `previous`, so the step that later builds the
 * upgrade note reads the true boundary.
 */
export function recordLaunch(
  store: TrackingStore,
  running: { version: string; source: string | null },
  now: () => number,
): { outcome: LaunchOutcome; previous: ReleaseIdentity | null } {
  if (!parseSemver(running.version)) return { outcome: "unreadable", previous: null };
  const record = store.getReleaseTracking();
  const baseline = record.baseline;
  const identity: ReleaseIdentity = {
    version: running.version,
    source: running.source,
    recordedAt: now(),
  };
  if (baseline && parseSemver(baseline.version) && baseline.version === running.version)
    return { outcome: "unchanged", previous: baseline };
  const known = baseline && parseSemver(baseline.version) ? baseline : null;
  store.setReleaseTracking({ ...record, baseline: identity, previous: known });
  if (!known) return { outcome: "seeded", previous: null };
  return {
    outcome: (compareSemver(running.version, known.version) ?? 0) > 0 ? "upgraded" : "downgraded",
    previous: known,
  };
}
