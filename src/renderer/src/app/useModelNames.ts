import { modelNames } from "@shared/modelDisplayName";
import type { SlotModelView } from "@shared/modelSlots";
import { useEffect, useMemo, useState } from "react";

/** The newest rows any surface read, so a surface that opens later names models at once. */
let lastRows: readonly SlotModelView[] = [];

/**
 * The one model-name lookup (`modelNames`, FI3-565 piece 2) over the rows
 * Settings → Models shows, listed and by name: a routed model need not be
 * one of the listed rows. Catalog refreshes follow the existing quota push.
 * The crew summary, the orbit's names and the task record all read it.
 */
export function useModelNames(): (model: string) => string {
  const [rows, setRows] = useState(lastRows);
  useEffect(() => {
    let live = true;
    let read = 0;
    const refresh = () => {
      const version = ++read;
      void window.infinitary.models.slots().then(
        (value) => {
          if (!live || version !== read) return;
          lastRows = [...value.models, ...value.byName];
          setRows(lastRows);
        },
        () => {},
      );
    };
    refresh();
    const offQuota = window.infinitary.quota.onSnapshot(refresh);
    return () => {
      live = false;
      offQuota();
    };
  }, []);
  return useMemo(() => modelNames(rows), [rows]);
}
