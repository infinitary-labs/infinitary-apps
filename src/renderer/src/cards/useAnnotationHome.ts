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
        if (live) setAvailable(home.changes?.includes("card-annotations") === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view]);
  return !view || available;
}
