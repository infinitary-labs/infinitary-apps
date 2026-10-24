import { useLayoutEffect } from "react";
import { ResponseCard } from "../design/cards/ResponseCard";
import { PICTURE_ONLY_WORDS } from "./LastTurn";
import { quoted } from "./lastTurnWords";
import type { ReplyNote } from "./store";

/**
 * The Firstmate's reply read whole (docs/composer.md "The reply note"): a
 * note the window holds at the front of the stack, as a past card is. Its
 * title is the captain's message in quotation marks, so the card reads as
 * the two lines above the input unfolded; its body is the reply as the
 * Firstmate wrote it, line breaks kept and nothing read as formatting. No
 * actions and no reply row: nothing is saved or sent, and × or Esc closes it.
 */
export function ReplyNoteCard({
  note,
  width,
  onClose,
  onDrawn,
}: {
  note: ReplyNote;
  width: number | string;
  onClose: () => void;
  onDrawn?: () => void;
}) {
  // Plain text: this one drawing is the whole entry.
  useLayoutEffect(() => {
    onDrawn?.();
  }, [onDrawn]);
  const said = note.you.trim();
  return (
    <ResponseCard
      kind="note"
      title={said ? quoted(said) : PICTURE_ONLY_WORDS}
      width={width}
      minHeight={120}
      onClose={onClose}
    >
      <div
        data-reply-note=""
        data-state={note.problem ? "problem" : "reply"}
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          userSelect: "text",
          color: note.problem ? "var(--danger)" : "var(--fg-1)",
          lineHeight: "var(--leading-body)",
        }}
      >
        {note.words}
      </div>
    </ResponseCard>
  );
}
