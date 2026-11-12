import { inLanguage, setCurrentLanguage } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { LanguageRow } from "./AppearanceTab";

/**
 * The captain's third answer on the language plan's review: on a view of
 * another computer the Language row says it sets only this window's words,
 * since the crew follows the first mate's computer; on that computer it says
 * it sets the crew's words too.
 */

afterEach(() => setCurrentLanguage("en"));

function rowMarkup(view: boolean, language: string): string {
  setCurrentLanguage(language);
  return renderToStaticMarkup(<LanguageRow computer="en" view={view} />);
}

it("says on a view that the language sets only this window's words, in English and a chosen language", () => {
  for (const language of ["en", "ja"]) {
    const view = rowMarkup(true, language);
    expect(view).toContain(inLanguage(language, () => m.settingsLanguageDescriptionView()));
    expect(view).not.toContain(inLanguage(language, () => m.settingsLanguageDescription()));
    const home = rowMarkup(false, language);
    expect(home).toContain(inLanguage(language, () => m.settingsLanguageDescription()));
    expect(home).not.toContain(inLanguage(language, () => m.settingsLanguageDescriptionView()));
  }
});
