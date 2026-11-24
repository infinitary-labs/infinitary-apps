import {
  STAR_PROJECT,
  STAR_READ_EVERY_MS,
  starAskOf,
  starAskOpen,
} from "../../shared/releaseTracking";
import type { TrackingStore } from "../releaseTracking";

export type StarReadDeps = {
  store: TrackingStore;
  /** A github.com sign-in is on file and its health reads ok. */
  signedIn: () => boolean;
  /** A GET through the person's github.com sign-in; every status answers. */
  get: (path: string) => Promise<{ status: number }>;
  now: () => number;
};

export type StarReadOutcome = "starred" | "not-starred" | "kept" | "skipped";

/**
 * The release note's star ask (docs/release-notes.md "The star ask"): reads
 * whether the person's github.com sign-in has starred the project, keeping
 * the answer for the next note, which is built offline. It asks only GitHub,
 * at most once a day, never with no sign-in, and never after the ask has
 * closed. 204 is starred and 404 is not; any other answer or a failure keeps
 * the last one.
 */
export class StarRead {
  private reading: Promise<StarReadOutcome> | undefined;

  constructor(private readonly deps: StarReadDeps) {}

  read(): Promise<StarReadOutcome> {
    this.reading ??= this.once().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async once(): Promise<StarReadOutcome> {
    const { store, now } = this.deps;
    if (!this.deps.signedIn()) return "skipped";
    const ask = starAskOf(store.getReleaseTracking());
    if (!starAskOpen(ask)) return "skipped";
    if (ask.star && now() - ask.star.readAt < STAR_READ_EVERY_MS) return "skipped";
    let status: number;
    try {
      ({ status } = await this.deps.get(`/user/starred/${STAR_PROJECT}`));
    } catch (error) {
      console.warn("[release-notes] the star could not be read:", error);
      return "kept";
    }
    if (status !== 204 && status !== 404) return "kept";
    const starred = status === 204;
    // Read again: a note may have been delivered while GitHub answered.
    const tracking = store.getReleaseTracking();
    store.setReleaseTracking({
      ...tracking,
      starAsk: { ...starAskOf(tracking), star: { starred, readAt: now() } },
    });
    return starred ? "starred" : "not-starred";
  }
}
