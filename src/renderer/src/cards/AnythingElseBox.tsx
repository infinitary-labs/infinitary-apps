import { ANYTHING_ELSE_HINT, ANYTHING_ELSE_LABEL, ANYTHING_ELSE_MAX_CHARS } from "@shared/cards";
import { useId, useState } from "react";
import { useShellStore } from "../app/store";
import { ComposerCount, ComposerCountAnnouncer } from "../design/core/ComposerField";

/** The field grows one line at a time to this many, then scrolls, as a reply does. */
const LINE_CAP = 5;

/**
 * The app's own Anything else? box (INF-680), pinned between a decision's
 * body and its buttons: words the captain writes before he clicks one.
 * Typing sends nothing and Enter adds a line; whichever footer button he
 * clicks carries the words as the answer named `anything_else`
 * (`withAnythingElse`), and a reply carries them as context. A past card
 * passes `sent` and shows what went, read-only.
 */
export function AnythingElseBox({ cardId, sent }: { cardId: string; sent?: string }) {
  const id = useId();
  const draft = useShellStore((s) => s.cardComments[cardId] ?? "");
  const setCardComment = useShellStore((s) => s.setCardComment);
  const [focus, setFocus] = useState(false);
  const words = sent ?? draft;
  return (
    <div
      data-card-comment={cardId}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <label
          htmlFor={id}
          style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
        >
          {ANYTHING_ELSE_LABEL}
        </label>
        {sent === undefined && (
          <ComposerCount length={draft.length} max={ANYTHING_ELSE_MAX_CHARS} />
        )}
      </div>
      <textarea
        id={id}
        value={words}
        readOnly={sent !== undefined}
        placeholder={ANYTHING_ELSE_HINT}
        maxLength={ANYTHING_ELSE_MAX_CHARS}
        rows={1}
        onChange={(event) => setCardComment(cardId, event.target.value)}
        onKeyDown={(event) => {
          // The card's own input, as the reply's is: neither Escape nor
          // Enter reaches the window's hold-to-talk listeners. ⌘1 to ⌘4
          // are the window's and still press the buttons.
          event.stopPropagation();
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          display: "block",
          boxSizing: "border-box",
          width: "100%",
          minHeight: 0,
          maxHeight: `calc(${LINE_CAP}lh + 2 * var(--space-1) + 2px)`,
          padding: "var(--space-1) var(--space-3)",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-sm)",
          lineHeight: "var(--leading-body)",
          color: "var(--fg-1)",
          background: "var(--surface-input)",
          border: `1px solid ${focus ? "var(--line-2)" : "var(--line-1)"}`,
          borderRadius: "var(--radius-m)",
          boxShadow: focus ? "var(--focus-ring)" : "none",
          outline: "none",
          resize: "none",
          fieldSizing: "content",
          transition:
            "border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)",
        }}
      />
      {sent === undefined && (
        <ComposerCountAnnouncer length={draft.length} max={ANYTHING_ELSE_MAX_CHARS} />
      )}
    </div>
  );
}
