import * as m from "@shared/i18n/messages.generated";
import { useLayoutEffect, useRef, useState } from "react";
import { askedWords } from "./askedWords";

/** How many lines a folded question shows. */
const FOLDED_LINES = 2;

/**
 * The captain's question, without its caller's label or time. The caller keeps
 * expansion state; this component owns measurement and activation. A cut bubble
 * is its own button (click, Enter or Space), never a separate Show all link.
 * INF-1963: "remove the 'show all' link and instead make the bubble expand on click".
 */
export function QuestionBubble({
  text,
  open,
  onOpenChange,
}: {
  text: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [cut, setCut] = useState(false);
  const words = useRef<HTMLSpanElement>(null);
  const shown = askedWords(text, open);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new words in the same two lines resize nothing, so measure again
  useLayoutEffect(() => {
    const element = words.current;
    if (!element || open) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, shown]);

  const interactive = cut || open;
  return (
    <button
      type="button"
      data-question-bubble=""
      disabled={!interactive}
      aria-expanded={interactive ? open : undefined}
      aria-label={interactive ? (open ? m.cardAskedShowLess() : m.cardAskedShowAll()) : undefined}
      onClick={() => onOpenChange(!open)}
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: "3px 10px",
        border: 0,
        borderRadius: "4px 11px 11px 11px",
        background: "color-mix(in srgb, var(--fg-1) 8%, transparent)",
        textAlign: "start",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      <span
        ref={words}
        data-question-bubble-words=""
        style={{
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-sm)",
          fontWeight: 400,
          lineHeight: "var(--leading-body)",
          color: "var(--fg-2)",
          overflowWrap: "anywhere",
          ...(open
            ? { display: "block", whiteSpace: "pre-wrap" }
            : {
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: FOLDED_LINES,
                overflow: "hidden",
              }),
        }}
      >
        {shown}
      </span>
    </button>
  );
}
