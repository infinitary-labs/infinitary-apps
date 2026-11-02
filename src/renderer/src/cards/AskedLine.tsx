import type { CardAsked } from "@shared/cards";
import { useState } from "react";
import { askedLabel } from "./askedWords";
import { QuestionBubble } from "./QuestionBubble";

/** The saved question under a card's title, with its own label and time (INF-1610, INF-1963). */
export function AskedLine({ asked }: { asked: CardAsked }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-card-asked=""
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
    >
      <span
        data-card-asked-label=""
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-body)",
          color: "var(--fg-3)",
        }}
      >
        {askedLabel(asked.at)}
      </span>
      <QuestionBubble text={asked.text} open={open} onOpenChange={setOpen} />
    </div>
  );
}
