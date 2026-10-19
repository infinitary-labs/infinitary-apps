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
      const resize = new ResizeObserver(restore);
      resize.observe(body);
      const changes = new MutationObserver(restore);
      changes.observe(body, { childList: true, subtree: true, attributes: true });
      body.addEventListener("scroll", keep, { passive: true });
      restore();
      return () => {
        keep();
        resize.disconnect();
        changes.disconnect();
        body.removeEventListener("scroll", keep);
      };
    },
    [id],
  );
}

/** Retire reading places only when their open cards leave the saved stack. */
export function retainCardReadingPlaces(ids: ReadonlySet<string>): void {
  for (const id of places.keys()) if (!ids.has(id)) places.delete(id);
}
