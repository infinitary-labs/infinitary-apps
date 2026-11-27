import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  type BuiltInThemeId,
  builtInTheme,
  shippedTokens,
  shownTheme,
} from "@shared/colorThemes";
import * as m from "@shared/i18n/messages.generated";
import type { Theme } from "@shared/preferences";
import type { CSSProperties } from "react";
import { useShellStore } from "../app/store";

type Tile = { value: Theme | BuiltInThemeId; label: string; tokens: Record<string, string> };

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
 * The Theme row's choices as one group of tiles: Dark, Light and each
 * built-in theme under its maker's name. They are native radios of one name,
 * so the arrow keys move the pick and every pick applies at once.
 */
export function ThemeTiles() {
  const theme = useShellStore((s) => s.theme);
  const colorTheme = useShellStore((s) => s.colorTheme);
  const setTheme = useShellStore((s) => s.setTheme);
  const setColorTheme = useShellStore((s) => s.setColorTheme);
  const value = shownTheme(colorTheme, theme) ?? theme;
  const tiles: Tile[] = [
    { value: "dark", label: m.settingsAppearanceThemeDark(), tokens: shippedTokens("dark") },
    { value: "light", label: m.settingsAppearanceThemeLight(), tokens: shippedTokens("light") },
    ...BUILT_IN_THEME_IDS.map((id) => ({
      value: id,
      label: BUILT_IN_THEMES[id].name,
      tokens: builtInTheme(id).tokens,
    })),
  ];
  return (
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
      {tiles.map((tile) => {
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
                // A maker's name is never cut short: a long one, or one at a larger Size, wraps.
                overflowWrap: "anywhere",
              }}
            >
              {tile.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
