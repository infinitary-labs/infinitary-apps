import type { PanelProps } from "@infinitary/contracts";
import { Button } from "@infinitary/ui";

/**
 * The phone panel fixture's card (INF-3830 piece 3): put up on Home by the panel's title-row button or its own press,
 * it says who put it up and how many times, and opens the test home's seeded task's record from the captain's tap.
 */
export default function Note({ card, point }: PanelProps) {
  const from = (card?.data as { from?: string } | null)?.from ?? "nobody";
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <p style={{ margin: 0 }}>{`Note from ${from}`}</p>
      <p style={{ margin: 0 }}>{`Put up ${card?.revision ?? 0} times`}</p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button onClick={() => void point.openRecord("phone-fixture")}>Open the record</Button>
      </div>
    </div>
  );
}
