import {
  type BuiltInThemeId,
  builtInTheme,
  COLOR_THEME_ATTRIBUTE,
  frameThemeRule,
  shownTheme,
  themeRule,
} from "@shared/colorThemes";
import type { Theme } from "@shared/preferences";
import { useSyncExternalStore } from "react";

/**
 * The window's color theme (docs/themes.md): the chosen theme's tokens laid
 * over the color sheets by one rule in a sheet of its own, after them. Dark
 * and Light are the sheets themselves, so they lay nothing. A frame carries
 * the same rule at its birth (`themeFrameStyle`) and hears every later one
 * with the theme over the bridge (frameController's `setTheme`), so an open
 * card or panel follows without being built again.
 */

const SHEET_ID = "inf-color-theme";

/** The chosen built-in theme, or null for plain Dark or Light. */
let chosen: BuiltInThemeId | null = null;
let drawn = 0;
const listeners = new Set<() => void>();

/**
 * The rule a frame's stylesheet ends with, so its tokens take the window's
 * colors: the chosen theme's on a frame drawn in its base, and the base's
 * own on one drawn in the other, such as a picture of either.
 */
export function themeFrameStyle(theme: Theme): string {
  return frameThemeRule(theme, chosen);
}

const readDrawn = () => drawn;

function onColorsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that moves each time the window's colors change, base or theme. */
export function useThemeColorsDrawn(): number {
  return useSyncExternalStore(onColorsChange, readDrawn, readDrawn);
}

/**
 * Lays the chosen theme over the window and keeps following it. The base's
 * own attribute stays `applyTheme`'s (./preferences); this writes the sheet
 * and the theme's own attribute, so a drawing that reads colors only when
 * the theme changes reads them again.
 */
export function followColorTheme(
  choice: () => { theme: Theme; colorTheme: string | null },
  subscribe: (listener: () => void) => () => void,
  doc: Document = document,
): () => void {
  let applied = "";
  const apply = () => {
    const { theme, colorTheme } = choice();
    const id = shownTheme(colorTheme, theme);
    const key = `${theme}:${id ?? ""}`;
    if (key === applied) return;
    applied = key;
    let sheet = doc.getElementById(SHEET_ID);
    if (id) {
      if (!sheet) {
        sheet = doc.createElement("style");
        sheet.id = SHEET_ID;
      }
      // Last in the head on every change, so it follows every color sheet, a late one included.
      doc.head.append(sheet);
      sheet.textContent = themeRule(builtInTheme(id).tokens);
      doc.body.setAttribute(COLOR_THEME_ATTRIBUTE, id);
    } else {
      sheet?.remove();
      doc.body.removeAttribute(COLOR_THEME_ATTRIBUTE);
    }
    chosen = id;
    drawn += 1;
    for (const listener of listeners) listener();
  };
  apply();
  return subscribe(apply);
}
