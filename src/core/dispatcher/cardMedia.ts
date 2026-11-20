import { type FileHandle, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CARD_DATA_TYPE,
  CARD_LOG_TYPES,
  parseCardDataFileName,
  parseCardLogFileName,
  parseCardMediaFileName,
  parseCardPictureFileName,
  parseCardTypefaceFileName,
} from "@shared/cardPictures";
import type { InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { CoreServices } from "../coreServices";
import { crewmateCardPicturesDir } from "../paths";

type MediaChannel =
  | "inf:cards:picture"
  | "inf:cards:typeface"
  | "inf:cards:media"
  | "inf:cards:data"
  | "inf:cards:log";
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

    // The home's own copy of a card's data file, for the frame that asks
    // the bridge for it (docs/card-authoring.md, "Data by reference") in a
    // window, a view or a phone: located from the minted name alone, as a
    // picture is; a refusal names no path.
    "inf:cards:data": async (name) => {
      const data = parseCardDataFileName(name);
      if (!data) throw new Error("That is not the name of a card's data file.");
      let text: string;
      try {
        text = await readFile(
          join(crewmateCardPicturesDir(services.paths, data.taskId), data.fileName),
          "utf8",
        );
      } catch {
        throw new Error("No card data file has that name.");
      }
      return { contentType: CARD_DATA_TYPE, data: text };
    },

    // The home's own copy of a proof log a merge card names, for a view's or
    // a phone's log reader (docs/card-authoring.md "Proof logs"), located
    // from the kept name alone as a picture is; a refusal names no path.
    "inf:cards:log": async (name) => {
      const log = parseCardLogFileName(name);
      if (!log) throw new Error("That is not the name of a proof log.");
      let bytes: Buffer;
      try {
        bytes = await readFile(
          join(crewmateCardPicturesDir(services.paths, log.taskId), log.fileName),
        );
      } catch {
        throw new Error("No proof log has that name.");
      }
      return {
        contentType:
          log.contentType === CARD_LOG_TYPES.json ? CARD_LOG_TYPES.json : CARD_LOG_TYPES.txt,
        data: bytes.toString("base64"),
      };
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
