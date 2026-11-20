import { currentLanguage, onLanguageChange } from "@shared/i18n/current";
import { useSyncExternalStore } from "react";
import { App } from "./App";

/**
 * The window, drawn in the language the page speaks (docs/i18n.md, "The
 * language choice"). A word is worded when it is drawn, so a change of
 * language draws the whole window again from the start: every word in it
 * and every frame's document follow, while what the shell store holds - the
 * open view, the cards, the board - stays. The language picker that made the
 * change takes its focus back itself (`notePickerChange`).
 */
export function LanguageRoot() {
  const language = useSyncExternalStore(onLanguageChange, currentLanguage);
  return <App key={language} />;
}
