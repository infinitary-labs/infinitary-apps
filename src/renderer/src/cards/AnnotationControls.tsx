import {
  ANNOTATE,
  type CardNote,
  EDIT_UNAVAILABLE,
  EMPTY_NOTE,
  NOT_SENT,
  NOTE_CANCEL,
  NOTE_COMMENT_LABEL,
  NOTE_EDIT,
  NOTE_REMOVE,
  noteLabel,
  POINT_AT,
  QUEUE_NOTE,
  STALE_NOTE,
  UNAVAILABLE_NOTE,
} from "@shared/cardNotes";
import { notePart } from "@shared/cardNoteTargets";
import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { Button, IconButton } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { type NoteReveal, revealNote } from "./annotationBridge";
import type { CollectAnswers } from "./PrototypeBody";
import { cardBodyHtml } from "./prototypeSrcdoc";
import { useAnnotationHome } from "./useAnnotationHome";
import "./annotations.css";

export const NO_NOTES: CardNote[] = [];
export function sameNote(a: CardNote, b: CardNote): boolean {
  return (
    a.key === b.key && a.start === b.start && JSON.stringify(a.span) === JSON.stringify(b.span)
  );
}

export function AnnotationControls({
  cardId,
  collect,
}: {
  cardId: string;
  collect?: CollectAnswers;
}) {
  const supported = useAnnotationHome();
  const mode = useShellStore((s) => s.pointAtCard === cardId);
  const pick = useShellStore((s) =>
    s.annotationPick?.cardId === cardId ? s.annotationPick : null,
  );
  const sending = useShellStore((s) => s.sendingReplies[cardId]);
  const keys = useCommandKeys("cards.point-at");
  if (!supported) return null;
  return (
    <>
      <IconButton
        label={POINT_AT}
        size={34}
        disabled={sending}
        keys={keys.keys}
        data-card-point-at={cardId}
        aria-pressed={mode}
        aria-keyshortcuts={keys["aria-keyshortcuts"]}
        style={{ flexShrink: 0, ...(mode ? { background: "var(--accent-dim)" } : {}) }}
        tone={mode ? "accent" : "neutral"}
        onClick={() => useShellStore.setState({ pointAtCard: mode ? null : cardId })}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 4 7.07 17 2.51-7.39L21 11.07 4 4z" />
        </svg>
      </IconButton>
      {pick && (
        <AnnotationPopover
          key={`${pick.note.key}-${JSON.stringify(pick.note.span)}`}
          cardId={cardId}
          collect={collect}
        />
      )}
    </>
  );
}

/** Queued notes share the thread's existing scroller, not the reply field's space. */
export function QueuedNotes({ cardId }: { cardId: string }) {
  const [editFailure, setEditFailure] = useState<{ note: CardNote; result: NoteReveal }>();
  const notes = useShellStore((s) => s.replyNotes[cardId] ?? NO_NOTES);
  const sending = useShellStore((s) => s.sendingReplies[cardId]);
  return (
    <>
      {notes.map((note) => (
        <div className="inf-queued-note" key={JSON.stringify([note.key, note.start, note.span])}>
          <NoteAnchor cardId={cardId} note={note} />
          <span>{note.comment || EMPTY_NOTE}</span>
          {editFailure?.note === note && (
            <span role="status">
              {editFailure.result === "missing" ? STALE_NOTE : EDIT_UNAVAILABLE}
            </span>
          )}
          <div className="inf-annotation-actions">
            <span>{NOT_SENT}</span>
            <Button
              variant="ghost"
              disabled={sending}
              onClick={async () => {
                const result = await revealNote(cardId, note, true);
                setEditFailure(result === "revealed" ? undefined : { note, result });
              }}
            >
              {NOTE_EDIT}
            </Button>
            <Button
              variant="ghost"
              disabled={sending}
              onClick={() =>
                useShellStore.setState((s) => ({
                  replyNotes: {
                    ...s.replyNotes,
                    [cardId]: (s.replyNotes[cardId] ?? []).filter((n) => n !== note),
                  },
                }))
              }
            >
              {NOTE_REMOVE}
            </Button>
          </div>
        </div>
      ))}
    </>
  );
}

export function NoteAnchor({ cardId, note }: { cardId: string; note: CardNote }) {
  const [result, setResult] = useState<NoteReveal>();
  const body = useShellStore((s) => s.cards.find((card) => card.id === cardId)?.body);
  const missing = useMemo(
    () => body !== undefined && notePart(cardBodyHtml(body), note) === undefined,
    [body, note],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a revised body invalidates its previous reveal failure
  useLayoutEffect(() => setResult(undefined), [body]);
  const stale = missing || result === "missing";
  return (
    <div className="inf-note-anchor">
      <button type="button" onClick={async () => setResult(await revealNote(cardId, note))}>
        {noteLabel(note)}
      </button>
      {stale ? (
        <span role="status">{STALE_NOTE}</span>
      ) : result === "unavailable" ? (
        <span role="status">{UNAVAILABLE_NOTE}</span>
      ) : null}
    </div>
  );
}

function AnnotationPopover({ cardId, collect }: { cardId: string; collect?: CollectAnswers }) {
  const pick = useShellStore((s) => s.annotationPick);
  const field = useRef<HTMLTextAreaElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState(false);
  const [height, setHeight] = useState(240);
  const [writing, setWriting] = useState(pick?.focusComment !== false);
  useLayoutEffect(() => {
    if (pick?.focusComment !== false) {
      field.current?.focus();
      setWriting(true);
    }
    if (pop.current) setHeight(pop.current.getBoundingClientRect().height);
  }, [pick?.focusComment]);
  if (!pick || pick.cardId !== cardId) return null;
  const cancel = () => {
    useShellStore.setState({ annotationPick: null });
    document
      .querySelector<HTMLButtonElement>(`[data-card-point-at="${CSS.escape(cardId)}"]`)
      ?.focus();
  };
  const queue = (send: boolean) => {
    if (useShellStore.getState().sendingReplies[cardId]) return;
    const { note } = pick;
    useShellStore.setState((s) => ({
      replyNotes: {
        ...s.replyNotes,
        [cardId]: [...(s.replyNotes[cardId] ?? []).filter((n) => !sameNote(n, note)), note],
      },
      annotationPick: null,
    }));
    if (send) void useShellStore.getState().sendReply(cardId, collect);
    else
      document
        .querySelector<HTMLButtonElement>(`[data-card-point-at="${CSS.escape(cardId)}"]`)
        ?.focus();
  };
  const sendKey = thisDesktop().mac ? "⌘Enter" : "Ctrl+Enter";
  const left = Math.max(8, Math.min(pick.box.left, innerWidth - 328));
  const top = Math.max(8, Math.min(pick.box.bottom + 8, innerHeight - height - 8));
  return createPortal(
    <div
      ref={pop}
      className="inf-annotation-popover"
      role="dialog"
      aria-label={`${ANNOTATE} ${pick.note.kind}`}
      onFocusCapture={() => setWriting(true)}
      style={{ left, top }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          queue(event.metaKey || event.ctrlKey);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!pick.note.comment) cancel();
          else setHint(true);
        }
        if (event.key === "Tab") {
          const controls = pop.current?.querySelectorAll<HTMLElement>("textarea,button");
          const first = controls?.[0],
            last = controls?.[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <strong>
        {ANNOTATE} {pick.note.kind}
      </strong>
      <blockquote>{pick.note.excerpt}</blockquote>
      <textarea
        ref={field}
        rows={3}
        aria-label={NOTE_COMMENT_LABEL}
        placeholder="Add a comment, or queue as-is"
        maxLength={CARD_REPLY_MAX_CHARS}
        value={pick.note.comment}
        onChange={(event) => {
          setHint(false);
          useShellStore.setState({
            annotationPick: { ...pick, note: { ...pick.note, comment: event.target.value } },
          });
        }}
      />
      <p className="inf-annotation-hint" role="status">
        {!writing
          ? "Copy the selected words, or press Tab to add a comment."
          : hint
            ? "Cancel discards your comment. Queue keeps it."
            : `Enter queues · ${sendKey} queues and sends · Esc closes when empty`}
      </p>
      <div className="inf-annotation-actions">
        <Button variant="ghost" onClick={cancel}>
          {NOTE_CANCEL}
        </Button>
        <Button onClick={() => queue(false)}>{QUEUE_NOTE}</Button>
      </div>
    </div>,
    document.body,
  );
}
