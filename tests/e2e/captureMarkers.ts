import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import type { UiSize } from "../../src/shared/preferences";
import { settled } from "./layout";

/**
 * Synthetic boundary fixtures for the picture helpers (`./pictures`): a
 * marker in each corner of a region, drawn over the window, and a decoder
 * that counts each marker's pixels in a picture. Markers test the capture,
 * not the region's design.
 */

/** A marker color per corner of the region, far from anything the app draws. */
export const CORNERS = {
  "top-left": [255, 0, 255],
  "top-right": [0, 255, 0],
  "bottom-right": [255, 255, 0],
  "bottom-left": [0, 255, 255],
} as const;

/**
 * Draws one marker inside each corner of the region's box, over the window,
 * once the box holds still: after a Size change the region can still be
 * moving into place, and a picture of it would then miss markers drawn early.
 */
export async function markCorners(page: Page, region: Locator) {
  const box = await settled(() => region.boundingBox());
  if (!box) throw new Error("The region is not on screen");
  await page.evaluate(
    ({ box, corners }) => {
      for (const marker of document.querySelectorAll("[data-capture-marker]")) marker.remove();
      const side = 10;
      const right = box.x + box.width - side;
      const bottom = box.y + box.height - side;
      const places = {
        "top-left": [box.x, box.y],
        "top-right": [right, box.y],
        "bottom-right": [right, bottom],
        "bottom-left": [box.x, bottom],
      };
      for (const [name, [red, green, blue]] of Object.entries(corners)) {
        const [left, top] = places[name as keyof typeof places];
        const marker = document.createElement("div");
        marker.dataset.captureMarker = name;
        marker.style.cssText = `position:fixed;z-index:9999;pointer-events:none;left:${left}px;top:${top}px;width:${side}px;height:${side}px;background:rgb(${red},${green},${blue})`;
        document.body.append(marker);
      }
    },
    { box, corners: CORNERS },
  );
}

/**
 * The size choice, made where a person makes it: Settings → Appearance,
 * returning once the window is zoomed to it.
 */
export async function chooseSize(app: ElectronApplication, page: Page, size: UiSize) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: `${size}%`, exact: true }).check();
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
      ),
    )
    .toBe(size / 100);
}

/**
 * Reads the markers in a PNG or WebP picture, decoded by the app's own
 * Chromium: how many pixels of each it holds, and which marker each corner of
 * the picture shows a few pixels in from its edges, or null. A picture
 * cropped to the marked region shows each corner's marker in its own corner.
 */
export function readMarkers(
  page: Page,
  picture: Buffer,
  markers: Record<string, readonly number[]> = CORNERS,
) {
  return page.evaluate(
    async ({ data, markers }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas to decode the picture");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const marker = (at: number) =>
        Object.entries(markers).find(([, color]) =>
          color.every((value, channel) => Math.abs(value - (pixels[at + channel] ?? 0)) < 70),
        )?.[0] ?? null;
      const counts = Object.fromEntries(Object.keys(markers).map((name) => [name, 0]));
      for (let at = 0; at < pixels.length; at += 4) {
        const name = marker(at);
        if (name) counts[name] = (counts[name] ?? 0) + 1;
      }
      const inset = 3;
      const right = bitmap.width - 1 - inset;
      const bottom = bitmap.height - 1 - inset;
      const pixel = (x: number, y: number) => marker((y * bitmap.width + x) * 4);
      const corners = {
        "top-left": pixel(inset, inset),
        "top-right": pixel(right, inset),
        "bottom-right": pixel(right, bottom),
        "bottom-left": pixel(inset, bottom),
      };
      return { counts, corners };
    },
    { data: picture.toString("base64"), markers },
  );
}
