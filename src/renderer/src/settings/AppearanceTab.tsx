import { HERE } from "@shared/deviceNames";
import { currentLanguage } from "@shared/i18n/current";
import { ownLanguageName, SOURCE_LANGUAGE } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
import { choosableLanguages, FOLLOWS_COMPUTER } from "@shared/i18n/start";
import { UI_SIZES, type UiSize } from "@shared/preferences";
import { useEffect, useRef, useState } from "react";
import type { AppearanceChoice } from "../app/appearance";
import { useCommandKeys } from "../app/keyHints";
import { notePickerChange, takePickerFocus, windowDefaultLanguage } from "../app/language";
import { useShellStore } from "../app/store";
import { GroupedPills, Switch } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { isView } from "../devices/viewWords";
import { FontRows } from "./FontRows";
import { FIRSTMATE_SELECT_STYLE } from "./GeneralTab";
import { ROW_GAP, SectionLabel, SettingRow } from "./settingRows";

/** The language picker's value for no choice, the default language: never a language tag. */
const NO_CHOICE = "";

/**
 * Keys that step a closed picker from one language to the next: on Linux
 * each step changes the picker's value at once, so such a change is only a
 * draft until Enter or leaving the picker applies it.
 */
const STEP_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * The language row (docs/i18n.md, "The language choice"): the default
 * language, or one of the catalog's languages, each named in its own words.
 * The default is English until the app follows the computer
 * (`FOLLOWS_COMPUTER`), when it names the computer's language instead. On a
 * view the choice sets only this window's words, since the crew follows the
 * first mate's computer.
 */
export function LanguageRow({ computer, view }: { computer: string; view: boolean }) {
  const language = useShellStore((s) => s.language);
  const setLanguage = useShellStore((s) => s.setLanguage);
  const error = useShellStore((s) =>
    s.appearanceError?.choice === "language" ? s.appearanceError.message : null,
  );
  const choices = choosableLanguages();
  const value = language && choices.includes(language) ? language : NO_CHOICE;
  // A language stepped to by the keyboard and not applied yet.
  const [draft, setDraft] = useState<string | null>(null);
  const stepping = useRef(false);
  const picker = useRef<HTMLSelectElement | null>(null);
  const apply = (next: string) => {
    setDraft(null);
    if (next === value) return;
    notePickerChange(picker.current !== null && picker.current === document.activeElement);
    // The window is drawn again in the new language; Settings stays on this tab.
    useShellStore.setState({ settingsSection: "appearance" });
    setLanguage(next === NO_CHOICE ? null : next);
  };
  const description = view ? m.settingsLanguageDescriptionView() : m.settingsLanguageDescription();
  return (
    <SettingRow
      id="language"
      error={error}
      title={m.settingsLanguage()}
      description={
        currentLanguage() === SOURCE_LANGUAGE ? (
          description
        ) : (
          <>
            <span style={{ display: "block" }}>{description}</span>
            <span style={{ display: "block" }} data-language-partial="">
              {m.settingsLanguagePartial()}
            </span>
          </>
        )
      }
      control={
        <select
          ref={(element) => {
            picker.current = element;
            if (element && takePickerFocus()) element.focus();
          }}
          aria-label={m.settingsLanguage()}
          value={draft ?? value}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft !== null) {
              event.preventDefault();
              apply(draft);
            } else if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              setDraft(null);
            } else if (STEP_KEYS.has(event.key) || event.key.length === 1) {
              // A change this key makes comes in the same task; a pick from
              // the picker's open list comes later and applies at once.
              stepping.current = true;
              setTimeout(() => {
                stepping.current = false;
              }, 0);
            }
          }}
          onChange={(event) => {
            if (stepping.current) setDraft(event.target.value);
            else apply(event.target.value);
          }}
          onBlur={() => {
            if (draft !== null) apply(draft);
          }}
          style={{ ...FIRSTMATE_SELECT_STYLE, fontFamily: "var(--font-ui)" }}
        >
          <option value={NO_CHOICE}>
            {FOLLOWS_COMPUTER
              ? m.settingsLanguageFollow({ language: ownLanguageName(computer) })
              : m.settingsLanguageDefault({ language: ownLanguageName(SOURCE_LANGUAGE) })}
          </option>
          {choices.map((tag) => (
            <option key={tag} value={tag} lang={tag}>
              {ownLanguageName(tag)}
            </option>
          ))}
        </select>
      }
    />
  );
}

/**
 * What the Size row says changes the size besides it: the keys Make
 * everything larger and Make everything smaller have now, in this
 * keyboard's words, or nothing when neither has one (docs/keyboard.md,
 * "Key hints").
 */
function sizeDescription(larger: string | undefined, smaller: string | undefined): string {
  if (larger && smaller) return m.settingsAppearanceSizeDescriptionKeys({ larger, smaller });
  const one = larger ?? smaller;
  return one
    ? m.settingsAppearanceSizeDescriptionKey({ key: one })
    : m.settingsAppearanceSizeDescription();
}

export function AppearanceTab() {
  const desktop = thisDesktop();
  const largerKeys = useCommandKeys("size.larger");
  const smallerKeys = useCommandKeys("size.smaller");
  const size = useShellStore((s) => s.size);
  const setSize = useShellStore((s) => s.setSize);
  const defaultCardSize = useShellStore((s) => s.defaultCardSize);
  const setDefaultCardSize = useShellStore((s) => s.setDefaultCardSize);
  const keepCardsMaximized = useShellStore((s) => s.keepCardsMaximized);
  const setKeepCardsMaximized = useShellStore((s) => s.setKeepCardsMaximized);
  const theme = useShellStore((s) => s.theme);
  const setTheme = useShellStore((s) => s.setTheme);
  const washStrength = useShellStore((s) => s.washStrength);
  const setWashStrength = useShellStore((s) => s.setWashStrength);
  const showCrewModelNames = useShellStore((s) => s.showCrewModelNames);
  const setShowCrewModelNames = useShellStore((s) => s.setShowCrewModelNames);
  // On a Mac controlling another, its look is its own (docs/view.md).
  const thisMac = useShellStore((s) => s.thisMac);
  // A refused choice is told beside its own control, over the saved look.
  const appearanceError = useShellStore((s) => s.appearanceError);
  const errorFor = (choice: AppearanceChoice) =>
    appearanceError?.choice === choice ? appearanceError.message : null;
  // Opening reads the saved look again, so reopening shows what is saved.
  useEffect(() => {
    useShellStore.getState().refreshAppearance();
  }, []);
  return (
    <div>
      <SectionLabel>{m.settingsAppearanceHeading()}</SectionLabel>
      {isView(thisMac) && (
        <p
          data-own-look=""
          style={{ margin: "-4px 0 12px", fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
        >
          {m.settingsAppearanceOwnLook({ place: HERE.this, computer: thisMac.name })}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        <SettingRow
          id="size"
          error={errorFor("size")}
          title={m.settingsAppearanceSize()}
          description={sizeDescription(largerKeys.keys, smallerKeys.keys)}
          control={
            <GroupedPills
              name={m.settingsAppearanceSize()}
              htmlName="appearance-size"
              value={String(size)}
              options={UI_SIZES.map((value) => ({
                value: String(value),
                label: <span style={{ fontFamily: "var(--font-mono)" }}>{value}%</span>,
              }))}
              onChange={(value) => setSize(Number(value) as UiSize)}
            />
          }
        />
        <SettingRow
          id="default-card-size"
          error={errorFor("defaultCardSize")}
          title={m.settingsAppearanceCardSize()}
          description={m.settingsAppearanceCardSizeDescription()}
          control={
            <GroupedPills
              name={m.settingsAppearanceCardSize()}
              htmlName="default-card-size"
              value={defaultCardSize}
              options={[
                { value: "usual", label: m.settingsAppearanceCardUsual() },
                { value: "wide", label: m.settingsAppearanceCardWide() },
                { value: "full", label: m.settingsAppearanceCardFull() },
                { value: "maximized", label: m.settingsAppearanceCardMaximized() },
              ]}
              onChange={setDefaultCardSize}
            />
          }
        />
        <SettingRow
          id="keep-cards-maximized"
          error={errorFor("keepCardsMaximized")}
          title={m.settingsAppearanceKeepMaximized()}
          description={m.settingsAppearanceKeepMaximizedDescription()}
          control={
            <Switch
              checked={keepCardsMaximized}
              aria-label={m.settingsAppearanceKeepMaximized()}
              onChange={setKeepCardsMaximized}
            />
          }
        />
        <SettingRow
          id="theme"
          error={errorFor("theme")}
          title={m.settingsAppearanceTheme()}
          description={m.settingsAppearanceThemeDescription()}
          control={
            <GroupedPills
              name={m.settingsAppearanceTheme()}
              htmlName="appearance-theme"
              value={theme}
              options={[
                { value: "dark", label: m.settingsAppearanceThemeDark() },
                { value: "light", label: m.settingsAppearanceThemeLight() },
              ]}
              onChange={setTheme}
            />
          }
        />
        {/* Only a window over the system's material has a wash (docs/translucent-window.md). */}
        {desktop.material && (
          <SettingRow
            id="window-wash"
            error={errorFor("washStrength")}
            title={m.settingsAppearanceWash()}
            description={m.settingsAppearanceWashDescription()}
            control={
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  color: "var(--fg-2)",
                  fontFamily: "var(--font-ui)",
                  fontSize: "var(--text-sm)",
                }}
              >
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={washStrength}
                  aria-label={m.settingsAppearanceWash()}
                  aria-valuetext={m.settingsAppearanceWashValue({ percent: String(washStrength) })}
                  onChange={(event) => setWashStrength(Number(event.target.value))}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span style={{ minWidth: "3ch", textAlign: "end", fontFamily: "var(--font-mono)" }}>
                  {washStrength}%
                </span>
              </label>
            }
          />
        )}
        <SettingRow
          id="crew-model-names"
          error={errorFor("showCrewModelNames")}
          title={m.settingsAppearanceCrewModelNames()}
          description={m.settingsAppearanceCrewModelNamesDescription()}
          control={
            <Switch
              checked={showCrewModelNames}
              aria-label={m.settingsAppearanceCrewModelNames()}
              onChange={setShowCrewModelNames}
            />
          }
        />
        {/* Below the rows above, so they stay on screen in the smallest window. */}
        <FontRows />
        {/* Last, so the rows above stay on screen in the smallest window. */}
        <LanguageRow computer={windowDefaultLanguage()} view={isView(thisMac)} />
      </div>
    </div>
  );
}
