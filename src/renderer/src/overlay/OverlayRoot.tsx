import { currentLanguage, onLanguageChange } from "@shared/i18n/current";
import { useSyncExternalStore } from "react";
import { CardOverlay } from "./CardOverlay";

/** The overlay, drawn in the page's language, as `LanguageRoot` draws the window. */
export function OverlayRoot() {
  const language = useSyncExternalStore(onLanguageChange, currentLanguage);
  return <CardOverlay key={language} />;
}
