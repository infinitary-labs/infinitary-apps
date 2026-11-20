import {
  COMPUTER_LANGUAGES_ATTRIBUTE,
  type FontChoices,
  fontDeclarations,
  fontStyleRule,
  readComputerLanguages,
  scriptOrder,
} from "@shared/fonts";
import { currentLanguage, onLanguageChange } from "@shared/i18n/current";
import { useSyncExternalStore } from "react";

/**
 * The window's fonts (docs/fonts.md): the fonts the captain chose in
 * Settings → Appearance, set as the type tokens' faces on the document, and
 * the script faces after them in the order of the app's language and the
 * computer's own languages. Every view reads the tokens, so it follows at
 * once; a frame carries the same declarations in its stylesheet
 * (`fontFrameStyle`) and is mounted anew when they change (`useFontsDrawn`).
 */

let frameRule = "";
let drawn = 0;
const listeners = new Set<() => void>();

/** The rule a frame's stylesheet ends with, so its tokens take the window's fonts. */
export function fontFrameStyle(): string {
  return frameRule;
}

/** The fonts' count, the same when a card is drawn to a string as in the window. */
const readDrawn = () => drawn;

function onFontsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A number that moves each time the fonts change: a frame mounts anew when
 * it moves, as it does for a new language, since its document is built with
 * the fonts of its birth.
 */
export function useFontsDrawn(): number {
  return useSyncExternalStore(onFontsChange, readDrawn, readDrawn);
}

/** The key hint's room per glyph when Infinitary's own code font draws it (`Button`). */
const KEY_GLYPH_TOKEN = "--key-glyph";

/**
 * How wide one glyph of the chosen code font is at the key hint's size, so
 * a button leaves the key the room it takes rather than JetBrains Mono's.
 * Nothing when the window cannot measure, as under a test's document.
 */
function measuredKeyGlyph(doc: Document): string | null {
  try {
    const context = doc.createElement("canvas").getContext("2d");
    if (!context) return null;
    const style = doc.defaultView?.getComputedStyle(doc.documentElement);
    const mono = style?.getPropertyValue("--font-mono").trim();
    const size = style?.getPropertyValue("--text-sm").trim();
    if (!mono || !size) return null;
    context.font = `500 ${size} ${mono}`;
    const width = context.measureText("0").width;
    return width > 0 ? `${Math.round(width * 100) / 100}px` : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the window in the chosen fonts, now and as the choice or the app's
 * language changes. Answers what stops following.
 */
export function followFonts(
  choice: () => FontChoices,
  subscribe: (listener: () => void) => () => void,
  doc: Document = document,
): () => void {
  const computer = readComputerLanguages(
    doc.documentElement.getAttribute(COMPUTER_LANGUAGES_ATTRIBUTE),
  );
  let applied: Record<string, string> = {};
  const apply = () => {
    const fonts = choice();
    const declarations = fontDeclarations(fonts, scriptOrder(currentLanguage(), computer));
    if (JSON.stringify(declarations) === JSON.stringify(applied)) return;
    const root = doc.documentElement.style;
    for (const name of Object.keys(applied)) root.removeProperty(name);
    for (const [name, value] of Object.entries(declarations)) root.setProperty(name, value);
    applied = declarations;
    const glyph = fonts.code ? measuredKeyGlyph(doc) : null;
    if (glyph) root.setProperty(KEY_GLYPH_TOKEN, glyph);
    else root.removeProperty(KEY_GLYPH_TOKEN);
    frameRule = fontStyleRule(declarations);
    drawn += 1;
    for (const listener of listeners) listener();
  };
  apply();
  const stopChoice = subscribe(apply);
  const stopLanguage = onLanguageChange(apply);
  return () => {
    stopChoice();
    stopLanguage();
  };
}
