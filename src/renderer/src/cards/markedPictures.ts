import { type DrawnMark, marksSource } from "@shared/cardNoteMarks";
import { type CardNote, markNumbers, placeKey } from "@shared/cardNotes";
import { CARD_PICTURE_HOST, parseCardPictureFileName } from "@shared/cardPictures";
import { TURN_IMAGE_MAX_BYTES, type TurnImage } from "@shared/cards";
import { APP_FRAME_SCHEME } from "@shared/csp";
import { markLook } from "../design/cards/PictureMarks";

/**
 * The pictures the captain marked, in this window only (docs/card-threads.md,
 * "Pointing at a place"): which picture each queued mark was made on, for the
 * queued note's small copy and for the one picture per marked picture a reply
 * carries. Nothing here is sent or kept until the captain sends: the marked
 * picture is drawn at that moment, from the picture as it was marked.
 */

/**
 * A picture as the viewer or the Browser tab showed it when it was marked. `shows` is set on a
 * page's picture taken while the captain holds its browser: sending it shows the crewmate a page
 * it cannot see now, which the note's popover says.
 */
export type MarkedSource = {
  src: string;
  alt: string;
  width: number;
  height: number;
  shows?: true;
};

const sources = new Map<string, MarkedSource>();

/** `owner` is whose queue the note is in: a card's id, or a page's own queue. */
const idOf = (owner: string, note: CardNote) =>
  JSON.stringify([owner, note.key, note.start, placeKey(note.place)]);

/** The queue of a running page with no card beside it: its notes leave from the crewmate's message box. */
export function pageQueue(taskId: string): string {
  return `page:${taskId}`;
}

export function rememberMarked(owner: string, note: CardNote, source: MarkedSource): void {
  sources.set(idOf(owner, note), source);
}

export function markedSource(owner: string, note: CardNote): MarkedSource | undefined {
  return note.place ? sources.get(idOf(owner, note)) : undefined;
}

/** Forget the pictures of notes no longer queued under `owner`; `kept` are the ones still there. */
export function forgetMarked(owner: string, kept: readonly CardNote[]): void {
  const live = new Set(kept.map((note) => idOf(owner, note)));
  const prefix = `${JSON.stringify(owner)},`;
  for (const id of sources.keys()) {
    if (id.startsWith(`[${prefix}`) && !live.has(id)) sources.delete(id);
  }
}

/** The queued marks of one queue, picture by picture, in the order each picture was first marked. */
export function markedGroups(
  owner: string,
  notes: readonly CardNote[],
): { source: MarkedSource; marks: DrawnMark[] }[] {
  const numbers = markNumbers(notes);
  const groups = new Map<string, { source: MarkedSource; marks: DrawnMark[] }>();
  notes.forEach((note, at) => {
    const source = markedSource(owner, note);
    const number = numbers[at];
    if (!source || !note.place || number === undefined) return;
    const group = groups.get(source.src) ?? { source, marks: [] };
    group.marks.push({ number, place: note.place });
    groups.set(source.src, group);
  });
  return [...groups.values()];
}

/** How many pictures the queue's marks will add to its message. */
export function markedPictureCount(owner: string, notes: readonly CardNote[]): number {
  return markedGroups(owner, notes).length;
}

const PICTURE_PREFIX = `${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/`;

function decoded(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error());
    image.src = src;
  });
}

/**
 * A picture this window may read the pixels of. A card's own picture is asked of the core by its
 * minted name, as a view's frames ask (`inf:cards:picture`): the frame scheme's copy is another
 * origin's, which a drawing surface refuses to give back. A `data:` picture is the window's own.
 */
export async function readable(src: string): Promise<HTMLImageElement> {
  if (!src.startsWith(PICTURE_PREFIX)) return decoded(src);
  const name = src.slice(PICTURE_PREFIX.length);
  if (!parseCardPictureFileName(name)) throw new Error();
  const { contentType, data } = await window.infinitary.cards.picture(name);
  return decoded(`data:${contentType};base64,${data}`);
}

export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error());
    reader.readAsDataURL(blob);
  });
}

/**
 * One marked picture: the picture at its own size with its numbered marks drawn in. It throws
 * when the picture cannot be read or written; `markedPictures` then leaves that picture out.
 */
async function markedPicture(
  source: MarkedSource,
  marks: readonly DrawnMark[],
  name: string,
): Promise<TurnImage> {
  const size = { width: source.width, height: source.height };
  const [picture, drawn] = await Promise.all([
    readable(source.src),
    decoded(marksSource(size, marks, markLook())),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error();
  context.drawImage(picture, 0, 0, size.width, size.height);
  context.drawImage(drawn, 0, 0, size.width, size.height);
  const write = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // A PNG keeps every pixel; one too big for a message goes as a JPEG instead.
  let blob = await write("image/png");
  if (!blob || blob.size > TURN_IMAGE_MAX_BYTES) blob = await write("image/jpeg", 0.85);
  if (!blob || blob.size > TURN_IMAGE_MAX_BYTES) throw new Error();
  const png = blob.type === "image/png";
  return {
    mimeType: png ? "image/png" : "image/jpeg",
    data: await base64Of(blob),
    name: `${name}.${png ? "png" : "jpg"}`,
  };
}

/**
 * The pictures a reply's marks ride on: one per marked picture, each with its numbered marks. A
 * picture this window can no longer read is left out; its note still says where its mark is.
 */
export async function markedPictures(
  owner: string,
  notes: readonly CardNote[],
): Promise<TurnImage[]> {
  const pictures = await Promise.all(
    markedGroups(owner, notes).map((group, at) =>
      markedPicture(group.source, group.marks, `marked-${at + 1}`).catch(() => undefined),
    ),
  );
  return pictures.filter((picture): picture is TurnImage => picture !== undefined);
}
