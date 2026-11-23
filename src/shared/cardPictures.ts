import { SPELLINGS } from "./codeNames";
import { APP_FRAME_SCHEME } from "./csp";
import { DRAWING_SOURCE_PREFIX } from "./plugins/bridge";

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
export const CARD_DEMO_TYPES = {
  mp4: "video/mp4",
  gif: "image/gif",
} as const;
/**
 * The formats a card's sound clip may be (docs/card-authoring.md "Sound
 * clips"), by the extension its copy is stored under: served by the same
 * `media` host as a demo recording, from the same folder.
 */
export const CARD_SOUND_TYPES = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
} as const;
/** Every kind of media the `media` host serves: demo recordings and sound clips. */
export const CARD_MEDIA_TYPES = { ...CARD_DEMO_TYPES, ...CARD_SOUND_TYPES } as const;
export type CardMediaExtension = keyof typeof CARD_MEDIA_TYPES;
export type CardDemoKind = keyof typeof CARD_DEMO_TYPES;
export type CardSoundKind = keyof typeof CARD_SOUND_TYPES;
/** Every demo recording kind, for the schemas that name one. */
export const CARD_MEDIA_KINDS = ["mp4", "gif"] as const satisfies readonly CardDemoKind[];
/** Every sound clip kind, for the schemas that name one. */
export const CARD_SOUND_KINDS = ["m4a", "mp3", "wav"] as const satisfies readonly CardSoundKind[];

/**
 * The most of a recording one request carries between Macs (docs/view.md,
 * docs/helper.md): a recording travels in pieces, never whole in one message.
 */
export const CARD_MEDIA_PIECE_BYTES = 1024 * 1024;

/**
 * The frame scheme's host that serves verified project fonts (docs/card-authoring.md,
 * "Fonts by reference"): a preview's `@font-face` names a font file in the
 * working copy, and the host keeps its copy beside the pictures under the
 * same self-locating names, at a host of its own - never the `fonts` host,
 * which serves only the design system's own typefaces.
 */
export const CARD_TYPEFACE_HOST = "typefaces";

/** The formats a project font may be, by the extension its copy is stored under. */
export const CARD_TYPEFACE_TYPES = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
} as const;
export type CardTypefaceExtension = keyof typeof CARD_TYPEFACE_TYPES;
/** Every project font kind, for the schemas that name one. */
export const CARD_TYPEFACE_KINDS = [
  "woff2",
  "woff",
  "ttf",
  "otf",
] as const satisfies readonly CardTypefaceExtension[];

/**
 * Where a card's data files are named (docs/card-authoring.md, "Data by
 * reference"): a `<script type="application/json" src>` names a JSON file in
 * the working copy, and the host keeps its copy beside the pictures under
 * the same self-locating names. No host of the frame scheme serves it: a
 * frame loads nothing by it, and its script asks the bridge for the text
 * (`inf.data`), which the window reads with `inf:cards:data`.
 */
export const CARD_DATA_HOST = "data";

/** The type a card's data file is, and the one extension its copy is stored under. */
export const CARD_DATA_TYPE = "application/json";

/**
 * The host of a kept proof log's address (docs/card-authoring.md, "Proof
 * logs"): a text transcript a live validation run kept, which a merge card
 * names by one line and the log reader shows over the card. Its file is named
 * by its own SHA-256 under the task's folder beside the pictures, so the name
 * locates it as a picture's does. The address is a name, not a place any
 * frame loads: the window's reader and the phone's ask the core for it by
 * that name (`inf:cards:log`), and the frame scheme serves nothing there.
 */
export const CARD_LOG_HOST = "logs";

/** The formats a kept proof log may be, by its extension. Every one is read as text. */
export const CARD_LOG_TYPES = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
} as const;
export type CardLogExtension = keyof typeof CARD_LOG_TYPES;

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
const MEDIA_FILE_NAME = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.(mp4|gif|m4a|mp3|wav)$/;
const TYPEFACE_FILE_NAME = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.(woff2|woff|ttf|otf)$/;
const DATA_FILE_NAME = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.json$/;
const LOG_FILE_NAME = /^([A-Za-z0-9_-]{1,64})-([0-9a-f]{64})\.(txt|log|json)$/;

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

/** The file name a project font's copy is stored under, and the one URL segment that serves it. */
export function cardTypefaceFileName(id: string, extension: CardTypefaceExtension): string {
  return `${id}.${extension}`;
}

/** The URL a preview's `@font-face` names a verified project font by. */
export function cardTypefaceUrl(id: string, extension: CardTypefaceExtension): string {
  return `${APP_FRAME_SCHEME}://${CARD_TYPEFACE_HOST}/${cardTypefaceFileName(id, extension)}`;
}

/**
 * Parses the one segment the `typefaces` host was asked for, as
 * `parseCardPictureFileName` does for pictures: anything not exactly a
 * minted font name is `undefined`.
 */
export function parseCardTypefaceFileName(name: string):
  | {
      taskId: string;
      id: string;
      fileName: string;
      kind: CardTypefaceExtension;
      contentType: (typeof CARD_TYPEFACE_TYPES)[CardTypefaceExtension];
    }
  | undefined {
  const match = TYPEFACE_FILE_NAME.exec(name);
  if (!match) return undefined;
  const [, taskId, hex, extension] = match;
  if (!taskId || !hex || !extension) return undefined;
  const kind = extension as CardTypefaceExtension;
  return {
    taskId,
    id: `${taskId}-${hex}`,
    fileName: name,
    kind,
    contentType: CARD_TYPEFACE_TYPES[kind],
  };
}

/** The URL a merge card names a kept proof log by: its kept file's own name at the `logs` host. */
export function cardLogUrl(fileName: string): string {
  return `${APP_FRAME_SCHEME}://${CARD_LOG_HOST}/${fileName}`;
}

/**
 * Parses a log address's one segment, as
 * `parseCardPictureFileName` does for pictures: anything not exactly a kept
 * log's name (`<taskId>-<sha256>.<txt|log|json>`) is `undefined`.
 */
export function parseCardLogFileName(name: string):
  | {
      taskId: string;
      fileName: string;
      contentType: (typeof CARD_LOG_TYPES)[CardLogExtension];
    }
  | undefined {
  const match = LOG_FILE_NAME.exec(name);
  if (!match) return undefined;
  const [, taskId, , extension] = match;
  if (!taskId || !extension) return undefined;
  return { taskId, fileName: name, contentType: CARD_LOG_TYPES[extension as CardLogExtension] };
}

/** Whether the log reader may open a log a frame named: one kept log's URL, exactly. */
export function isReadableLogSource(src: string): boolean {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_LOG_HOST}/`;
  return src.startsWith(prefix) && parseCardLogFileName(src.slice(prefix.length)) !== undefined;
}

/** A `data-inf-log` the host wrote, or one in another spelling (`@shared/codeNames`). */
const LOG_SOURCE = new RegExp(`data-(?:${SPELLINGS.join("|")})-log="([^"]*)"`, "g");

/**
 * The proof logs a card body opens: each `data-inf-log` it names, as kept. A
 * frame's `log` message opens only one of these, so a body's own script
 * cannot open a log its card does not name.
 */
export function logSources(body: string): Set<string> {
  const found = new Set<string>();
  for (const match of body.matchAll(LOG_SOURCE)) {
    const src = match[1] ?? "";
    if (isReadableLogSource(src)) found.add(src);
  }
  return found;
}

/**
 * The kept project fonts a card body names, each once, by the file name the
 * `typefaces` host serves: a body that names one rides the mount vehicle
 * (`PrototypeBody.tsx`), and a computer that runs work sends each to its
 * home before the card (docs/helper.md).
 */
export function cardTypefaceNames(body: string): string[] {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_TYPEFACE_HOST}/`;
  const names: string[] = [];
  for (const part of body.split(prefix).slice(1)) {
    const name = /^[^"'\s>);]+/.exec(part)?.[0] ?? "";
    if (parseCardTypefaceFileName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The file name a card data file's copy is stored under, and the name its body gives it. */
export function cardDataFileName(id: string): string {
  return `${id}.json`;
}

/** The address a card body names a kept data file by, in its `<script type="application/json">`'s `src`. */
export function cardDataUrl(id: string): string {
  return `${APP_FRAME_SCHEME}://${CARD_DATA_HOST}/${cardDataFileName(id)}`;
}

/**
 * Parses a kept data file's name, as `parseCardPictureFileName` does for
 * pictures: anything not exactly a minted data name is `undefined`.
 */
export function parseCardDataFileName(
  name: string,
): { taskId: string; id: string; fileName: string } | undefined {
  const match = DATA_FILE_NAME.exec(name);
  if (!match) return undefined;
  const [, taskId, hex] = match;
  if (!taskId || !hex) return undefined;
  return { taskId, id: `${taskId}-${hex}`, fileName: name };
}

/** The kept data file an address names, when it is one exactly as minted (`cardDataUrl`). */
export function cardDataName(src: string): string | undefined {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_DATA_HOST}/`;
  if (!src.startsWith(prefix)) return undefined;
  const name = src.slice(prefix.length);
  return parseCardDataFileName(name) ? name : undefined;
}

/**
 * The kept data files a card body names, each once, by file name: the only
 * ones its frame may ask the bridge for (`inf.data`), and the ones a computer
 * that runs work sends its home before the card (docs/helper.md).
 */
export function cardDataNames(body: string): string[] {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_DATA_HOST}/`;
  const names: string[] = [];
  for (const part of body.split(prefix).slice(1)) {
    const name = /^[^"'\s>);]+/.exec(part)?.[0] ?? "";
    if (parseCardDataFileName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * What a recording a frame named is, when the viewer may play it: one of
 * the host's own verified copies, exactly as minted, and nothing else - no
 * other host, no web URL, no `data:` or `blob:` recording. The kind decides
 * the player: an MP4 plays in a `<video>`, a GIF in an `<img>` only once
 * Play is pressed.
 */
export function playableDemoKind(src: string): CardDemoKind | undefined {
  const kind = servedMediaKind(src);
  return kind === "mp4" || kind === "gif" ? kind : undefined;
}

function servedMediaKind(src: string): CardMediaExtension | undefined {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/`;
  return src.startsWith(prefix)
    ? parseCardMediaFileName(src.slice(prefix.length))?.kind
    : undefined;
}

/**
 * What a sound clip a frame named is, when the card's strip may play it:
 * one of the host's own verified copies of a clip, exactly as minted, and
 * nothing else (docs/card-authoring.md "Sound clips").
 */
export function playableSoundKind(src: string): CardSoundKind | undefined {
  const kind = servedMediaKind(src);
  return kind === "m4a" || kind === "mp3" || kind === "wav" ? kind : undefined;
}

/** A `data-inf-sound` the host wrote. */
const SOUND_SOURCE = /data-inf-sound="([^"]*)"/g;

/**
 * The sound clips a card body plays: each `data-inf-sound` the host wrote,
 * as minted. A frame's `sound` message plays only one of these, so a body's
 * own script cannot play anything its card was not verified with.
 */
export function soundSources(body: string): Set<string> {
  const found = new Set<string>();
  for (const match of body.matchAll(SOUND_SOURCE)) {
    const src = match[1] ?? "";
    if (playableSoundKind(src)) found.add(src);
  }
  return found;
}

export function cardSoundNames(body: string): string[] {
  const prefix = `${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/`;
  return [...soundSources(body)].map((src) => src.slice(prefix.length));
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
 * picture may be. An SVG picture is shown only as a diagram the frame wrote
 * itself (`isDrawingSource`).
 */
const VIEWABLE_DATA_PICTURE = /^data:image\/(png|jpeg|gif|webp)[;,]/;

/**
 * Whether the picture viewer (card pictures, phase 3) may show a picture a
 * frame named: one of the host's own verified copies, exactly as minted, or
 * a `data:` picture the body carries itself. Anything else - another host
 * of the frame scheme, a web URL the frame could never load - is not shown.
 */
export function isViewablePictureSource(src: string): boolean {
  if (VIEWABLE_DATA_PICTURE.test(src) || isDrawingSource(src)) return true;
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
  drawings = true,
): { index: number; pictures: T[] } | undefined {
  const viewable = (src: string) =>
    isViewablePictureSource(src) && (drawings || !isDrawingSource(src));
  const clicked = pictures[index];
  if (!clicked || !viewable(clicked.src)) return undefined;
  const kept = pictures.filter((picture) => viewable(picture.src));
  return { index: kept.indexOf(clicked), pictures: kept };
}

/**
 * Whether a picture is a diagram the frame wrote out of the card (INF-3107,
 * `DRAWING_SOURCE_PREFIX`): an SVG picture, which runs nothing and loads
 * nothing wherever it is shown. A playable preview's drawings open nothing,
 * so its host asks `viewablePictures` without them.
 */
export function isDrawingSource(src: string): boolean {
  return src.startsWith(DRAWING_SOURCE_PREFIX);
}

/** A typeface a diagram names, as the card's own stylesheet serves it. */
const DRAWING_FACE = new RegExp(`${APP_FRAME_SCHEME}://fonts/([a-z0-9-]+\\.woff2)`, "g");

/**
 * A diagram with the card's own typefaces inside it. A picture loads
 * nothing, so the faces the frame copied from the card's stylesheet each
 * become the font file itself, which `read` gives as a `data:` URL; a face
 * it cannot give is left as it was, and the words fall back to the
 * computer's own type.
 */
export async function withDrawingFaces(
  src: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<string> {
  if (!isDrawingSource(src)) return src;
  let markup: string;
  try {
    markup = decodeURIComponent(src.slice(DRAWING_SOURCE_PREFIX.length));
  } catch {
    return src;
  }
  const files = new Set(Array.from(markup.matchAll(DRAWING_FACE), (match) => match[1] ?? ""));
  const found = new Map<string, string>();
  await Promise.all(
    Array.from(files, async (file) => {
      const data = await read(file).catch(() => undefined);
      if (data?.startsWith("data:")) found.set(file, data);
    }),
  );
  if (found.size === 0) return src;
  const embedded = markup.replace(DRAWING_FACE, (whole, file: string) => found.get(file) ?? whole);
  return DRAWING_SOURCE_PREFIX + encodeURIComponent(embedded);
}

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
