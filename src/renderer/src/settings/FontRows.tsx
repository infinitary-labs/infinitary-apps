import { COMPUTER_FONTS, FONT_SLOTS, type FontSlot, OWN_FONTS } from "@shared/fonts";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { FIRSTMATE_SELECT_STYLE } from "./GeneralTab";
import { SettingRow } from "./settingRows";

/** The picker's value for Infinitary's own font: never a family name. */
const OWN = "";

type LocalFont = { family: string };
type FontQuery = () => Promise<LocalFont[]>;

let installed: Promise<string[]> | undefined;

/**
 * The font families installed on this computer, by name, read once per
 * window through the browser's own list (`queryLocalFonts`, allowed for the
 * window alone, src/main/security/permissions.ts). A family whose name starts
 * with a dot is one the system keeps for itself. None when the list cannot
 * be read: the rows still offer Infinitary's font and the computer's own.
 */
export function installedFonts(): Promise<string[]> {
  installed ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: FontQuery }).queryLocalFonts;
    if (!query) return [];
    try {
      const fonts = await query.call(window);
      const families = new Set(
        fonts.map((font) => font.family).filter((family) => family && !family.startsWith(".")),
      );
      return [...families].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  })();
  return installed;
}

const WORDS: Record<FontSlot, { title: () => string; description: () => string }> = {
  app: { title: m.settingsFontApp, description: m.settingsFontAppDescription },
  reading: { title: m.settingsFontReading, description: m.settingsFontReadingDescription },
  code: { title: m.settingsFontCode, description: m.settingsFontCodeDescription },
};

/** What the picker calls Infinitary's own font for a slot; reading's follows the app's. */
function ownFontLabel(slot: FontSlot): string {
  return slot === "reading"
    ? m.settingsFontSameAsApp()
    : m.settingsFontOwn({ font: OWN_FONTS[slot] });
}

function FontRow({ slot, families }: { slot: FontSlot; families: string[] | null }) {
  const chosen = useShellStore((s) => s.fonts[slot]);
  const setFont = useShellStore((s) => s.setFont);
  const error = useShellStore((s) =>
    s.appearanceError?.choice === "fonts" ? s.appearanceError.message : null,
  );
  const computer = COMPUTER_FONTS[slot];
  // A saved font this computer does not have stays chosen, and says so.
  const missing =
    chosen && chosen !== computer && families !== null && !families.includes(chosen)
      ? chosen
      : null;
  const words = WORDS[slot];
  return (
    <SettingRow
      id={`font-${slot}`}
      error={error}
      title={words.title()}
      description={words.description()}
      control={
        <select
          aria-label={words.title()}
          value={chosen ?? OWN}
          onChange={(event) => setFont(slot, event.target.value || null)}
          style={{
            ...FIRSTMATE_SELECT_STYLE,
            // One width for the three, whichever font each names.
            width: FIRSTMATE_SELECT_STYLE.maxWidth,
            fontFamily: slot === "code" ? "var(--font-mono)" : "var(--font-ui)",
          }}
        >
          <option value={OWN}>{ownFontLabel(slot)}</option>
          <option value={computer}>{m.settingsFontComputer()}</option>
          {missing && <option value={missing}>{m.settingsFontMissing({ font: missing })}</option>}
          {families && families.length > 0 && (
            <optgroup label={m.settingsFontInstalled()}>
              {families.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </optgroup>
          )}
          {/* Until the list is read, a saved font still shows as chosen. */}
          {families === null && chosen && chosen !== computer && (
            <option value={chosen}>{chosen}</option>
          )}
        </select>
      }
    />
  );
}

/**
 * The font rows of Settings → Appearance (docs/fonts.md): the app, reading
 * and code, each Infinitary's own font, this computer's own, or any font
 * installed on it. A choice changes the window at once.
 */
export function FontRows() {
  const [families, setFamilies] = useState<string[] | null>(null);
  useEffect(() => {
    let current = true;
    void installedFonts().then((list) => {
      if (current) setFamilies(list);
    });
    return () => {
      current = false;
    };
  }, []);
  return (
    <>
      {FONT_SLOTS.map((slot) => (
        <FontRow key={slot} slot={slot} families={families} />
      ))}
    </>
  );
}
