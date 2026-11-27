import {
  COLOR_THEME_ATTRIBUTE,
  COLOR_THEME_SHEET,
  frameThemeRule,
  type OwnThemeColors,
  themeOf,
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

/** The chosen theme, built-in or the person's own, or null for plain Dark or Light. */
let chosen: string | null = null;
/** The person's own themes, which `chosen` may name. */
let own: readonly OwnThemeColors[] = [];
let drawn = 0;
const listeners = new Set<() => void>();

/**
 * The rule a frame's stylesheet ends with, so its tokens take the window's
 * colors: the chosen theme's on a frame drawn in its base, and the base's
 * own on one drawn in the other, such as a picture of either.
 */
export function themeFrameStyle(theme: Theme): string {
  return frameThemeRule(theme, chosen, own);
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
  choice: () => { theme: Theme; colorTheme: string | null; own: readonly OwnThemeColors[] },
  subscribe: (listener: () => void) => () => void,
  doc: Document = document,
): () => void {
  let applied = "";
  const apply = () => {
    const choosing = choice();
    const worked = themeOf(choosing.colorTheme, choosing.own);
    const id = worked?.base === choosing.theme ? choosing.colorTheme : null;
    // An own theme saved again under its name keeps its id: its rule is part of the key.
    const rule = id && worked ? themeRule(worked.tokens) : "";
    const key = `${choosing.theme}:${id ?? ""}:${rule}`;
    if (key === applied) return;
    applied = key;
    let sheet = doc.getElementById(COLOR_THEME_SHEET.id);
    if (id) {
      if (!sheet) {
        sheet = doc.createElement("style");
        sheet.id = COLOR_THEME_SHEET.id;
      }
      // Last in the head on every change, so it follows every color sheet, a late one included.
      doc.head.append(sheet);
      sheet.textContent = rule;
      // A picture of a panel copies the rule and lays it only on this base (src/main/host/panelCapture.ts).
      sheet.setAttribute(COLOR_THEME_SHEET.base, choosing.theme);
      doc.body.setAttribute(COLOR_THEME_ATTRIBUTE, id);
    } else {
      sheet?.remove();
      doc.body.removeAttribute(COLOR_THEME_ATTRIBUTE);
    }
    chosen = id;
    own = choosing.own;
    drawn += 1;
    for (const listener of listeners) listener();
  };
  apply();
  return subscribe(apply);
}
