import type { PanelProps, PanelTaskBoard, StoreValue } from "@infinitary/contracts";
import { Badge, Button } from "@infinitary/ui";
import { useEffect, useState } from "react";

/**
 * The phone's panel fixture (ios/Infinitary/InfinitaryUITests/PhoneJourney+Panels.swift, INF-3830 piece 2): a panel
 * built from the app's own parts that reads the computer's board, shows its own store's tally, adds one through its
 * background work on a press, and can end that work, so the phone shows its drawing, live data, a press and a stop.
 */
export default function Panel({ id, reads, store, invoke }: PanelProps) {
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  const [tally, setTally] = useState<StoreValue | undefined>(undefined);
  useEffect(() => reads.subscribe("tasks.board", setBoard), [reads]);
  useEffect(() => {
    let live = true;
    const read = () => void store.get("tally").then((value) => live && setTally(value));
    read();
    const off = store.subscribe(() => read());
    return () => {
      live = false;
      off();
    };
  }, [store]);
  const count = typeof tally === "number" ? tally : 0;
  return (
    <div data-fixture={id} style={{ display: "grid", gap: "var(--space-2)" }}>
      <p style={{ margin: 0 }}>{`Tally ${count}`}</p>
      <p style={{ margin: 0 }}>
        <Badge tone="accent" mono>
          {board ? `${board.tasks.length} tasks` : "reading tasks"}
        </Badge>
      </p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button onClick={() => void invoke("add")}>Add one</Button>
        <Button onClick={() => void invoke("quit")}>End work</Button>
      </div>
    </div>
  );
}
