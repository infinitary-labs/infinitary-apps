import { setComputerLocale, setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import { bootPanel } from "../runtime";

// The one module a panel document loads (`app-frame://lib/boot.mjs`).
// The document is born with the app's language as its `lang`
// (frameDocument.ts), so the lib's own words speak it before the panel draws
// (docs/i18n.md, "The language fact"), and with the locale its dates take as
// `data-locale`, so the lib's dates in English take the computer's forms
// (docs/i18n.md, "Dates and times").
setCurrentLanguage(document.documentElement.lang || SOURCE_LANGUAGE);
setComputerLocale(document.documentElement.getAttribute("data-locale"));
void bootPanel();
