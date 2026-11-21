import { marksSource, smallCopy } from "@shared/cardNoteMarks";
import { type CardNote, markNumbers, noteLabel, placeKey } from "@shared/cardNotes";
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
import { useMarkLook } from "../design/cards/PictureMarks";
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
import { forgetMarked, markedSource } from "./markedPictures";
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
          key={`${pick.note.key}-${JSON.stringify(pick.note.span)}-${placeKey(pick.note.place)}`}
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
  const writing = useShellStore((s) =>
    s.annotationPick?.cardId === cardId ? s.annotationPick.note : undefined,
  );
  // A removed mark's picture is forgotten with it; the queued ones and the one being written
  // stay, and so does a reply's while it is being sent, which a refusal puts back.
  useEffect(() => {
    if (!sending) forgetMarked(cardId, writing ? [...notes, writing] : notes);
  }, [cardId, notes, writing, sending]);
  const marks = markNumbers(notes);
  return (
    <>
      {notes.map((note, at) => (
        <div
          className="inf-queued-note"
          key={JSON.stringify([note.key, note.start, note.span, placeKey(note.place)])}
        >
          <NoteAnchor cardId={cardId} note={note} mark={marks[at]} />
          <MarkedCopy cardId={cardId} note={note} mark={marks[at]} />
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
              onClick={async (event) => {
                // A note on a running page is no part of a card: its words are edited here.
                if (note.page) {
                  const box = event.currentTarget.getBoundingClientRect();
                  if (!settleAnnotation()) return;
                  useShellStore.setState({
                    annotationPick: {
                      cardId,
                      note,
                      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
                    },
                    annotationOffer: null,
                  });
                  return;
                }
                const result = await revealNote(cardId, note, true, marks[at]);
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

/** The most room a marked picture's small copy takes in the thread (the design skill's viewer page). */
const MARKED_COPY = { width: 220, height: 160 };

/**
 * A queued mark's small copy of its picture, with the mark drawn in (docs/card-threads.md,
 * "Pointing at a place"): the picture as this window marked it, never one read again.
 */
function MarkedCopy({ cardId, note, mark }: { cardId: string; note: CardNote; mark?: number }) {
  const look = useMarkLook();
  const source = markedSource(cardId, note);
  if (!source || !note.place || mark === undefined) return null;
  const size = { width: source.width, height: source.height };
  const copy = smallCopy(size, MARKED_COPY.width, MARKED_COPY.height);
  return (
    <span
      className="inf-marked-copy"
      role="img"
      aria-label={m.cardNoteMarkedPicture()}
      data-marked-copy={mark}
      style={{ aspectRatio: `${size.width} / ${size.height}`, width: copy.width }}
    >
      <img src={source.src} alt="" draggable={false} />
      <img
        src={marksSource(size, [{ number: mark, place: note.place }], look, copy.unit)}
        alt=""
        draggable={false}
      />
    </span>
  );
}

/**
 * Where a note points, as a press shows it: its part in the card, or the picture viewer at its
 * mark. `mark` is the number a note with a place is drawn with, in the order its reply queued it.
 */
export function NoteAnchor({
  cardId,
  note,
  mark,
}: {
  cardId: string;
  note: CardNote;
  mark?: number | undefined;
}) {
  const [result, setResult] = useState<NoteReveal>();
  const body = useShellStore((s) => s.cards.find((card) => card.id === cardId)?.body);
  const missing = useMemo(
    () => body !== undefined && notePart(cardBodyHtml(body), note) === undefined,
    [body, note],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a revised body invalidates its previous reveal failure
  useLayoutEffect(() => setResult(undefined), [body]);
  // A note on a running page points at no part of a card: its label is its whole anchor.
  if (note.page)
    return (
      <div className="inf-note-anchor" data-page-note="">
        <span>{noteLabel(note, mark)}</span>
      </div>
    );
  const stale = missing || result === "missing";
  return (
    <div className="inf-note-anchor">
      <button
        type="button"
        onClick={async () => setResult(await revealNote(cardId, note, false, mark))}
      >
        {noteLabel(note, mark)}
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

/**
 * The one editor a note is written in. `cardId` is whose queue the note joins: a card's, or a
 * running page's own (`pageQueue`), whose notes leave from the crewmate's message box (`send`).
 */
export function AnnotationPopover({
  cardId,
  collect,
  send,
}: {
  cardId: string;
  collect?: CollectAnswers | undefined;
  /** Sends the queue where it is no card's reply. */
  send?: (() => void) | undefined;
}) {
  const pick = useShellStore((s) => s.annotationPick);
  const notes = useShellStore((s) => s.replyNotes[cardId] ?? NO_NOTES);
  const queued = pick ? notes.some((n) => sameNote(n, pick.note)) : false;
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
  const queue = (now: boolean) => {
    if (useShellStore.getState().sendingReplies[cardId] || over) return;
    queueNote(cardId, pick.note);
    if (!now) focusPointAt(cardId);
    else if (send) send();
    else void useShellStore.getState().sendReply(cardId, collect);
  };
  // A page's note shows the exact picture that will be sent, with its mark as numbered.
  const pagePicture = pick.note.page ? markedSource(cardId, pick.note) : undefined;
  const numbers = markNumbers(notes);
  const queuedAt = notes.findIndex((n) => sameNote(n, pick.note));
  const mark =
    queuedAt >= 0 ? numbers[queuedAt] : numbers.filter((n) => n !== undefined).length + 1;
  const sendKey = thisDesktop().mac ? "⌘Enter" : "Ctrl+Enter";
  const left = Math.max(8, Math.min(pick.box.left, innerWidth - 328));
  const top = Math.max(8, Math.min(pick.box.bottom + 8, innerHeight - height - 8));
  return createPortal(
    <div
      ref={pop}
      className="inf-annotation-popover"
      // A note on a place is written over the picture viewer or the Browser tab.
      data-note-place={pick.note.place ? "" : undefined}
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
      {pagePicture && (
        <figure className="inf-annotation-picture" data-note-page-picture="">
          <MarkedCopy cardId={cardId} note={pick.note} mark={mark} />
          <figcaption>
            {m.cardNotePagePicture()}
            {pagePicture.shows && <span data-note-page-shows=""> {m.cardNotePageShows()}</span>}
          </figcaption>
        </figure>
      )}
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
