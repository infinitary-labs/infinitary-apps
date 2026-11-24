import type { PictureSaveSource } from "@shared/cardFiles";
import { CARD_MEDIA_PIECE_BYTES } from "@shared/cardPictures";
import type { CoreInvokeChannel, InvokeResponse } from "@shared/ipc";

/** Reads one core request through the window's shell, here or on the other computer. */
export type PictureRead = <C extends "inf:cards:picture" | "inf:cards:media">(
  channel: C,
  args: unknown[],
) => Promise<InvokeResponse<C & CoreInvokeChannel>>;

/** Every PNG file starts with these eight bytes. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "image/gif": "gif",
};

/**
 * The file the picture viewer's Save to Downloads saves, and the extension
 * its kind takes: a kept picture or recording read through the home by the
 * name it minted, a recording a piece at a time, or the PNG the window drew,
 * which must be one.
 */
export async function pictureFile(
  source: PictureSaveSource,
  read: PictureRead,
): Promise<{ data: Buffer; extension: string }> {
  if ("png" in source) {
    const data = Buffer.from(source.png, "base64");
    if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
      throw new Error("That is not a PNG picture.");
    return { data, extension: "png" };
  }
  if ("picture" in source) {
    const { contentType, data } = await read("inf:cards:picture", [source.picture]);
    return { data: Buffer.from(data, "base64"), extension: EXTENSION[contentType] ?? "png" };
  }
  const pieces: Buffer[] = [];
  let offset = 0;
  let contentType = "";
  for (;;) {
    const piece = await read("inf:cards:media", [source.demo, offset, CARD_MEDIA_PIECE_BYTES]);
    contentType = piece.contentType;
    const data = Buffer.from(piece.data, "base64");
    pieces.push(data);
    offset += data.length;
    if (data.length === 0 || offset >= piece.size) break;
  }
  const extension = EXTENSION[contentType];
  if (!extension) throw new Error("That is not a demo recording.");
  return { data: Buffer.concat(pieces), extension };
}
