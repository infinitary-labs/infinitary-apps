import { HERE } from "@shared/deviceNames";
import { UI_SIZES, type UiSize } from "@shared/preferences";
import { useEffect } from "react";
import type { AppearanceChoice } from "../app/appearance";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { GroupedPills, Switch } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { isView } from "../devices/viewWords";
import { ROW_GAP, SectionLabel, SettingRow } from "./settingRows";

/**
 * What the Size row says changes the size besides it: the keys Make
 * everything larger and Make everything smaller have now, in this
 * keyboard's words, or nothing when neither has one (docs/keyboard.md,
 * "Key hints").
 */
function sizeKeysWords(larger: string | undefined, smaller: string | undefined): string {
  if (larger && smaller) return ` ${larger} and ${smaller} change the same size.`;
  const one = larger ?? smaller;
  return one ? ` ${one} changes the same size.` : "";
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
      <SectionLabel>Appearance</SectionLabel>
      {isView(thisMac) && (
        <p
          data-own-look=""
          style={{ margin: "-4px 0 12px", fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
        >
          Set on {HERE.this} only. {thisMac.name} keeps its own.
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        <SettingRow
          id="size"
          error={errorFor("size")}
          title="Size"
          description={`Make text and everything around it larger.${sizeKeysWords(largerKeys.keys, smallerKeys.keys)}`}
          control={
            <GroupedPills
              name="Size"
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
          title="Default card size"
          description="Choose how cards open. You can still resize each card."
          control={
            <GroupedPills
              name="Default card size"
              htmlName="default-card-size"
              value={defaultCardSize}
              options={[
                { value: "usual", label: "Usual" },
                { value: "wide", label: "Wide" },
                { value: "full", label: "Full" },
                { value: "maximized", label: "Maximized" },
              ]}
              onChange={setDefaultCardSize}
            />
          }
        />
        <SettingRow
          id="keep-cards-maximized"
          error={errorFor("keepCardsMaximized")}
          title="Keep cards maximized"
          description="After you maximize a card, every card stays maximized until you restore one."
          control={
            <Switch
              checked={keepCardsMaximized}
              aria-label="Keep cards maximized"
              onChange={setKeepCardsMaximized}
            />
          }
        />
        <SettingRow
          id="theme"
          error={errorFor("theme")}
          title="Theme"
          description="Deep-space dark, or daylight light."
          control={
            <GroupedPills
              name="Theme"
              htmlName="appearance-theme"
              value={theme}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
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
            title="Window wash"
            description="How much of the theme color covers the blurred background. 0% is the default."
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
                  aria-label="Window wash"
                  aria-valuetext={`${washStrength}% opacity`}
                  onChange={(event) => setWashStrength(Number(event.target.value))}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span
                  style={{ minWidth: "3ch", textAlign: "right", fontFamily: "var(--font-mono)" }}
                >
                  {washStrength}%
                </span>
              </label>
            }
          />
        )}
        <SettingRow
          id="crew-model-names"
          error={errorFor("showCrewModelNames")}
          title="Crew model names"
          description="Show model names while crewmates use only one orbit."
          control={
            <Switch
              checked={showCrewModelNames}
              aria-label="Crew model names"
              onChange={setShowCrewModelNames}
            />
          }
        />
      </div>
    </div>
  );
}
