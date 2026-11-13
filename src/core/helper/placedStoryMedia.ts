import { CARD_MEDIA_PIECE_BYTES, cardDataNames, parseCardDataFileName } from "@shared/cardPictures";
import type { CardPicture } from "@shared/cards";
import type { StagedChangePresentation } from "@shared/changePresentation";
import { HOME } from "@shared/deviceNames";
import type { WorkInvokeChannel } from "@shared/ipc";
import { contractChange, listsChange } from "../connection/contractChanges";
import type { PlacedTasks } from "./placedTasks";

/** What a placed conversation sends a card's media and a story with. */
export type PlacedMedia = {
  task: string;
  tasks: Pick<PlacedTasks, "picture" | "recording" | "data" | "discardCardCopies">;
  homeChanges?: () => readonly string[] | null;
  /** One request to the home, its call id added. */
  call: (channel: WorkInvokeChannel, fields: object, signal: AbortSignal) => Promise<unknown>;
};

const STORY_MAP = contractChange("story-map");
const CARD_DATA = contractChange("card-data");
const LIVE_VALIDATION_TABLE = contractChange("live-validation-table");
const STORY_PART = contractChange("story-part");

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
    // A poster's recording follows it, a piece at a time.
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
 * Each data file of this task's own that a card body names (docs/card-authoring.md,
 * "Data by reference"), sent before the card as a card's media, a piece at a
 * time, so the home holds it when the card's script asks. A home without
 * `card-data` could not hand it over, so the card is refused before anything
 * is sent.
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
  if (files.length === 0) return;
  if (!listsChange(media.homeChanges?.(), CARD_DATA))
    throw new Error(
      `Card data refused: ${HOME.the} runs an older Infinitary that cannot hand a card its data file; put the data in the body until it is updated. Nothing was sent.`,
    );
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
 * prepare_change's and show_merge_card's story on its way to the home: a
 * story an older home cannot read is refused before anything is sent, its
 * pictures travel first, and its staged copies go once it is sent.
 */
export async function carryStory(
  media: PlacedMedia,
  story: StagedChangePresentation | undefined,
  signal: AbortSignal,
  send: () => Promise<string>,
): Promise<string> {
  try {
    if (story?.validationRows && !listsChange(media.homeChanges?.(), LIVE_VALIDATION_TABLE))
      throw new Error(
        `Live validation rows need a newer Infinitary on ${HOME.the}; update it before preparing this story. Nothing was sent.`,
      );
    if (
      story?.views.some((view) => view.map !== undefined) &&
      !listsChange(media.homeChanges?.(), STORY_MAP)
    )
      throw new Error(
        `A map view needs a newer Infinitary on ${HOME.the}; update it before preparing this story. Nothing was sent.`,
      );
    if (story?.whatChangedPart !== undefined && !listsChange(media.homeChanges?.(), STORY_PART))
      throw new Error(
        `A free-form part needs a newer Infinitary on ${HOME.the}; update it before preparing this story. Nothing was sent.`,
      );
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
