import type { DrawnMark } from "@shared/cardNoteMarks";
import { type CardNote, markNumbers, type NotePlace, placeKey } from "@shared/cardNotes";
import { isDrawingSource } from "@shared/cardPictures";
import { TURN_IMAGES_MAX } from "@shared/cards";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import type { MarkTool } from "../design/cards/PictureMarks";
import {
  PictureViewer,
  type PictureViewerProps,
  type ViewerMarking,
  type ViewerPicture,
} from "../design/cards/PictureViewer";
import { NO_NOTES } from "./AnnotationControls";
import {
  notePartOf,
  offersPointAt,
  type PictureMark,
  partNote,
  sameNote,
  settleAnnotation,
} from "./annotationBridge";
import { markedGroups, rememberMarked } from "./markedPictures";
import { usePlacesHome } from "./useAnnotationHome";

/**
 * The picture viewer over a card, with Point at (docs/card-threads.md,
 * "Pointing at a place"): the captain marks a place in the picture shown, and
 * the mark becomes a note in that card's queue, written in the same popover a
 * part's note is. The viewer draws; this decides whose note a mark is.
 *
 * Point at is offered where the card itself offers it, on a picture whose
 * part the card's frame named: a demo, a held record's picture and a picture
 * of a card that takes no reply take no mark, and only show the ones they have.
 */
export function CardPictureViewer({
  noteCardId,
  lit,
  ...viewer
}: Omit<PictureViewerProps, "marking"> & {
  /** The card whose body the pictures are in, when notes on them join its queue. */
  noteCardId?: string | undefined;
  /** The note whose mark the viewer opened at, drawn lit; `edit` opens its editor there. */
  lit?: PictureMark | undefined;
}) {
  const places = usePlacesHome();
  const [on, setOn] = useState(false);
  const [tool, setTool] = useState<MarkTool>("box");
  const notes = useShellStore((s) =>
    noteCardId ? (s.replyNotes[noteCardId] ?? NO_NOTES) : NO_NOTES,
  );
  const pick = useShellStore((s) =>
    noteCardId && s.annotationPick?.cardId === noteCardId ? s.annotationPick : null,
  );
  const sending = useShellStore((s) => (noteCardId ? s.sendingReplies[noteCardId] : undefined));
  const attached = useShellStore((s) =>
    noteCardId ? (s.replyImages[noteCardId]?.length ?? 0) : 0,
  );
  const keys = useCommandKeys("cards.point-at");
  // The card's own Point at is drawn with its reply row, after the viewer's first render.
  const [offered, setOffered] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the queue or a send redraws the row
  useEffect(() => {
    setOffered(noteCardId !== undefined && offersPointAt(noteCardId));
  }, [noteCardId, notes, sending]);
  // The queued mark the viewer was opened to edit is written again once, where it is drawn.
  const [again, setAgain] = useState<NotePlace | undefined>(lit?.edit ? lit.note.place : undefined);

  const marking = (picture: ViewerPicture): ViewerMarking | undefined => {
    const part = picture.part;
    if (!noteCardId || part === undefined) return undefined;
    const here = (note: CardNote) =>
      note.place !== undefined &&
      (note.place.picture ?? 0) === (picture.of ?? 0) &&
      notePartOf(noteCardId, note) === part;
    const numbers = markNumbers(notes);
    const writing = pick !== null && here(pick.note);
    const marks: DrawnMark[] = notes.flatMap((note, at) =>
      here(note) && note.place && !(writing && sameNote(note, pick.note))
        ? [
            {
              number: numbers[at] as number,
              place: note.place,
              lit: lit !== undefined && sameNote(note, lit.note),
            },
          ]
        : [],
    );
    // A sent note's mark, opened from the thread, is drawn with the number its reply gave it.
    if (lit?.note.place && here(lit.note) && !notes.some((note) => sameNote(note, lit.note)))
      marks.push({ number: lit.number ?? 1, place: lit.note.place, lit: true });
    const count = numbers.filter((number) => number !== undefined).length;
    // A queued note opened again keeps its number; a new one takes the next.
    const queuedAt = pick ? notes.findIndex((note) => sameNote(note, pick.note)) : -1;
    const next = queuedAt >= 0 ? (numbers[queuedAt] as number) : count + 1;
    if (writing && pick.note.place) marks.push({ number: next, place: pick.note.place, lit: true });
    if (!places || !offered) return { marks, writing };
    // Each marked picture rides the reply as one picture, beside the ones attached to it.
    const groups = markedGroups(noteCardId, notes);
    const full =
      !groups.some((group) => group.source.src === picture.src) &&
      groups.length + attached >= TURN_IMAGES_MAX;
    return {
      marks,
      writing,
      point: {
        on,
        off: full ? m.cardNotePicturesFull({ max: formatNumber(TURN_IMAGES_MAX) }) : undefined,
        toggle: () => setOn((previous) => !previous),
        tool,
        setTool,
        next,
        again,
        keys: keys.keys,
        keyProps: {
          "aria-keyshortcuts": keys["aria-keyshortcuts"],
          "data-key-command": keys["data-key-command"],
        },
        mark: (drawn, at) => {
          setAgain(undefined);
          if (sending) return;
          const place: NotePlace = picture.of ? { ...drawn, picture: picture.of } : drawn;
          const kind = isDrawingSource(picture.src) ? "drawing" : "picture";
          // The same place marked again is the queued note it already is, with its words.
          const queued = notes.find(
            (note) => here(note) && placeKey(note.place) === placeKey(place),
          );
          const base =
            queued ??
            partNote(noteCardId, {
              start: part,
              kind,
              // The picture's caption is the note's excerpt, as a part's words are.
              excerpt: (picture.alt || kind).slice(0, 240),
            });
          if (!base) return;
          const note: CardNote = { ...base, place };
          // A note still open is kept as a press beside it keeps it, then this one opens; one
          // whose words are past their limit stays open to trim, and this mark is not made.
          const open = useShellStore.getState().annotationPick;
          if (
            open &&
            !(open.cardId === noteCardId && sameNote(open.note, note)) &&
            !settleAnnotation()
          )
            return;
          rememberMarked(noteCardId, note, {
            src: picture.src,
            alt: picture.alt,
            width: place.width,
            height: place.height,
          });
          useShellStore.setState({
            annotationPick: { cardId: noteCardId, note, box: at },
            annotationOffer: null,
          });
          // Point at turns off once it has marked, as it does in the card.
          setOn(false);
        },
      },
    };
  };
  return <PictureViewer {...viewer} marking={viewer.demo ? undefined : marking} />;
}
