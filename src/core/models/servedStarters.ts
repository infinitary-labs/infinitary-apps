import {
  putServedStarters,
  type SavedServedStarters,
  servedStartersSchema,
} from "@shared/modelSlots";
import { STARTERS_URL } from "../update/updateChannels";

/**
 * The served starter list (docs/model-lists.md, "The served starter list"):
 * a file beside the update feed that moves the starting levels for every
 * install without an app release (captain, INF-1904: "a starter list served
 * by us so defaults move for every install without a release").
 *
 * The last answer is kept in settings and put in force at start, so a start
 * with no network keeps it. The feed is asked again once a day. A 404 is the
 * feed's answer that it has no list, and the shipped map alone applies; a
 * failed request or a file that does not parse is no answer, so the last one
 * stays in force and the next pass asks again.
 */

/** How long one answer stands before the feed is asked again: a day. */
export const STARTERS_REFRESH_MS = 24 * 60 * 60 * 1000;

export type ServedStartersStore = {
  getServedStarters(): SavedServedStarters | null;
  setServedStarters(saved: SavedServedStarters): void;
};

export type ServedStartersOptions = {
  settings: ServedStartersStore;
  /** The served file; this build's own tap's by default. */
  url?: string;
  fetchImpl?: typeof fetch;
  now: () => number;
};

export type ServedStartersReader = {
  /** Asks the feed when the last answer is a day old, or never came. */
  refresh(): Promise<void>;
};

export function createServedStarters(options: ServedStartersOptions): ServedStartersReader {
  const url = options.url ?? STARTERS_URL;
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  putServedStarters(options.settings.getServedStarters()?.starters ?? null);
  let running: Promise<void> | null = null;

  const keep = (starters: SavedServedStarters["starters"]) => {
    options.settings.setServedStarters({ starters, checkedAt: options.now() });
    putServedStarters(starters);
  };

  const ask = async () => {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { "User-Agent": "infinitary" } });
    } catch {
      return;
    }
    if (response.status === 404) {
      keep(null);
      return;
    }
    if (!response.ok) return;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return;
    }
    const parsed = servedStartersSchema.safeParse(payload);
    if (parsed.success) keep(parsed.data.starters);
  };

  return {
    refresh() {
      const saved = options.settings.getServedStarters();
      if (saved && options.now() - saved.checkedAt < STARTERS_REFRESH_MS) return Promise.resolve();
      running ??= ask().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
