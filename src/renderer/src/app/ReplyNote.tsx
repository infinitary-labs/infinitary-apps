import { useLayoutEffect, useState } from "react";
import { QuestionBubble } from "../cards/QuestionBubble";
import { ResponseCard } from "../design/cards/ResponseCard";
import { MateMark } from "./LastTurn";
import { CONVERSATION_HEADING } from "./lastTurnWords";
import type { ReplyNote } from "./stack";
import "./replyNote.css";

/** A read-only conversation round, held by the existing Note shell and stack. */
export function ReplyNoteCard({
  note,
  width,
  onDrawn,
}: {
  note: ReplyNote;
  width: number | string;
  onDrawn?: () => void;
}) {
  useLayoutEffect(() => {
    onDrawn?.();
  }, [onDrawn]);
  return (
    <ResponseCard
      kind="note"
      headExtra={<h3 className="reply-note-heading">{CONVERSATION_HEADING}</h3>}
      width={width}
      minHeight={120}
    >
      <ConversationMessages key={`${note.you}\0${note.words}`} note={note} />
    </ResponseCard>
  );
}

function ConversationMessages({ note }: { note: ReplyNote }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reply-note-messages">
      <div className="reply-note-question" data-reply-note-question="">
        <span className="reply-note-speaker">You</span>
        <QuestionBubble text={note.you} open={open} onOpenChange={setOpen} selectable />
      </div>
      <div className="reply-note-answer">
        <span className="reply-note-speaker reply-note-mate">
          <MateMark working={false} />
          First mate
        </span>
        <div
          data-reply-note=""
          data-state={note.problem ? "problem" : "reply"}
          className="reply-note-words"
          style={{ color: note.problem ? "var(--danger)" : "var(--fg-1)" }}
        >
          {note.words}
        </div>
      </div>
    </div>
  );
}
