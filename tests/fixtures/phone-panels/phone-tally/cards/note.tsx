import type { PanelProps, StoreValue } from "@infinitary/contracts";
import { Button, Input } from "@infinitary/ui";
import { useEffect, useState } from "react";

/**
 * The phone panel fixture's card (INF-3830 piece 3): put up on Home by the panel's title-row button or its own press,
 * it says who put it up and how many times, and opens the test home's seeded task's record from the captain's tap.
 * It also shows its panel's store's `noted`, read again as each change of the store lands, so the journey sees a
 * write on the computer reach the card while it shows, and holds a text box the journey types in with the keyboard up.
 */
export default function Note({ card, point, store }: PanelProps) {
  const from = (card?.data as { from?: string } | null)?.from ?? "nobody";
  const [noted, setNoted] = useState<StoreValue | undefined>(undefined);
  const [reply, setReply] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => void store.get("noted").then((value) => live && setNoted(value));
    read();
    const off = store.subscribe(() => read());
    return () => {
      live = false;
      off();
    };
  }, [store]);
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <p style={{ margin: 0 }}>{`Note from ${from}`}</p>
      <p style={{ margin: 0 }}>{`Put up ${card?.revision ?? 0} times`}</p>
      <p style={{ margin: 0 }}>{`Noted ${typeof noted === "number" ? noted : 0}`}</p>
      <Input
        aria-label="A reply to the note"
        value={reply}
        onChange={(event) => setReply(event.currentTarget.value)}
      />
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button onClick={() => void point.openRecord("phone-fixture")}>Open the record</Button>
      </div>
    </div>
  );
}
