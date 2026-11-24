import {
  type ReleaseTrackingRecord,
  STAR_ASK_SPACING_MS,
  type StarAskRecord,
  starAskOf,
  starAskOpen,
} from "../../shared/releaseTracking";
import type { TrackingStore } from "../releaseTracking";

/**
 * The What's new note's ask to star the project (docs/release-notes.md "The
 * star ask"; the captain's choices on INF-6429): a panel after the
 * highlights, at most three times, 30 or more days apart, once the person's
 * crew has finished three tasks, and never again once their github.com
 * sign-in shows a star or they opened the page from a note. The app only
 * reads the star (`StarRead`, ../forge/starRead.ts), never adds one: GitHub's
 * rules forbid automated starring.
 */

export type StarAskFacts = {
  /** The note lists changes: not one saying nothing is new or the notes could not be read. */
  listsChanges: boolean;
  /** `firstRun.thirdCrewmateDoneAt`: the person's crew has finished three tasks. */
  thirdCrewmateDoneAt: number | undefined;
  /** A github.com sign-in is on file. */
  githubSignedIn: boolean;
  ask: StarAskRecord;
  now: number;
};

/**
 * Whether this note carries the ask. With a github.com sign-in on file and
 * no answer read yet, the note goes without it: the person may already have
 * starred the project, and the read comes after the note is built.
 */
export function starAskDue(facts: StarAskFacts): boolean {
  const { ask, now } = facts;
  if (!facts.listsChanges || facts.thirdCrewmateDoneAt === undefined) return false;
  if (!starAskOpen(ask)) return false;
  const last = ask.shownAt.at(-1);
  if (last !== undefined && now - last < STAR_ASK_SPACING_MS) return false;
  return !(facts.githubSignedIn && ask.star === null);
}

/** The record with one more show, stamped in the same write as the note's delivery. */
export function withStarAskShown(tracking: ReleaseTrackingRecord, at: number): StarAskRecord {
  const ask = starAskOf(tracking);
  return { ...ask, shownAt: [...ask.shownAt, at] };
}

/**
 * The person opened the project's page: later notes leave the ask out.
 * Only the first visit is kept.
 */
export function recordStarPageOpened(store: TrackingStore, now: number): void {
  const tracking = store.getReleaseTracking();
  const ask = starAskOf(tracking);
  if (ask.openedAt !== null) return;
  store.setReleaseTracking({ ...tracking, starAsk: { ...ask, openedAt: now } });
}
