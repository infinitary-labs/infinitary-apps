import { type CardNote, noteLabel } from "@shared/cardNotes";
import { notePart } from "@shared/cardNoteTargets";
import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import { limitBand } from "@shared/composer";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDictationField } from "../app/dictationField";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { VoiceNotice } from "../app/VoiceNotice";
import { Button, IconButton } from "../design";
import { ComposerCount } from "../design/core/ComposerField";
import { thisDesktop } from "../design/core/desktop";
import { DictationMark } from "../design/voice/VoiceInput";
import {
  focusPointAt,
  type NoteReveal,
  queueNote,
  removeNote,
  revealNote,
  sameNote,
  settleAnnotation,
} from "./annotationBridge";
import type { CollectAnswers } from "./PrototypeBody";
import { cardBodyHtml } from "./prototypeSrcdoc";
import { useAnnotationHome } from "./useAnnotationHome";
import "./annotations.css";

export const NO_NOTES: CardNote[] = [];

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
  const offer = useShellStore((s) =>
    s.annotationOffer?.cardId === cardId ? s.annotationOffer : null,
  );
  const sending = useShellStore((s) => s.sendingReplies[cardId]);
  const keys = useCommandKeys("cards.point-at");
  if (!supported) return null;
  return (
    <>
      {/* Centred on the reply field's last line (`--reply-line`), as the row's far end is. */}
      <span style={{ display: "flex", alignItems: "center", height: "var(--reply-line)" }}>
        <IconButton
          label={m.cardNotePointAt()}
          size={34}
          disabled={sending}
          keys={keys.keys}
          data-card-point-at={cardId}
          aria-pressed={mode}
          aria-keyshortcuts={keys["aria-keyshortcuts"]}
          data-key-command={keys["data-key-command"]}
          style={{ flexShrink: 0, ...(mode ? { background: "var(--accent-dim)" } : {}) }}
          tone={mode ? "accent" : "neutral"}
          onClick={() =>
            useShellStore.setState({ pointAtCard: mode ? null : cardId, annotationOffer: null })
          }
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
      </span>
      {offer && !pick && !sending && <AnnotateOffer cardId={cardId} />}
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
          <span>{note.comment || m.cardNoteEmpty()}</span>
          {editFailure?.note === note && (
            <span role="status">
              {editFailure.result === "missing" ? m.cardNoteStale() : m.cardNoteEditUnavailable()}
            </span>
          )}
          <div className="inf-annotation-actions">
            <span>{m.cardNoteNotSent()}</span>
            <Button
              variant="ghost"
              disabled={sending}
              onClick={async () => {
                const result = await revealNote(cardId, note, true);
                setEditFailure(result === "revealed" ? undefined : { note, result });
              }}
            >
              {m.cardNoteEdit()}
            </Button>
            <Button variant="ghost" disabled={sending} onClick={() => removeNote(cardId, note)}>
              {m.cardNoteRemove()}
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
        <span role="status">{m.cardNoteStale()}</span>
      ) : result === "unavailable" ? (
        <span role="status">{m.cardNoteUnavailable()}</span>
      ) : null}
    </div>
  );
}

/**
 * Selected words with Point at off (INF-3786): one small Annotate under them, drawn by the window
 * so the frame's selection and Copy stay as they are. Enter or Tab in the card presses it too.
 */
function AnnotateOffer({ cardId }: { cardId: string }) {
  const offer = useShellStore((s) => s.annotationOffer);
  const own = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (own.current?.contains(event.target as Node)) return;
      if (useShellStore.getState().annotationOffer?.cardId === cardId)
        useShellStore.setState({ annotationOffer: null });
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [cardId]);
  if (!offer || offer.cardId !== cardId) return null;
  const left = Math.max(8, Math.min(offer.box.left, innerWidth - 140));
  const below = offer.box.bottom + 6;
  const top = below + 36 > innerHeight ? Math.max(8, offer.box.top - 42) : below;
  // The solid holder keeps the card's next line from showing through the button's clear face.
  return createPortal(
    <div ref={own} className="inf-annotate-offer" style={{ left, top }}>
      <Button
        size="sm"
        variant="secondary"
        keys={ANNOTATE_KEY}
        onClick={() =>
          useShellStore.setState((s) =>
            s.annotationOffer ? { annotationPick: s.annotationOffer, annotationOffer: null } : {},
          )
        }
      >
        {m.cardNoteAnnotate()}
      </Button>
    </div>,
    document.body,
  );
}

/** The key Annotate shows: Enter (or Tab) in the card opens the editor on the selected words. */
const ANNOTATE_KEY = "⏎";

function AnnotationPopover({ cardId, collect }: { cardId: string; collect?: CollectAnswers }) {
  const pick = useShellStore((s) => s.annotationPick);
  const queued = useShellStore((s) =>
    pick ? (s.replyNotes[cardId] ?? NO_NOTES).some((n) => sameNote(n, pick.note)) : false,
  );
  const field = useRef<HTMLTextAreaElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState(false);
  // The dictation key writes into the comment while it has focus (docs/composer.md, "Voice").
  const dictation = useDictationField(
    field,
    () => useShellStore.getState().annotationPick?.note.comment ?? "",
    (comment) =>
      useShellStore.setState((s) =>
        s.annotationPick
          ? { annotationPick: { ...s.annotationPick, note: { ...s.annotationPick.note, comment } } }
          : {},
      ),
  );
  const [height, setHeight] = useState(240);
  useLayoutEffect(() => {
    field.current?.focus();
    if (pop.current) setHeight(pop.current.getBoundingClientRect().height);
  }, []);
  // A press outside closes the editor and keeps its words (INF-3786). A view over the
  // window, such as command search, holds the focus, so a press there leaves the note open.
  useEffect(() => {
    const press = (event: PointerEvent) => {
      const own = pop.current;
      if (!own || own.contains(event.target as Node) || !own.contains(document.activeElement))
        return;
      settleAnnotation();
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) focusPointAt(cardId);
      });
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [cardId]);
  if (!pick || pick.cardId !== cardId) return null;
  const cancel = () => {
    useShellStore.setState({ annotationPick: null });
    focusPointAt(cardId);
  };
  // Typing stops at the limit; dictated words past it stay whole, and nothing queues until trimmed.
  const over = limitBand(pick.note.comment.length, CARD_REPLY_MAX_CHARS) === "over";
  const queue = (send: boolean) => {
    if (useShellStore.getState().sendingReplies[cardId] || over) return;
    queueNote(cardId, pick.note);
    if (send) void useShellStore.getState().sendReply(cardId, collect);
    else focusPointAt(cardId);
  };
  const sendKey = thisDesktop().mac ? "⌘Enter" : "Ctrl+Enter";
  const left = Math.max(8, Math.min(pick.box.left, innerWidth - 328));
  const top = Math.max(8, Math.min(pick.box.bottom + 8, innerHeight - height - 8));
  return createPortal(
    <div
      ref={pop}
      className="inf-annotation-popover"
      role="dialog"
      tabIndex={-1}
      aria-label={`${m.cardNoteAnnotate()} ${pick.note.kind}`}
      style={{ left, top }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (dictation.keyDown(event)) return;
        // Enter in the comment queues; on a focused button it presses that button.
        if (event.key === "Enter" && !event.shiftKey) {
          event.stopPropagation();
          if (event.target === field.current) {
            event.preventDefault();
            // While the comment records, Enter sends nothing, as in every field that records.
            if (!dictation.recording) queue(event.metaKey || event.ctrlKey);
          }
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
        {m.cardNoteAnnotate()} {pick.note.kind}
      </strong>
      <blockquote>{pick.note.excerpt}</blockquote>
      <textarea
        ref={field}
        rows={3}
        aria-label={m.cardNoteCommentLabel()}
        placeholder={m.cardNotePlaceholder()}
        maxLength={CARD_REPLY_MAX_CHARS}
        readOnly={dictation.recording}
        value={pick.note.comment}
        onChange={(event) => {
          setHint(false);
          useShellStore.setState({
            annotationPick: { ...pick, note: { ...pick.note, comment: event.target.value } },
          });
        }}
      />
      <DictationMark
        recording={dictation.recording}
        transcribing={dictation.transcribing}
        onAbandon={() => {
          useShellStore.getState().abandonRecording();
          field.current?.focus();
        }}
        onAccept={() => useShellStore.getState().acceptRecording()}
      />
      <p className="inf-annotation-hint" role="status">
        <span>
          {over
            ? m.composerTooLongShorten()
            : hint
              ? m.cardNoteDiscardHint()
              : m.cardAnnotationKeys({ sendKey })}
        </span>
        <ComposerCount length={pick.note.comment.length} max={CARD_REPLY_MAX_CHARS} />
      </p>
      <VoiceNotice width="100%" field={dictation.field} />
      <div className="inf-annotation-actions">
        {queued && (
          // Remove sits apart at the row's start, away from Cancel and Queue.
          <Button
            variant="ghost"
            style={{ marginInlineEnd: "auto" }}
            onClick={() => {
              removeNote(cardId, pick.note);
              focusPointAt(cardId);
            }}
          >
            {m.cardNoteRemove()}
          </Button>
        )}
        <Button variant="ghost" onClick={cancel}>
          {m.cardNoteCancel()}
        </Button>
        <Button
          off={over}
          note={over ? m.composerTooLongShorten() : undefined}
          onClick={() => queue(false)}
        >
          {m.cardNoteQueue()}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
