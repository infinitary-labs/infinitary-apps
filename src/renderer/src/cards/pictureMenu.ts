import type { PictureSaveSource } from "@shared/cardFiles";
import {
  CARD_MEDIA_HOST,
  CARD_PICTURE_HOST,
  isDrawingSource,
  isPlayableDemoSource,
  parseCardPictureFileName,
} from "@shared/cardPictures";
import { APP_FRAME_SCHEME } from "@shared/csp";
import type { ViewerMenu, ViewerPicture } from "../design/cards/PictureViewer";
import { base64Of, readable } from "./markedPictures";

/**
 * Copy and Save on the picture viewer's menu (the design skill's
 * PictureViewer, "The picture's menu"). The picture is read the way a marked
 * picture is (`readable`): the frame scheme's copy is another origin's,
 * which a drawing surface refuses to give back.
 */

/** A diagram is copied and saved at twice its own size, so its words stay sharp. */
const DRAWING_SCALE = 2;

const PICTURE_PREFIX = `${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/`;
const MEDIA_PREFIX = `${APP_FRAME_SCHEME}://${CARD_MEDIA_HOST}/`;

/** The picture at its own pixels as a PNG; a diagram at twice its size, on the ground it has in the card. */
async function png(src: string): Promise<Blob> {
  const picture = await readable(src);
  const drawing = isDrawingSource(src);
  const scale = drawing ? DRAWING_SCALE : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(picture.naturalWidth * scale);
  canvas.height = Math.round(picture.naturalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0 || canvas.height === 0) throw new Error();
  if (drawing) {
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg-1");
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(picture, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error();
  return blob;
}

async function copy(picture: ViewerPicture): Promise<void> {
  // The clipboard takes the item while the press that asked still counts: the PNG follows.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png(picture.src) })]);
}

/** What the window's own process reads to save: a kept file by its minted name, else the PNG drawn here. */
async function saveSource(src: string): Promise<PictureSaveSource> {
  if (src.startsWith(PICTURE_PREFIX)) {
    const name = src.slice(PICTURE_PREFIX.length);
    if (parseCardPictureFileName(name)) return { picture: name };
  }
  if (src.startsWith(MEDIA_PREFIX) && isPlayableDemoSource(src))
    return { demo: src.slice(MEDIA_PREFIX.length) };
  return { png: await base64Of(await png(src)) };
}

async function save(src: string, name: string): Promise<string> {
  const saved = await window.infinitary.cards.savePicture(name, await saveSource(src));
  return saved.savedAs;
}

export function pictureMenu(saveKeys: ViewerMenu["saveKeys"]): ViewerMenu {
  return { copy, save, saveKeys };
}
