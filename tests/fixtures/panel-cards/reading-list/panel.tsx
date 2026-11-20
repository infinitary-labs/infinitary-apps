import type { PanelProps } from "@firstmate/contracts";
import { Button, Input, MicroLabel, Row } from "@firstmate/ui";
import { useEffect, useState } from "react";
import { notesId, PIECES } from "./pieces";

/**
 * The panel-cards fixture (tests/e2e/panel-cards.spec.ts): a list whose
 * rows put a card of notes up on the stack, a search its header button
 * presses into it, a card it raises on its own when its store says so, and
 * what it holds said in its header while it is collapsed.
 */
export default function Panel({ id, cards, asks, store, rail }: PanelProps) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState(0);
  // Collapsed, its header says what it holds.
  useEffect(() => rail?.summarize([{ text: `${PIECES.length} left` }]), [rail]);
  useEffect(
    () =>
      asks.subscribe((button) => {
        if (button === "search") setAsked((n) => n + 1);
      }),
    [asks],
  );
  // Raised on its own, from no click of the captain's: it waits behind.
  useEffect(
    () =>
      store.subscribe((key) => {
        if (key !== "raise") return;
        void store.get("raise").then((piece) => {
          if (typeof piece !== "string") return;
          void cards.emit({
            id: notesId(piece),
            view: "notes",
            title: `Notes on ${piece}`,
            data: { piece },
          });
        });
      }),
    [store, cards],
  );
  const shown = PIECES.filter((piece) => piece.toLowerCase().includes(query.toLowerCase()));
  return (
    <div data-fixture={id}>
      {asked > 0 && (
        <Input
          key={asked}
          autoFocus
          aria-label="Search the list"
          data-fixture-search=""
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      )}
      <MicroLabel count={shown.length}>To read</MicroLabel>
      {shown.map((piece) => (
        <div key={piece} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Row title={piece} tone="idle" />
          </div>
          <Button
            size="sm"
            variant="ghost"
            data-fixture-notes-for={piece}
            onClick={() =>
              void cards.emit({
                id: notesId(piece),
                view: "notes",
                title: `Notes on ${piece}`,
                data: { piece },
              })
            }
          >
            Notes
          </Button>
        </div>
      ))}
    </div>
  );
}
