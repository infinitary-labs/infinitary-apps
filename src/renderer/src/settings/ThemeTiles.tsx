import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  builtInTheme,
  shippedTokens,
  shownTheme,
  themeOf,
} from "@shared/colorThemes";
import * as m from "@shared/i18n/messages.generated";
import type { CSSProperties } from "react";
import { mainMessageRefusal } from "../app/composer";
import { useShellStore } from "../app/store";
import { Button } from "../design";

type Tile = { value: string; label: string; tokens: Record<string, string> };

/** The unseen radio a tile holds; the tile draws its focus (design/styles.css). */
const UNSEEN: CSSProperties = {
  position: "absolute",
  inset: 0,
  opacity: 0,
  margin: 0,
  cursor: "inherit",
  appearance: "none",
};

function tileStyle(checked: boolean): CSSProperties {
  return {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    padding: "var(--space-2)",
    borderRadius: "var(--radius-m)",
    border: `1px solid ${checked ? "var(--accent)" : "var(--line-1)"}`,
    background: checked ? "var(--accent-dim)" : "transparent",
    cursor: "pointer",
    minWidth: 0,
  };
}

/**
 * A small window in the tile's own colors, drawn whatever the window wears:
 * its background, a card with a line of text, and the calm, working and
 * person's colors (docs/themes.md).
 */
function Swatch({ tokens }: { tokens: Record<string, string> }) {
  const dot = (color: string | undefined): CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
  });
  return (
    <span
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "flex-end",
        height: 44,
        padding: 6,
        borderRadius: "var(--radius-s)",
        background: tokens["--bg-0"],
        border: `1px solid ${tokens["--line-1"]}`,
      }}
    >
      <span
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 6px",
          borderRadius: 4,
          background: tokens["--bg-2"],
        }}
      >
        <span style={{ flex: 1, height: 3, borderRadius: 2, background: tokens["--fg-1"] }} />
        <span style={dot(tokens["--accent"])} />
        <span style={dot(tokens["--hot"])} />
        <span style={dot(tokens["--captain"])} />
      </span>
    </span>
  );
}

/**
 * Describe your own (docs/themes.md, "Your own themes"): home, with the
 * message box starting the ask to the first mate and the caret after it,
 * for the person to describe the look. Nothing is sent from here. Refused,
 * as Go to the main message is, while the box is held.
 */
function describeOwnTheme(): void {
  const shell = useShellStore.getState();
  if (mainMessageRefusal(shell) !== null) return;
  shell.focusMainMessage();
  shell.beginDraft(m.settingsAppearanceThemeOwnDraft());
}

/**
 * The Theme row's choices as one group of tiles: Dark, Light, each built-in
 * theme under its maker's name, then the person's own under Yours, each
 * under the name they gave it. They are native radios of one name, so the
 * arrow keys move the pick and every pick applies at once. Below them,
 * Remove takes away the own theme the window wears, and Describe your own
 * starts the ask to the first mate.
 */
export function ThemeTiles() {
  const theme = useShellStore((s) => s.theme);
  const colorTheme = useShellStore((s) => s.colorTheme);
  const own = useShellStore((s) => s.ownColorThemes);
  const setTheme = useShellStore((s) => s.setTheme);
  const setColorTheme = useShellStore((s) => s.setColorTheme);
  const removeOwn = useShellStore((s) => s.removeOwnColorTheme);
  const value = shownTheme(colorTheme, theme, own) ?? theme;
  const ownChosen = own.find((saved) => saved.id === value);
  const ownTiles: Tile[] = own.flatMap((saved) => {
    const worked = themeOf(saved.id, own);
    return worked ? [{ value: saved.id, label: saved.name, tokens: worked.tokens }] : [];
  });
  const tiles: Tile[] = [
    { value: "dark", label: m.settingsAppearanceThemeDark(), tokens: shippedTokens("dark") },
    { value: "light", label: m.settingsAppearanceThemeLight(), tokens: shippedTokens("light") },
    ...BUILT_IN_THEME_IDS.map((id) => ({
      value: id,
      label: BUILT_IN_THEMES[id].name,
      tokens: builtInTheme(id).tokens,
    })),
  ];
  const tile = (tile: Tile) => {
    const checked = tile.value === value;
    return (
      <label key={tile.value} data-theme-tile={tile.value} style={tileStyle(checked)}>
        <input
          type="radio"
          name="appearance-theme"
          value={tile.value}
          checked={checked}
          onChange={() => {
            if (checked) return;
            if (tile.value === "dark" || tile.value === "light") setTheme(tile.value);
            else setColorTheme(tile.value);
          }}
          style={UNSEEN}
        />
        <Swatch tokens={tile.tokens} />
        <span
          style={{
            fontFamily: "var(--font-ui)",
            fontSize: "var(--text-xs)",
            fontWeight: 500,
            color: checked ? "var(--fg-1)" : "var(--fg-2)",
            // A name is never cut short: a long one, or one at a larger Size, wraps.
            overflowWrap: "anywhere",
          }}
        >
          {tile.label}
        </span>
      </label>
    );
  };
  return (
    <>
      <div
        role="radiogroup"
        aria-label={m.settingsAppearanceTheme()}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(124px, 1fr))",
          gap: "var(--space-2)",
          marginTop: "var(--space-3)",
        }}
      >
        {tiles.map(tile)}
        {ownTiles.length > 0 && (
          <span
            data-theme-yours=""
            style={{
              gridColumn: "1 / -1",
              marginTop: "var(--space-2)",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--text-xs)",
              fontWeight: 500,
              color: "var(--fg-3)",
            }}
          >
            {m.settingsAppearanceThemeYours()}
          </span>
        )}
        {ownTiles.map(tile)}
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        {ownChosen && (
          <span data-theme-own-remove="">
            <Button
              variant="secondary"
              aria-description={m.settingsAppearanceThemeOwnRemoveNamed({ name: ownChosen.name })}
              onClick={() => removeOwn(ownChosen.id)}
            >
              {m.settingsAppearanceThemeOwnRemove()}
            </Button>
          </span>
        )}
        <span data-theme-own-describe="">
          <Button variant="secondary" onClick={describeOwnTheme}>
            {m.settingsAppearanceThemeOwnDescribe()}
          </Button>
        </span>
      </div>
    </>
  );
}
