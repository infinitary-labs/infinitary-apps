import {
  CARD_MEDIA_PIECE_BYTES,
  cardDataNames,
  cardSoundNames,
  parseCardDataFileName,
  parseCardMediaFileName,
} from "@shared/cardPictures";
import type { CardPicture } from "@shared/cards";
import type { StagedChangePresentation } from "@shared/changePresentation";
import type { WorkInvokeChannel } from "@shared/ipc";
import type { PlacedTasks } from "./placedTasks";

/** What a placed conversation sends a card's media and a story with. */
export type PlacedMedia = {
  task: string;
  tasks: Pick<PlacedTasks, "picture" | "recording" | "data" | "discardCardCopies">;
  /** One request to the home, its call id added. */
  call: (channel: WorkInvokeChannel, fields: object, signal: AbortSignal) => Promise<unknown>;
};

/** Each picture's bytes first, so the home holds them when it shows the card. */
export async function sendPictures(
  media: PlacedMedia,
  pictures: readonly CardPicture[],
  signal: AbortSignal,
): Promise<void> {
  for (const picture of pictures) {
    const { extension, data } = media.tasks.picture(media.task, picture.id);
    await media.call(
      "inf:work:picture",
      { id: picture.id, extension, data: data.toString("base64") },
      signal,
    );
    if (!picture.demo) continue;
    const { id, kind } = picture.demo;
    const recording = media.tasks.recording(media.task, id, kind);
    for (let offset = 0; offset < recording.length; offset += CARD_MEDIA_PIECE_BYTES) {
      await media.call(
        "inf:work:media",
        {
          id,
          extension: kind,
          offset,
          size: recording.length,
          data: recording.subarray(offset, offset + CARD_MEDIA_PIECE_BYTES).toString("base64"),
        },
        signal,
      );
    }
  }
}

/**
 * Each sound clip of this task's own that a card body plays
 * (docs/card-authoring.md, "Sound clips"), sent before the card as a card's
 * media, a piece at a time, so the home holds it when the captain presses
 * Listen. Only a home that lists `card-sound-clips` keeps one.
 */
export async function sendCardSounds(
  media: PlacedMedia,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  for (const name of cardSoundNames(body)) {
    const clip = parseCardMediaFileName(name);
    if (clip?.taskId !== media.task) continue;
    const id = name.slice(0, name.lastIndexOf("."));
    const bytes = media.tasks.recording(media.task, id, clip.kind);
    for (let offset = 0; offset < bytes.length; offset += CARD_MEDIA_PIECE_BYTES) {
      await media.call(
        "inf:work:media",
        {
          id,
          extension: clip.kind,
          offset,
          size: bytes.length,
          data: bytes.subarray(offset, offset + CARD_MEDIA_PIECE_BYTES).toString("base64"),
        },
        signal,
      );
    }
  }
}

/**
 * Each data file of this task's own that a card body names (docs/card-authoring.md,
 * "Data by reference"), sent before the card as a card's media, a piece at a
 * time, so the home holds it when the card's script asks. Work admission
 * requires the home's own contract major, which keeps such a file and hands
 * it over.
 */
export async function sendCardData(
  media: PlacedMedia,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  const files = cardDataNames(body).flatMap((name) => {
    const data = parseCardDataFileName(name);
    return data?.taskId === media.task ? [data] : [];
  });
  for (const { id, fileName } of files) {
    const bytes = media.tasks.data(media.task, fileName);
    for (let offset = 0; offset < bytes.length; offset += CARD_MEDIA_PIECE_BYTES) {
      await media.call(
        "inf:work:media",
        {
          id,
          extension: "json",
          offset,
          size: bytes.length,
          data: bytes.subarray(offset, offset + CARD_MEDIA_PIECE_BYTES).toString("base64"),
        },
        signal,
      );
    }
  }
}

/**
 * prepare_change's and show_merge_card's story on its way to the home: its
 * pictures travel first, and its staged copies go once it is sent. Work
 * admission requires the home's own contract major, which reads a story's
 * validation rows, map view and free-form part.
 */
export async function carryStory(
  media: PlacedMedia,
  story: StagedChangePresentation | undefined,
  signal: AbortSignal,
  send: () => Promise<string>,
): Promise<string> {
  try {
    if (story) await sendPictures(media, story.pictures, signal);
    return await send();
  } finally {
    if (story)
      await media.tasks
        .discardCardCopies(
          media.task,
          story.assets.map((asset) => asset.file),
        )
        .catch(() => {
          console.warn("Could not remove transferred story staging copies", media.task);
        });
  }
}
