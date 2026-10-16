import type { PanelProps } from "@firstmate/contracts";
import { Input } from "@firstmate/ui";
import { useState } from "react";

/** One piece's notes; an Escape its field uses to clear itself keeps the card. */
export default function Notes({ card }: PanelProps) {
  const piece = (card?.data as { piece?: string } | null)?.piece ?? "";
  const [draft, setDraft] = useState("");
  return (
    <div data-fixture-notes={piece}>
      <p style={{ margin: "0 0 var(--space-2)", color: "var(--fg-1)" }}>{piece}</p>
      <Input
        aria-label="Note"
        data-fixture-note=""
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && draft !== "") {
            event.preventDefault();
            setDraft("");
          }
        }}
      />
    </div>
  );
}
