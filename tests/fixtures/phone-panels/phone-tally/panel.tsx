import type { PanelProps, PanelSettings, PanelTaskBoard, StoreValue } from "@infinitary/contracts";
import { Badge, Button } from "@infinitary/ui";
import { useEffect, useState } from "react";

/**
 * The phone's panel fixture (ios/Infinitary/InfinitaryUITests/PhoneJourney+Panels.swift, INF-3830 pieces 2 and 3): a
 * panel built from the app's own parts that reads the computer's board, shows its own store's tally, adds one through
 * its background work on a press, and can end that work, so the phone shows its drawing, live data, a press and a stop.
 * Its title row has a button that puts up its note card and one that asks the panel itself, which it counts; its own
 * press puts up a note card and opens the seeded task. It shows whether the computer's music is on (`settings.current`),
 * so the phone shows a settings read arriving and following the computer.
 */
export default function Panel({ id, reads, store, invoke, cards, asks, point }: PanelProps) {
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  const [tally, setTally] = useState<StoreValue | undefined>(undefined);
  const [marked, setMarked] = useState(0);
  const [music, setMusic] = useState<PanelSettings<"ambient-music"> | null>(null);
  useEffect(() => reads.subscribe("tasks.board", setBoard), [reads]);
  useEffect(
    () => reads.subscribe("settings.current", { names: ["ambient-music"] }, setMusic),
    [reads],
  );
  useEffect(() => asks.subscribe((button) => button === "mark" && setMarked((n) => n + 1)), [asks]);
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
      <p style={{ margin: 0 }}>{`Marked ${marked}`}</p>
      <p style={{ margin: 0 }}>
        {music ? `Music ${music["ambient-music"].on ? "on" : "off"}` : "Reading music"}
      </p>
      <p style={{ margin: 0 }}>
        <Badge tone="accent" mono>
          {board ? `${board.tasks.length} tasks` : "reading tasks"}
        </Badge>
      </p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button onClick={() => void invoke("add")}>Add one</Button>
        <Button onClick={() => void invoke("quit")}>End work</Button>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          onClick={() =>
            void cards.emit({ view: "note", title: "Raised note", data: { from: "the panel" } })
          }
        >
          Raise a note
        </Button>
        <Button onClick={() => void point.openTask("phone-fixture")}>Open the task</Button>
      </div>
    </div>
  );
}
