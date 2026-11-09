import { type FileHandle, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseCardMediaFileName,
  parseCardPictureFileName,
  parseCardTypefaceFileName,
} from "@shared/cardPictures";
import type { InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { CoreServices } from "../coreServices";
import { crewmateCardPicturesDir } from "../paths";

type MediaChannel = "inf:cards:picture" | "inf:cards:typeface" | "inf:cards:media";
type MediaHandlers = {
  [C in MediaChannel]: (...args: InvokeRequest<C>) => Promise<InvokeResponse<C>>;
};

/** The home's copies of card media, read through their minted names. */
export function cardMediaHandlers(services: CoreServices): MediaHandlers {
  return {
    // The home's own copy of a picture a card names, for a view's frames
    // (docs/view.md). Located from the minted name alone, as the frame
    // scheme locates it; a refusal names no path.
    "inf:cards:picture": async (name) => {
      const picture = parseCardPictureFileName(name);
      if (!picture) throw new Error("That is not the name of a card picture.");
      let bytes: Buffer;
      try {
        bytes = await readFile(
          join(crewmateCardPicturesDir(services.paths, picture.taskId), picture.fileName),
        );
      } catch {
        throw new Error("No card picture has that name.");
      }
      return { contentType: picture.contentType, data: bytes.toString("base64") };
    },

    // The home's own copy of a project font a preview names, for a view's
    // frames (docs/view.md), located from the minted name alone as a
    // picture is; a refusal names no path.
    "inf:cards:typeface": async (name) => {
      const typeface = parseCardTypefaceFileName(name);
      if (!typeface) throw new Error("That is not the name of a card's font.");
      let bytes: Buffer;
      try {
        bytes = await readFile(
          join(crewmateCardPicturesDir(services.paths, typeface.taskId), typeface.fileName),
        );
      } catch {
        throw new Error("No card font has that name.");
      }
      return { contentType: typeface.contentType, data: bytes.toString("base64") };
    },

    // A piece of the home's own copy of a card's demo recording, for a
    // view's picture viewer (docs/view.md): located from the minted name
    // alone, read from the offset asked and no further than the file.
    "inf:cards:media": async (name, offset, length) => {
      const recording = parseCardMediaFileName(name);
      if (!recording) throw new Error("That is not the name of a card's recording.");
      const path = join(
        crewmateCardPicturesDir(services.paths, recording.taskId),
        recording.fileName,
      );
      let handle: FileHandle;
      try {
        handle = await open(path, "r");
      } catch {
        throw new Error("No card recording has that name.");
      }
      try {
        const { size } = await handle.stat();
        const piece = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        if (piece.length > 0) await handle.read(piece, 0, piece.length, offset);
        return { contentType: recording.contentType, size, data: piece.toString("base64") };
      } finally {
        await handle.close();
      }
    },
  };
}
