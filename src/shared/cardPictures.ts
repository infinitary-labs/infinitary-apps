import { SPELLINGS } from "./codeNames";
import { APP_FRAME_SCHEME } from "./csp";

/**
 * Pictures by reference (card pictures, phase 2 of the locked plan): a
 * picture is an `<img>` in a card body naming a file in the crewmate's
 * working copy. The host verifies it, copies the bytes under the task
 * (`crewmates/<taskId>/cards/<id>.<ext>`), and rewrites the `src` to the
 * frame scheme's `images` host, which serves that copy and nothing else - so
 * no picture's bytes ride the body, SQLite or the `inf:cards` push.
 *
 * The name is SELF-LOCATING: a picture id is `<taskId>-<32 hex>`, so the
 * shell finds the file from the one URL segment it is asked for, with no
 * index to consult, no path segments to walk and no listing to serve. The
 * core mints names and the shell parses them through this one module, so the
 * two cannot disagree.
 */

/** The frame scheme's host that serves verified card pictures. */
export const CARD_PICTURE_HOST = "images";

/**
 * The frame scheme's host that serves verified demo recordings (demo
 * videos, docs/card-authoring.md "Demo recordings"): the same self-locating
 * names under the same folder, at a host of their own, so the `images` host
 * never serves a recording and this one never serves a picture.
 */
export const CARD_MEDIA_HOST = "media";

/**
 * The formats a demo recording may be, by the extension its copy is stored
 * under: an MP4, or the single-play GIF made when no MP4 could be.
 */
export const CARD_MEDIA_TYPES = {
  mp4: "video/mp4",
  gif: "image/gif",
} as const;
export type CardMediaExtension = keyof typeof CARD_MEDIA_TYPES;
/** Every demo recording kind, for the schemas that name one. */
export const CARD_MEDIA_KINDS = ["mp4", "gif"] as const satisfies readonly CardMediaExtension[];

/**
 * The most of a recording one request carries between Macs (docs/view.md,
 * docs/helper.md): a recording travels in pieces, never whole in one message.
 */
export const CARD_MEDIA_PIECE_BYTES = 1024 * 1024;

/** The formats a card picture may be, by the extension its copy is stored under. */
export const CARD_PICTURE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
} as const;
export type CardPictureExtension = keyof typeof CARD_PICTURE_TYPES;

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The owner the startup note's hero pictures are kept under
 * (`crewmates/release-notes/cards`, docs/release-notes.md): not a task, so
 * no task's close or purge removes them, and a note delivered before an
 * upgrade still shows its pictures after it.
 */
export const RELEASE_NOTES_PICTURE_OWNER = "release-notes";
const FILE_NAME = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.(png|jpg|webp)$/;
const MEDIA_FILE_NAME = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.(mp4|gif)$/;

/** Whether a task id can name a picture (it becomes part of a file and a URL). */
export function isPictureTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId);
}

/** The file name a picture's copy is stored under, and the one URL segment that serves it. */
export function cardPictureFileName(id: string, extension: CardPictureExtension): string {
  return `${id}.${extension}`;
}

/** The URL a card body names a verified picture by. */
export function cardPictureUrl(id: string, extension: CardPictureExtension): string {
  return `${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/${cardPictureFileName(id, extension)}`;
}

/**
 * Parses the one segment the `images` host was asked for. Anything that is
 * not exactly a minted name - a path, a traversal, another extension - is
 * `undefined`, and the shell answers 404.
 */
export function parseCardPictureFileName(name: string):
  | {
      taskId: string;
      fileName: string;
      contentType: (typeof CARD_PICTURE_TYPES)[CardPictureExtension];
    }
  | undefined {
  const match = FILE_NAME.exec(name);
  if (!match) return undefined;
  const [, taskId, , extension] = match;
  if (!taskId || !extension) return undefined;
  return {
    taskId,
    fileName: name,
    contentType: CARD_PICTURE_TYPES[extension as CardPictureExtension],
  };
}

/** The file name a demo recording's copy is stored under, and the one URL segment that serves it. */
export function cardMediaFileName(id: string, extension: CardMediaExtension): string {
  return `${id}.${extension}`;
}

/** The URL a card body names a verified demo recording by. */
export function cardMediaUrl(id: string, extension: CardMediaExtension): string {
  return `${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/${cardMediaFileName(id, extension)}`;
}

/**
 * Parses the one segment the `media` host was asked for, as
 * `parseCardPictureFileName` does for pictures: anything not exactly a
 * minted recording name is `undefined`.
 */
export function parseCardMediaFileName(name: string):
  | {
      taskId: string;
      fileName: string;
      kind: CardMediaExtension;
      contentType: (typeof CARD_MEDIA_TYPES)[CardMediaExtension];
    }
  | undefined {
  const match = MEDIA_FILE_NAME.exec(name);
  if (!match) return undefined;
  const [, taskId, , extension] = match;
  if (!taskId || !extension) return undefined;
  const kind = extension as CardMediaExtension;
  return { taskId, fileName: name, kind, contentType: CARD_MEDIA_TYPES[kind] };
}

/**
 * What a recording a frame named is, when the viewer may play it: one of
 * the host's own verified copies, exactly as minted, and nothing else - no
 * other host, no web URL, no `data:` or `blob:` recording. The kind decides
 * the player: an MP4 plays in a `<video>`, a GIF in an `<img>` only once
 * Play is pressed.
 */
export function playableDemoKind(src: string): CardMediaExtension | undefined {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/`;
  return src.startsWith(prefix)
    ? parseCardMediaFileName(src.slice(prefix.length))?.kind
    : undefined;
}

/** A `data-inf-demo` the host wrote, or one in another spelling (`@shared/codeNames`). */
const DEMO_SOURCE = new RegExp(`data-(?:${SPELLINGS.join("|")})-demo="([^"]*)"`, "g");

/** Whether the viewer may play a recording a frame named (`playableDemoKind`). */
export function isPlayableDemoSource(src: string): boolean {
  return playableDemoKind(src) !== undefined;
}

/**
 * The recordings a card body plays: each `data-inf-demo` the host wrote, as
 * minted. A frame's `demo` message plays only one of these, so a body's own
 * script cannot play anything its card was not verified with.
 */
export function demoSources(body: string): Set<string> {
  const found = new Set<string>();
  // In either spelling of the hook (`@shared/codeNames`).
  for (const match of body.matchAll(DEMO_SOURCE)) {
    const src = match[1] ?? "";
    if (isPlayableDemoSource(src)) found.add(src);
  }
  return found;
}

/**
 * `data:` pictures the picture viewer shows: the raster formats a reply
 * picture may be. SVG is left to the body that drew it.
 */
const VIEWABLE_DATA_PICTURE = /^data:image\/(png|jpeg|gif|webp)[;,]/;

/**
 * Whether the picture viewer (card pictures, phase 3) may show a picture a
 * frame named: one of the host's own verified copies, exactly as minted, or
 * a `data:` picture the body carries itself. Anything else - another host
 * of the frame scheme, a web URL the frame could never load - is not shown.
 */
export function isViewablePictureSource(src: string): boolean {
  if (VIEWABLE_DATA_PICTURE.test(src)) return true;
  const prefix = `${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/`;
  return src.startsWith(prefix) && parseCardPictureFileName(src.slice(prefix.length)) !== undefined;
}

/**
 * The set the viewer opens from a frame's `image` message: the group's
 * viewable pictures in body order, and where the clicked one now stands.
 * `undefined` when the clicked picture is not one the viewer may show - a
 * click on it opens nothing, whatever its siblings are.
 */
export function viewablePictures<T extends { src: string }>(
  index: number,
  pictures: readonly T[],
): { index: number; pictures: T[] } | undefined {
  const clicked = pictures[index];
  if (!clicked || !isViewablePictureSource(clicked.src)) return undefined;
  const kept = pictures.filter((picture) => isViewablePictureSource(picture.src));
  return { index: kept.indexOf(clicked), pictures: kept };
}

/** One host's links in a body turned into the files they stand for, each file listed once. */
function linkedFiles(
  body: string,
  host: string,
  parse: (name: string) => { taskId: string; fileName: string } | undefined,
  crewmatesDir: string,
): { body: string; files: string[] } {
  const files: string[] = [];
  const prefix = `${APP_FRAME_SCHEME}://${host}/`;
  const parts = body.split(prefix).map((part, index) => {
    if (index === 0) return part;
    const name = /^[^"'\s>)]+/.exec(part)?.[0] ?? "";
    const named = parse(name);
    if (!named) return prefix + part;
    const file = `${crewmatesDir}/${named.taskId}/cards/${named.fileName}`;
    if (!files.includes(file)) files.push(file);
    return file + part.slice(name.length);
  });
  return { body: parts.join(""), files };
}

/**
 * A card body with its picture and recording links turned into the files
 * they stand for. A builder cannot open an `app-frame://` link, but the host
 * keeps each copy under the crewmate's folder (`crewmatesDir/<taskId>/cards`),
 * so a brief names that path instead. The path is joined with a slash; the app ships on macOS only.
 */
export function cardPictureFiles(
  body: string,
  crewmatesDir: string,
): { body: string; pictures: string[]; recordings: string[] } {
  const pictures = linkedFiles(body, CARD_PICTURE_HOST, parseCardPictureFileName, crewmatesDir);
  const recordings = linkedFiles(
    pictures.body,
    CARD_MEDIA_HOST,
    parseCardMediaFileName,
    crewmatesDir,
  );
  return { body: recordings.body, pictures: pictures.files, recordings: recordings.files };
}
