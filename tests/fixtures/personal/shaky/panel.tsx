import type { PanelProps } from "@firstmate/contracts";
import { useEffect, useState } from "react";

/**
 * The boundary fixture: draws until its `explode` key is set, then throws
 * on render. The spec expects the quiet line, the chrome staying, and a
 * recovery when the file on disk is rewritten (the hot reload).
 */
export default function Panel({ id, store, theme }: PanelProps) {
  const [explode, setExplode] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      store.get("explode").then((value) => {
        if (live) setExplode(value === true);
      });
    void read();
    const off = store.subscribe(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [store]);
  if (explode) throw new Error("shaky panel asked to fail");
  return (
    <p data-fixture={id} data-fixture-theme={theme} style={{ margin: 0 }}>
      steady as she goes
    </p>
  );
}
