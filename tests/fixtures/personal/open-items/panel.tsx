import type { PanelProps, StoreValue } from "@firstmate/contracts";
import { Badge } from "@firstmate/ui";
import { useEffect, useState } from "react";
import { asItems } from "./items";

/**
 * The presence fixture (tests/e2e/personal-panels.spec.ts): a panel built
 * from the app's own Badge, fed by its store slice, shown only while
 * `items` is non-empty (manifest.json). Its server fills and clears that
 * key, and runs a background task under the floor so the clamp is visible
 * in the snapshot.
 */
export default function Panel({ id, store, invoke }: PanelProps) {
  const [items, setItems] = useState<string[]>([]);
  const [sampled, setSampled] = useState<StoreValue | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () =>
      Promise.all([store.get("items"), store.get("sampled")]).then(([value, sample]) => {
        if (!live) return;
        setItems(asItems(value));
        setSampled(sample);
      });
    void read();
    const off = store.subscribe(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [store]);
  return (
    <div data-fixture={id}>
      <Badge tone="accent" mono>
        {items.length} open
      </Badge>
      <ul style={{ margin: "var(--space-2) 0 0", paddingLeft: "var(--space-4)" }}>
        {items.map((item) => (
          <li key={item} data-fixture-item={item}>
            {item}
          </li>
        ))}
      </ul>
      <p data-fixture-sampled={sampled === undefined ? "no" : "yes"} style={{ margin: 0 }}>
        {sampled === undefined ? "not sampled yet" : "sampled"}
      </p>
      <button type="button" data-fixture-clear onClick={() => void invoke("clear")}>
        Clear
      </button>
    </div>
  );
}
