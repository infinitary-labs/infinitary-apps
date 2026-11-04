import type { CardAsked } from "@shared/cards";
import { useState } from "react";
import { askedInBubble, askedLabel, askedText } from "./askedWords";
import { QuestionBubble } from "./QuestionBubble";

/**
 * The line under a card's title saying where its work came from, with its
 * own label and time (INF-1610, INF-1963, INF-2326): the captain's words in
 * the grey bubble, or an automation's name or a task's title without it.
 */
export function AskedLine({ asked }: { asked: CardAsked }) {
  const [open, setOpen] = useState(false);
  const text = askedText(asked);
  return (
    <div
      data-card-asked={asked.kind ?? "asked"}
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
        {askedLabel(asked)}
      </span>
      {askedInBubble(asked) ? (
        <QuestionBubble text={text} open={open} onOpenChange={setOpen} />
      ) : text.trim() ? (
        <span
          data-card-asked-name=""
          style={{
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-body)",
            color: "var(--fg-2)",
          }}
        >
          {text}
        </span>
      ) : null}
    </div>
  );
}
