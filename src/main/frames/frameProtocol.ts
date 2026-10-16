import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  CARD_MEDIA_HOST,
  CARD_MEDIA_PIECE_BYTES,
  CARD_PICTURE_HOST,
  parseCardMediaFileName,
  parseCardPictureFileName,
} from "@shared/cardPictures";
import { APP_FRAME_SCHEME } from "@shared/csp";
import { CARD_MOUNT_HOST_PREFIX, PANEL_MOUNT_HOST_PREFIX } from "@shared/plugins/frameDocument";
import { FRAME_LIB_HOST, type FrameLibPins, isFrameLibPath } from "@shared/plugins/frameLib";
import { protocol } from "electron";
import { bytesHash, type FrameMountRegistry, type ServedFrameDocument } from "./frameMounts";
import { mediaResponse, requestedRange } from "./mediaResponse";

/**
 * The privileged scheme plugin frames load from (docs/ui-plugins.md; the
 * voice model's `app-model:` is the pattern). Its hosts are all answered
 * in-process from memory, the app bundle or userData - nothing behind this
 * scheme ever leaves the machine:
 *
 * - `app-frame://mount/<id>`: a template document the renderer mounted,
 *   served with its own CSP header so the frame does not inherit the app's
 *   policy (a srcdoc would) and its template script can run by hash.
 * - `app-frame://fonts/<file>`: the design system's typefaces, served with
 *   CORS so an opaque-origin frame may load them - the fonts-in-frames fix.
 * - `app-frame://images/<taskId>-<32 hex>.<ext>`: a picture a card names,
 *   the host's own copy of a file it verified in a crewmate's working copy
 *   (card pictures, phase 2). One segment, parsed by the one module that
 *   mints it (`@shared/cardPictures`) and located from it under
 *   `crewmates/<taskId>/cards/` - no other path, no listing. On an app
 *   controlling another Mac the same name is asked of that Mac.
 * - `app-frame://media/<taskId>-<32 hex>.mp4` (or `.gif`): a demo recording
 *   a card's poster stands for, located the same way beside the pictures,
 *   and answered a byte range at a time (`./mediaResponse`) for the picture
 *   viewer's player in the window - a card's own frame may not load media.
 *   The viewer adds a query to start each GIF play from its first frame;
 *   only the one path segment names the file.
 * - `app-frame://panel-<id>/`: a panel drawn in the frame realm (one plugin
 *   vehicle, Phase A item 4), at a host of its own like a card; under it,
 *   exactly the compiled modules its mount read and hashed.
 * - `app-frame://lib/<file>`: the frame realm's library (React, the JSX
 *   runtime, the design library, the runtime, the app's own panels), served
 *   from the bundle only while each file's bytes match the pin this build
 *   baked into main. No other file under the host exists.
 *
 * Its privileges (`standard`, `secure`, `corsEnabled`, `stream`) live in
 * `./frameScheme`, so the work mode can register them without loading this
 * handler. The window registers them with the shell's other schemes before
 * `app.ready` (`registerPrivilegedSchemes`, ../schemes.ts). Pair with
 * `handleFrameProtocol` after ready.
 */

export type FrameFontFiles = Readonly<Record<string, string>>;

/** One piece of a recording, from the Mac that keeps it: its bytes from the offset asked, and the whole file's size. */
export type MediaPiece = { data: Uint8Array; size: number };

/** The most of a recording one request asks of another Mac (docs/view.md). */
export const MEDIA_PIECE_BYTES = CARD_MEDIA_PIECE_BYTES;

/**
 * Where a card picture's or recording's bytes come from: `userData/crewmates`
 * on the Mac that holds Firstmate, each task's copies in its `cards/`; or,
 * on an app controlling another Mac, that Mac's answer for the name
 * (docs/view.md) - a recording a piece at a time.
 */
export type PictureSource =
  | { root: string }
  | {
      fetch: (fileName: string) => Promise<Uint8Array>;
      fetchMedia?: (fileName: string, offset: number, length: number) => Promise<MediaPiece>;
    };

/** What the scheme's hosts answer from. */
export type FrameHosts = {
  mounts: FrameMountRegistry;
  fonts: FrameFontFiles;
  /** Read per request, so it follows what this app is now. */
  pictures: () => PictureSource;
  /** The frame realm's lib: where its files are, and the pins they must match. */
  lib?: { dir: string; pins: FrameLibPins };
};

const FONT_CONTENT_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function fontContentType(file: string): string | undefined {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? undefined : FONT_CONTENT_TYPES[file.slice(dot)];
}

function moduleResponse(bytes: Uint8Array): Response {
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "content-length": String(bytes.byteLength),
      // A panel document has an opaque origin, and a module script is a
      // CORS fetch: without this no frame could load one.
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

function servedDocument(document: ServedFrameDocument | undefined): Response {
  if (!document) return new Response(null, { status: 404 });
  return new Response(document.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": document.csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** A recording's bytes on this Mac, a range at a time from its file. */
async function localMedia(path: string, range: string | null, contentType: string) {
  const info = await stat(path);
  if (!info.isFile()) return new Response(null, { status: 404 });
  return mediaResponse(range, info.size, contentType, async ({ start, end }) => {
    return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
  });
}

/** A recording's sizes, as the other Mac stated them, so a range is answered in one request. */
const remoteSizes = new Map<string, number>();

/**
 * A recording kept on another Mac: a range is asked of it a piece at a
 * time, each answer at most one piece, which a player follows with the
 * next; a request for the whole file is answered whole.
 */
async function remoteMedia(
  fileName: string,
  fetchMedia: (fileName: string, offset: number, length: number) => Promise<MediaPiece>,
  range: string | null,
  contentType: string,
): Promise<Response> {
  let size = remoteSizes.get(fileName);
  if (size === undefined) {
    size = (await fetchMedia(fileName, 0, 0)).size;
    remoteSizes.set(fileName, size);
  }
  const asked = requestedRange(range, size);
  // A range is answered at most one piece of it; a request for the whole file, whole.
  const header =
    asked && asked !== "unsatisfiable"
      ? `bytes=${asked.start}-${Math.min(asked.end, asked.start + MEDIA_PIECE_BYTES - 1)}`
      : range;
  return mediaResponse(header, size, contentType, async ({ start, end }) => {
    const parts: Uint8Array[] = [];
    for (let at = start; at <= end; at += MEDIA_PIECE_BYTES) {
      const length = Math.min(MEDIA_PIECE_BYTES, end - at + 1);
      const answer = await fetchMedia(fileName, at, length);
      if (answer.data.byteLength !== length) throw new Error("a short piece of a recording");
      parts.push(answer.data);
    }
    return Buffer.concat(parts) as BodyInit;
  });
}

/** What of the request a host reads besides its URL. */
export type FrameRequestDetails = { method?: string; range?: string | null };

/** Resolves one request against the frame hosts; exported for the unit test. */
export async function answerFrameRequest(
  url: string,
  { mounts, fonts, pictures, lib }: FrameHosts,
  read: (path: string) => Promise<Uint8Array> = (path) => readFile(path),
  details: FrameRequestDetails = {},
): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new Response(null, { status: 400 });
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.host === "mount" && segments.length === 1) {
    return servedDocument(mounts.document(segments[0] ?? ""));
  }
  if (parsed.host.startsWith(PANEL_MOUNT_HOST_PREFIX)) {
    const mountId = parsed.host.slice(PANEL_MOUNT_HOST_PREFIX.length);
    if (segments.length === 0) return servedDocument(mounts.panelDocument(mountId));
    const bytes = mounts.panelFile(mountId, segments.join("/"));
    return bytes ? moduleResponse(bytes) : new Response(null, { status: 404 });
  }
  if (parsed.host === FRAME_LIB_HOST) {
    const path = segments.join("/");
    const pin = lib && isFrameLibPath(path) && Object.hasOwn(lib.pins, path) ? lib.pins[path] : "";
    if (!lib || !pin) return new Response(null, { status: 404 });
    try {
      const bytes = new Uint8Array(await read(join(lib.dir, ...segments)));
      // A file that no longer matches the pin this build baked in is not the
      // file the build made: it is never served, whatever it is now.
      if (bytesHash(bytes) !== pin) return new Response(null, { status: 404 });
      return moduleResponse(bytes);
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  if (parsed.host.startsWith(CARD_MOUNT_HOST_PREFIX) && segments.length === 0) {
    return servedDocument(mounts.cardDocument(parsed.host.slice(CARD_MOUNT_HOST_PREFIX.length)));
  }
  if (parsed.host === "fonts" && segments.length === 1) {
    const file = segments[0] ?? "";
    const path = Object.hasOwn(fonts, file) ? fonts[file] : undefined;
    const contentType = fontContentType(file);
    if (!path || !contentType) return new Response(null, { status: 404 });
    try {
      const bytes = await read(path);
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  if (parsed.host === CARD_PICTURE_HOST && segments.length === 1) {
    const picture = parseCardPictureFileName(segments[0] ?? "");
    if (!picture) return new Response(null, { status: 404 });
    try {
      const source = pictures();
      const bytes =
        "root" in source
          ? await read(join(source.root, picture.taskId, "cards", picture.fileName))
          : await source.fetch(picture.fileName);
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          "content-type": picture.contentType,
          "content-length": String(bytes.byteLength),
          "x-content-type-options": "nosniff",
          // A name is minted once per copy and never rewritten.
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  if (parsed.host === CARD_MEDIA_HOST && segments.length === 1) {
    const recording = parseCardMediaFileName(segments[0] ?? "");
    if (!recording) return new Response(null, { status: 404 });
    if ((details.method ?? "GET") !== "GET") return new Response(null, { status: 405 });
    try {
      const source = pictures();
      const range = details.range ?? null;
      if ("root" in source) {
        return await localMedia(
          join(source.root, recording.taskId, "cards", recording.fileName),
          range,
          recording.contentType,
        );
      }
      if (!source.fetchMedia) return new Response(null, { status: 404 });
      return await remoteMedia(recording.fileName, source.fetchMedia, range, recording.contentType);
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return new Response(null, { status: 404 });
}

export function handleFrameProtocol(hosts: FrameHosts): void {
  protocol.handle(APP_FRAME_SCHEME, (request) =>
    answerFrameRequest(request.url, hosts, undefined, {
      method: request.method,
      range: request.headers.get("range"),
    }),
  );
}
