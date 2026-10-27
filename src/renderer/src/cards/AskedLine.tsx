import type { CardAsked } from "@shared/cards";
import { useLayoutEffect, useRef, useState } from "react";
import { ASKED_SHOW_ALL, ASKED_SHOW_LESS, askedLabel, askedWords } from "./askedWords";

/** How many lines the folded message takes before it is cut. */
const FOLDED_LINES = 2;

/**
 * The "You asked" line under a card's title (INF-1610; design skill
 * ResponseCard, "The You asked line"): when the captain sent the message the
 * card is about, and their words, drawn from the saved message. A long
 * message shows its start, cut after two lines with an ellipsis, and a
 * Show all control opens the whole of it, paragraphs as they were written;
 * Show less folds it again. The control appears only when the words are cut.
 */
export function AskedLine({ asked }: { asked: CardAsked }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const words = useRef<HTMLSpanElement>(null);
  const text = askedWords(asked.text, open);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new words inside the same two lines resize nothing, so they are measured again
  useLayoutEffect(() => {
    const element = words.current;
    if (!element || open) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);

  return (
    <div data-card-asked="" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        ref={words}
        data-card-asked-words=""
        style={{
          fontSize: "var(--text-sm)",
          lineHeight: "var(--leading-body)",
          color: "var(--fg-2)",
          overflowWrap: "anywhere",
          ...(open
            ? { whiteSpace: "pre-wrap" }
            : {
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: FOLDED_LINES,
                overflow: "hidden",
              }),
        }}
      >
        <span
          data-card-asked-label=""
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            marginRight: "1ch",
          }}
        >
          {askedLabel(asked.at)}
        </span>
        {text}
      </span>
      {(cut || open) && (
        <button
          type="button"
          data-card-asked-toggle=""
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          style={{
            alignSelf: "flex-start",
            padding: 0,
            border: 0,
            background: "none",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--accent)",
            borderRadius: "var(--radius-s)",
          }}
        >
          {open ? ASKED_SHOW_LESS : ASKED_SHOW_ALL}
        </button>
      )}
    </div>
  );
}
