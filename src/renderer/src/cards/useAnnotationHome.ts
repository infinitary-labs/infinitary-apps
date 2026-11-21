import { hasSince16 } from "@shared/contractFeatures";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";

/** Notes need their home's additive reply field; do not silently drop them on an older home. */
export function useAnnotationHome(): boolean {
  const view = useShellStore((s) => s.thisMac?.role === "view");
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!view) return;
    let live = true;
    void window.infinitary.app
      .healthcheck()
      .then((home) => {
        // Major 16 folded typed notes in; a home on major 15 has them by their name.
        if (live) setAvailable(hasSince16(home.protocolVersion, home.changes, "card-annotations"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view]);
  return !view || available;
}

/**
 * A note's place and a note on a running page need a home that reads them (`card-note-places.md`):
 * a view of an older home offers neither, since that home would drop the place and send the rest.
 */
export function usePlacesHome(): boolean {
  const view = useShellStore((s) => s.thisMac?.role === "view");
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!view) return;
    let live = true;
    void window.infinitary.app
      .healthcheck()
      .then((home) => {
        if (live) setAvailable(home.changes?.includes("card-note-places") ?? false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view]);
  return !view || available;
}
