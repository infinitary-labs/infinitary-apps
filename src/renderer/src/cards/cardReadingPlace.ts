import { useCallback } from "react";

/** In-session reading places, like answer and reply drafts; never saved across a restart. */
const places = new Map<string, number>();

/** A remounted card waits for its body to draw before restoring the saved reading place. */
export function useCardReadingPlace(id: string) {
  return useCallback(
    (body: HTMLDivElement | null) => {
      if (!body) return;
      const top = places.get(id) ?? 0;
      let restored = top === 0;
      const restore = () => {
        if (restored) return;
        body.scrollTop = top;
        if (body.scrollTop >= top - 1) restored = true;
      };
      const keep = () => {
        if (restored) places.set(id, body.scrollTop);
      };
      // A person who scrolls before the saved place is reachable keeps the place they chose.
      const taken = () => {
        restored = true;
      };
      const resize = new ResizeObserver(restore);
      resize.observe(body);
      const changes = new MutationObserver(restore);
      changes.observe(body, { childList: true, subtree: true, attributes: true });
      body.addEventListener("scroll", keep, { passive: true });
      body.addEventListener("wheel", taken, { passive: true });
      body.addEventListener("touchmove", taken, { passive: true });
      body.addEventListener("keydown", taken);
      restore();
      return () => {
        keep();
        resize.disconnect();
        changes.disconnect();
        body.removeEventListener("scroll", keep);
        body.removeEventListener("wheel", taken);
        body.removeEventListener("touchmove", taken);
        body.removeEventListener("keydown", taken);
      };
    },
    [id],
  );
}

/** A place saved under a namespace is for an entry that is not a live stack card. */
const OWN_PLACE = /^(record|past):/;

/** A task record's reading place; the stack never retires it. */
export const recordReadingPlaceId = (taskId: string) => `record:${taskId}`;

/** A past card's reading place; the stack never retires it. */
export const pastReadingPlaceId = (cardId: string) => `past:${cardId}`;

/** The record sections the captain left open, per task, for this session only. */
export const recordOpenSections = new Map<string, string[]>();

/** Closing a record or past card ends its visit: reopening starts at the top and compact. */
export function forgetReadingPlace(id: string): void {
  places.delete(id);
  if (id.startsWith("record:")) recordOpenSections.delete(id.slice("record:".length));
}

/** Retire reading places only when their open cards leave the saved stack. */
export function retainCardReadingPlaces(ids: ReadonlySet<string>): void {
  for (const id of places.keys()) if (!OWN_PLACE.test(id) && !ids.has(id)) places.delete(id);
}
