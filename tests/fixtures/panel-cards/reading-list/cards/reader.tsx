import type { PanelProps } from "@firstmate/contracts";
import { Button, MicroLabel } from "@firstmate/ui";
import { notesId, PIECES } from "../pieces";

/** The named card its header button and command put up; it puts up cards of its own. */
export default function Reader({ card, cards }: PanelProps) {
  const place = (card?.data as { place?: string } | null)?.place ?? "";
  const first = PIECES[0] ?? "";
  return (
    <div data-fixture-reader={place}>
      <MicroLabel count={PIECES.length}>Pieces to read</MicroLabel>
      <Button
        size="sm"
        data-fixture-reader-notes=""
        onClick={() =>
          void cards.emit({
            id: notesId(first),
            view: "notes",
            title: `Notes on ${first}`,
            data: { piece: first },
          })
        }
      >
        Open notes
      </Button>
    </div>
  );
}
