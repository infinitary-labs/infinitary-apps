import { MEDIA_PROBE_DEADLINE_MS } from "@core/pi/cardImages";

/**
 * The font half of the host's probe (`./mediaProbe.ts`; docs/card-authoring.md
 * "Fonts by reference"), as plain text and plain functions, so it is read
 * and tested without a window: the script a probe page runs over a card's
 * fonts, and how the page's console names the font its sanitizer refused.
 */

/** How long each font may take to load in the probe page before it is refused, on its own clock. */
export const TYPEFACE_LOAD_MS = MEDIA_PROBE_DEADLINE_MS;

/**
 * How long the probe window itself may take to answer for all of a card's
 * fonts: each font's own limit, and room to open the page.
 */
export const TYPEFACE_WINDOW_MS = TYPEFACE_LOAD_MS + 2_000;

/** Words for a probe window that gave no answer at all: about every font of the card, never one of them. */
export const TYPEFACES_UNANSWERED = "none of the card's fonts finished loading";

/**
 * The script a probe page runs: loads each of a card's fonts as a web font,
 * all at once, each against its own `limitMs`, which hands each to the same
 * sanitizer a card's frame does. It answers one result per font in order, so
 * a refusal names the font that failed or stalled, and a font that does not
 * load is a refusal rather than a preview that silently draws in another face.
 */
export function typefaceScript(urls: readonly string[], limitMs = TYPEFACE_LOAD_MS): string {
  return `(async () => {
  const limit = ${limitMs};
  const loaded = await Promise.all(${JSON.stringify(urls)}.map((file, index) =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, reason: "it did not load within " + limit / 1000 + " seconds" }),
        limit,
      );
      new FontFace("probe" + index, "url(" + file + ")").load().then(
        () => { clearTimeout(timer); resolve({ ok: true }); },
        () => { clearTimeout(timer); resolve({ ok: false, reason: "it did not load" }); },
      );
    }),
  ));
  return { ok: true, loaded };
})()`;
}

/** The font Chromium could not decode, and its sanitizer's own words for why, as its console writes them. */
const UNDECODED_FONT = /Failed to decode downloaded font: (\S+)/;
const SANITIZER_MESSAGE = /OTS parsing error: (.+)/;

/** Each refused font's sanitizer words, by its place in the list: each message follows the font it is about. */
export function sanitizerReasons(
  said: readonly string[],
  urls: readonly string[],
): Map<number, string> {
  const reasons = new Map<number, string>();
  let about = -1;
  for (const message of said) {
    const undecoded = UNDECODED_FONT.exec(message)?.[1];
    if (undecoded) about = urls.indexOf(undecoded);
    const reason = SANITIZER_MESSAGE.exec(message)?.[1]?.trim();
    if (reason && about !== -1 && !reasons.has(about)) {
      reasons.set(about, `its sanitizer said: ${reason}`);
    }
  }
  return reasons;
}
