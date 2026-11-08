import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { sourceIdentitySchema } from "@shared/selfSource";
import { z } from "zod";
import { type FreezeIncident, type FreezeLine, freezeIncidentSchema } from "./freezeRecorder";

/**
 * The freeze recorder's per-version tally (docs/freeze-recorder.md, "The
 * per-version tally"; INF-3044's plan): every stall each installed version
 * had, across every run on this computer, beside the bounded record and
 * never cut short by it. Each stall counts toward the version in its own
 * build identity, so an unfinished stall recovered at the next start counts
 * for the version that had it. When the app first starts on a new version,
 * the earlier versions are taken out of the tally whole as their summaries.
 */

const locationSchema = z.object({
  /** The captured call path, innermost first; empty when none was captured. */
  frames: z.array(
    z.object({ name: z.string(), file: z.string(), line: z.number(), column: z.number() }),
  ),
  stalls: z.number().int().nonnegative(),
  stallMs: z.number().int().nonnegative(),
  cpuMs: z.number().int().nonnegative(),
  longestMs: z.number().int().nonnegative(),
  firstAt: z.string(),
  lastAt: z.string(),
  /** How many of its stalls carried each uncertain mark. */
  waited: z.number().int().nonnegative(),
  late: z.number().int().nonnegative(),
});
export type FreezeLocation = z.infer<typeof locationSchema>;

const versionSchema = z.object({
  version: z.string(),
  build: sourceIdentitySchema.optional(),
  /** Runs of this version the recorder started. */
  runs: z.number().int().nonnegative(),
  /** Time those runs were awake, on the monotonic clock, which a sleeping computer stops. */
  runningMs: z.number().nonnegative(),
  /** Completed stalls, their time between heartbeats and their main thread processor time. */
  stalls: z.number().int().nonnegative(),
  stallMs: z.number().int().nonnegative(),
  cpuMs: z.number().int().nonnegative(),
  /** Stalls that never finished: no duration, processor time or call path is known. */
  interrupted: z.number().int().nonnegative(),
  firstAt: z.string().optional(),
  lastAt: z.string().optional(),
  /** Every captured location, most time first when summarized. */
  locations: z.array(locationSchema),
  /** The longest completed stall, or the newest unfinished one when none completed. */
  example: freezeIncidentSchema.optional(),
});
export type VersionTally = z.infer<typeof versionSchema>;

/** One version's whole tally, its locations most time first, as the first mate hears it. */
export type VersionSummary = VersionTally & { example: FreezeIncident };

const fileSchema = z.object({ versions: z.array(versionSchema) });

function emptyVersion(version: string): VersionTally {
  return {
    version,
    runs: 0,
    runningMs: 0,
    stalls: 0,
    stallMs: 0,
    cpuMs: 0,
    interrupted: 0,
    locations: [],
  };
}

function seen(tally: { firstAt?: string; lastAt?: string }, at: string): void {
  if (!tally.firstAt || at < tally.firstAt) tally.firstAt = at;
  if (!tally.lastAt || at > tally.lastAt) tally.lastAt = at;
}

function addLocation(
  tally: VersionTally,
  line: FreezeLine,
  index: Map<string, FreezeLocation>,
): void {
  const key = `${tally.version}\n${JSON.stringify(line.frames)}`;
  let location = index.get(key);
  if (!location) {
    location = {
      frames: line.frames,
      stalls: 0,
      stallMs: 0,
      cpuMs: 0,
      longestMs: 0,
      firstAt: line.at,
      lastAt: line.at,
      waited: 0,
      late: 0,
    };
    tally.locations.push(location);
    index.set(key, location);
  }
  location.stalls += 1;
  location.stallMs += line.wallMs;
  location.cpuMs += line.cpuMs;
  location.longestMs = Math.max(location.longestMs, line.wallMs);
  seen(location, line.at);
  if (line.uncertain === "waited") location.waited += 1;
  if (line.uncertain === "late") location.late += 1;
}

/**
 * The tally, read from its file at `path` and written back whole by `flush`.
 * The main thread is its one writer; an unreadable file starts it empty.
 */
export class FreezeTally {
  private readonly versions = new Map<string, VersionTally>();
  /** Each version's locations by call path. */
  private readonly index = new Map<string, FreezeLocation>();
  private dirty = false;

  constructor(
    private readonly path: string,
    /** The installed version this run is. */
    private readonly current: string,
    private readonly build?: z.infer<typeof sourceIdentitySchema>,
  ) {
    try {
      const saved = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (saved.success)
        for (const one of saved.data.versions) {
          this.versions.set(one.version, one);
          for (const location of one.locations)
            this.index.set(`${one.version}\n${JSON.stringify(location.frames)}`, location);
        }
    } catch {}
  }

  private of(version: string): VersionTally {
    let tally = this.versions.get(version);
    if (!tally) {
      tally = emptyVersion(version);
      this.versions.set(version, tally);
    }
    this.dirty = true;
    return tally;
  }

  /** This run of the current version has started. */
  startRun(): void {
    const tally = this.of(this.current);
    tally.runs += 1;
    if (this.build && !tally.build) tally.build = this.build;
  }

  /** This run was awake `ms` longer. */
  ran(ms: number): void {
    if (ms > 0) this.of(this.current).runningMs += ms;
  }

  /** Counts one completed or recovered unfinished stall toward its own build's version. */
  add(line: FreezeIncident): void {
    const tally = this.of(line.build?.version ?? this.current);
    if (line.build && !tally.build) tally.build = line.build;
    if ("wallMs" in line) {
      tally.stalls += 1;
      tally.stallMs += line.wallMs;
      tally.cpuMs += line.cpuMs;
      seen(tally, line.at);
      addLocation(tally, line, this.index);
      const longest = tally.example && "wallMs" in tally.example ? tally.example : undefined;
      if (!longest || line.wallMs > longest.wallMs) tally.example = line;
    } else if (line.status === "interrupted") {
      tally.interrupted += 1;
      seen(tally, line.at);
      if (!tally.example || !("wallMs" in tally.example)) tally.example = line;
    }
  }

  /**
   * Takes every version but the current one out of the tally and answers
   * the ones that had a stall, each with its locations most time first.
   * Once taken, a version is never summarized again.
   */
  takeEarlier(): VersionSummary[] {
    const ended: VersionSummary[] = [];
    for (const [version, tally] of this.versions) {
      if (version === this.current) continue;
      this.versions.delete(version);
      for (const location of tally.locations)
        this.index.delete(`${version}\n${JSON.stringify(location.frames)}`);
      this.dirty = true;
      if (!tally.example) continue;
      ended.push({
        ...tally,
        example: tally.example,
        locations: [...tally.locations].sort((a, b) => b.stallMs - a.stallMs),
      });
    }
    this.flush();
    return ended;
  }

  /** Writes the tally whole, atomically, when it changed. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeFileSync(
        `${this.path}.next`,
        JSON.stringify({ versions: [...this.versions.values()] }),
        { mode: 0o600 },
      );
      renameSync(`${this.path}.next`, this.path);
    } catch {}
  }
}
