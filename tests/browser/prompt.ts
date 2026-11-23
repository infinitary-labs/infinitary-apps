import { type Locator, page } from "vitest/browser";

/**
 * The window's message box as a browser test reads and feeds it
 * (docs/composer.md).
 */

/**
 * The message box as the window draws it now, read by its name each time:
 * its hint changes as the window learns how this computer hears dictation,
 * so a locator built from the hint loses it.
 */
export function messageBox(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[name="task-prompt"]');
}

/**
 * The message box as the browser's user events reach it: by its role and
 * accessible name, which stay put while its hint changes. A user event given
 * the field itself finds it by its hint, which the field refits to its width
 * and font (ComposerField), so on a computer whose fonts measure differently
 * the hint can change between finding the field and pressing on it, and the
 * press then finds nothing.
 */
export function messageBoxLocator(): Locator {
  return page.getByRole("textbox", { name: "Task prompt", exact: true });
}

export async function picturePng(): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The page has no 2D canvas");
  context.fillStyle = "rgb(40, 120, 200)";
  context.fillRect(0, 0, 16, 16);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The canvas encoded no PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Bytes as base64 without a data: prefix, as a turn carries a picture. */
export function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function pastePictures(
  field: HTMLElement,
  png: Uint8Array<ArrayBuffer>,
  pictures: Array<{ name: string; bytes?: number }>,
): void {
  const clipboardData = new DataTransfer();
  for (const picture of pictures) {
    const bytes = picture.bytes ? new Uint8Array(picture.bytes) : png;
    clipboardData.items.add(new File([bytes], picture.name, { type: "image/png" }));
  }
  field.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
}
