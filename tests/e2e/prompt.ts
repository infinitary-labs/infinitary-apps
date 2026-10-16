import type { Locator, Page } from "@playwright/test";
import { encodePng } from "./pictureFixtures";

/**
 * The home screen's task prompt, found by its name (`VoiceInput`'s
 * `name="task-prompt"`), never by its placeholder or by being the page's
 * first input: the placeholder is copy that moves with first run, voice
 * support and the gate (`src/shared/firstRun.ts`), and a card that asks its
 * questions inline carries inputs of its own. A spec that means to assert
 * the placeholder itself reads it from `firstRun.ts`. By name, not by tag:
 * the field is a multi-line textarea (docs/composer.md).
 */
export const TASK_PROMPT_SELECTOR = '[name="task-prompt"]';

export function promptInput(page: Page): Locator {
  return page.locator(TASK_PROMPT_SELECTOR);
}

/** A real picture fixture, also used to check what reached the provider after a paste. */
export const PASTE_PICTURE_PNG_BASE64 = encodePng(16, 16, () => [40, 120, 200]).toString("base64");

/** Paste real picture files through the field, whether it is the task prompt or a card reply. */
export async function pastePictures(
  field: Locator,
  pictures: Array<{ name: string; bytes?: number }>,
): Promise<void> {
  await field.evaluate(
    (input, { pictures, base64 }) => {
      const png = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const clipboardData = new DataTransfer();
      for (const picture of pictures) {
        const bytes = picture.bytes ? new Uint8Array(picture.bytes) : png;
        clipboardData.items.add(new File([bytes], picture.name, { type: "image/png" }));
      }
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    { pictures, base64: PASTE_PICTURE_PNG_BASE64 },
  );
}

/**
 * Hands real, disk-backed File objects to a drop on `target` - the task
 * prompt's shell or a card's reply row - and resolves once dispatched. The
 * browser builds them from the files on disk (`setInputFiles`), so
 * Electron's `webUtils.getPathForFile` answers with their true paths, which
 * a synthetic `new File()` never proves.
 */
export async function dropFiles(page: Page, target: Locator, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("__fm_files")?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "__fm_files";
    document.body.append(input);
  });
  await page.locator("#__fm_files").setInputFiles(paths);
  await target.evaluate((element) => {
    const input = document.getElementById("__fm_files") as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      element.dispatchEvent(
        new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    }
  });
}
