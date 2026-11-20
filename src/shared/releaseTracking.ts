import { z } from "zod";
import { isAlphaVersion } from "./semver";

/**
 * Which app version this profile last ran, and what it has been told about
 * releases (docs/release-notes.md "Version tracking"). Core-owned: the
 * renderer and the installer's channel marker are never the baseline.
 *
 * `profile` is decided once, by the migration that created the record:
 * `fresh` for a profile created after tracking existed, `legacy` for one that
 * already had saved work. It never changes here, so a fresh profile keeps its
 * classification while setup is pending.
 */
export const releaseIdentitySchema = z.object({
  /** The exact logical version, as `host.app.version` reports it. */
  version: z.string().min(1),
  /** The bundled catalog's source commit, or null when this build carries none. */
  source: z.string().min(1).nullable(),
  recordedAt: z.number(),
});
export type ReleaseIdentity = z.infer<typeof releaseIdentitySchema>;

/** One target release's delivery, kept so a restart or reinstall never reissues it. */
export const releaseDeliverySchema = z.object({
  /** The previous version this delivery's interval began at; null when unknown. */
  boundary: z.object({ version: z.string().nullable(), source: z.string().nullable() }),
  entryIds: z.array(z.string()),
  coverage: z.enum(["complete", "partial", "unavailable"]),
  cardId: z.string().nullable(),
  deliveredAt: z.number(),
});
export type ReleaseDelivery = z.infer<typeof releaseDeliverySchema>;

/** A stretch of history a catalog could not cover, kept until one can. */
export const unresolvedRangeSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
});
export type UnresolvedRange = z.infer<typeof unresolvedRangeSchema>;

export const releaseTrackingSchema = z.object({
  schema: z.literal(1),
  profile: z.enum(["fresh", "legacy"]),
  /** The last successfully reconciled launch; null until one is known. */
  baseline: releaseIdentitySchema.nullable(),
  /** The baseline the last recorded change replaced. */
  previous: releaseIdentitySchema.nullable(),
  /** Keyed by target version. */
  deliveries: z.record(z.string(), releaseDeliverySchema),
  unresolved: z.array(unresolvedRangeSchema),
});
export type ReleaseTrackingRecord = z.infer<typeof releaseTrackingSchema>;

/** A profile whose record is missing or unreadable: no known baseline, no history to invent. */
export const UNKNOWN_RELEASE_TRACKING: ReleaseTrackingRecord = {
  schema: 1,
  profile: "legacy",
  baseline: null,
  previous: null,
  deliveries: {},
  unresolved: [],
};

/**
 * "stable 0.1.27", "alpha 0.1.28-alpha.3": one name for each, in a sentence.
 * The core names each note by it, and Settings names the version running
 * by it before the notes are read.
 */
export function versionName(version: string): string {
  return `${isAlphaVersion(version) ? "alpha" : "stable"} ${version}`;
}

/**
 * A release note the app showed, as Settings lists it and What's new opens
 * it again (docs/release-notes.md "Reading a note again"): its card, read
 * as it was shown, never written again.
 */
export const shownReleaseNoteSchema = z.object({
  version: z.string(),
  /** The version as a sentence names it, with its channel: "stable 0.1.27", "alpha 0.1.28-alpha.3". */
  name: z.string(),
  cardId: z.string(),
  /** It listed changes; false for a note that said nothing was new or that the notes could not be read. */
  listed: z.boolean(),
  shownAt: z.number(),
});
export type ShownReleaseNote = z.infer<typeof shownReleaseNoteSchema>;

export const releaseNotesViewSchema = z.object({
  /** The version running now, and its name in a sentence. */
  version: z.string(),
  name: z.string(),
  /** Every note the app showed, newest first. */
  notes: z.array(shownReleaseNoteSchema),
});
export type ReleaseNotesView = z.infer<typeof releaseNotesViewSchema>;

/**
 * The note What's new opens: the one shown for `version` when named,
 * otherwise the newest that listed changes, so a note that only said
 * nothing was new never hides the last one that did; with none that
 * listed changes, the newest.
 */
export function releaseNoteToShow(
  notes: readonly ShownReleaseNote[],
  version?: string | null,
): ShownReleaseNote | undefined {
  if (version) return notes.find((note) => note.version === version);
  return notes.find((note) => note.listed) ?? notes[0];
}
