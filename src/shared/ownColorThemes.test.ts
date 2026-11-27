import { describe, expect, it } from "vitest";
import { ACTIONS } from "./actions";
import { shippedTokens, themeOf } from "./colorThemes";
import { checkOwnTheme, type OwnThemeAsk } from "./ownColorThemes";
import type { Appearance } from "./preferences";

// The approved plan for color themes (INF-6888, part 2): a person's own theme is made by
// asking the first mate. Its five sample asks are the fixtures, each as the plan's trial wrote
// it from one sentence: the old green terminal saves; Solarized dark has its text lifted to
// 7:1 and is sent back for danger too close to hot; soft pink and dim grey are sent back for
// hot too close to accent; all orange for hot and danger both too close to accent.

const TERMINAL: OwnThemeAsk = {
  name: "Old terminal",
  colors: {
    background: "#020a03",
    text: "#3ddc5a",
    accent: "#8dff9c",
    hot: "#ffd23d",
    danger: "#ff5a4d",
  },
};
const SOLARIZED: OwnThemeAsk = {
  name: "Solar",
  colors: {
    background: "#002b36",
    text: "#93a1a1",
    accent: "#2aa198",
    hot: "#cb4b16",
    danger: "#dc322f",
    captain: "#6c71c4",
  },
};
const SOFT_PINK: OwnThemeAsk = {
  name: "Soft pink",
  colors: { background: "#fdf3f1", text: "#7a5d63", accent: "#e58fa6", hot: "#f0a35c" },
};
const DIM_GREY: OwnThemeAsk = {
  name: "Dim",
  colors: { background: "#1c1c1c", text: "#5a5a5a", accent: "#6a7a8a", hot: "#8a7a6a" },
};
const ALL_ORANGE: OwnThemeAsk = {
  name: "Pumpkin",
  colors: { background: "#140a02", text: "#ffe6cc", accent: "#ff9a3d", hot: "#ffa257" },
};

const refusal = (ask: OwnThemeAsk) => {
  const checked = checkOwnTheme(ask);
  if (!("refusal" in checked)) throw new Error(`${ask.name} saved`);
  return checked.refusal;
};

describe("checking a person's own theme", () => {
  it("saves the old green terminal, filling captain from Dark and naming what it moved", () => {
    const checked = checkOwnTheme(TERMINAL);
    if ("refusal" in checked) throw new Error(checked.refusal);
    expect(checked.theme).toEqual({
      id: "own-old-terminal",
      name: "Old terminal",
      colors: { ...TERMINAL.colors, captain: shippedTokens("dark")["--captain"] },
    });
    expect(checked.worked.base).toBe("dark");
    expect(checked.worked.moved).toEqual([
      expect.stringMatching(/^quiet text #[0-9a-f]{6} → #[0-9a-f]{6} to reach 4\.5:1$/),
      expect.stringMatching(/^faint text #[0-9a-f]{6} → #[0-9a-f]{6} to reach 3:1$/),
    ]);
  });

  it("sends Solarized dark back for danger too close to hot, its text lifted to 7:1", () => {
    const words = refusal(SOLARIZED);
    expect(words).toMatch(
      /^The theme was not saved, and nothing changed\. danger #[0-9a-f]{6} is too close to hot #[0-9a-f]{6}/,
    );
    expect(words).toMatch(/text #93a1a1 → #[0-9a-f]{6} to reach 7:1/);
    expect(words).not.toMatch(/too close to accent/);
  });

  it("sends soft pink and dim grey back for hot too close to accent", () => {
    for (const ask of [SOFT_PINK, DIM_GREY]) {
      const words = refusal(ask);
      expect(words).toMatch(/hot #[0-9a-f]{6} is too close to accent/);
      expect(words).not.toMatch(/danger #[0-9a-f]{6} is too close/);
    }
  });

  it("sends all orange back for hot and danger both too close to accent", () => {
    const words = refusal(ALL_ORANGE);
    expect(words).toMatch(/hot #ffa257 is too close to accent #ff9a3d/);
    expect(words).toMatch(/danger #[0-9a-f]{6} is too close to accent #ff9a3d/);
  });

  it("takes the colors left out from a built-in theme named in like", () => {
    const checked = checkOwnTheme({
      name: "Mocha teal",
      like: "catppuccin-mocha",
      colors: { accent: "#94e2d5" },
    });
    if ("refusal" in checked) throw new Error(checked.refusal);
    expect(checked.theme.colors).toEqual({
      background: "#1e1e2e",
      text: "#cdd6f4",
      accent: "#94e2d5",
      hot: "#fab387",
      danger: "#f38ba8",
      captain: "#89b4fa",
    });
  });

  it("refuses an ask with no background and accent, or a like no built-in theme has", () => {
    expect(refusal({ name: "Blank", colors: { text: "#ffffff" } })).toMatch(
      /Give background and accent, or like a built-in theme\./,
    );
    expect(refusal({ name: "Sol", like: "solarized", colors: {} })).toMatch(
      /No built-in theme solarized\. Built-in: rose-pine,/,
    );
  });
});

const own = ACTIONS["own-theme"];
const theme = ACTIONS.theme;
const apply = (line: typeof own | typeof theme, value: Record<string, unknown>, look: Appearance) =>
  line.toRequest(value, look, (path) => path)[0] as Appearance;
const start: Appearance = { theme: "light", washStrength: 20, colorTheme: "one-light" };

describe("the first mate's own color themes", () => {
  it("saves a described theme and wears it at once on its base, naming what the app moved", () => {
    const look = apply(own, { save: TERMINAL }, start);
    expect(look).toMatchObject({ theme: "dark", colorTheme: "own-old-terminal", washStrength: 20 });
    expect(look.ownColorThemes?.map((saved) => saved.name)).toEqual(["Old terminal"]);
    const value = own.readValue(look);
    expect(value).toMatchObject({
      saved: [{ id: "own-old-terminal", name: "Old terminal" }],
      chosen: "own-old-terminal",
    });
    expect(value.moved).toHaveLength(2);
    expect(own.done(value)).toBe("your own color themes: Old terminal");
  });

  it("changes the same theme when saved under its name", () => {
    const first = apply(own, { save: TERMINAL }, start);
    const amber = apply(
      own,
      {
        save: {
          ...TERMINAL,
          name: "old terminal",
          colors: { ...TERMINAL.colors, accent: "#7fd6ff" },
        },
      },
      first,
    );
    expect(amber.ownColorThemes).toHaveLength(1);
    expect(amber.ownColorThemes?.[0]?.colors.accent).toBe("#7fd6ff");
    expect(themeOf("own-old-terminal", amber.ownColorThemes)?.tokens["--accent"]).toBe("#7fd6ff");
  });

  it("refuses a faulty theme in words and leaves the look as it was", () => {
    expect(() => apply(own, { save: ALL_ORANGE }, start)).toThrow(
      /^The theme was not saved, and nothing changed\. hot #ffa257 is too close to accent/,
    );
  });

  it("removes a theme by its name, and a window wearing it keeps its base", () => {
    const saved = apply(own, { save: TERMINAL }, start);
    const removed = apply(own, { remove: "OLD TERMINAL" }, saved);
    expect(removed).toEqual({ theme: "dark", washStrength: 20, ownColorThemes: [] });
    expect(() => apply(own, { remove: "Old terminal" }, removed)).toThrow(
      "No own theme Old terminal. Saved: none.",
    );
    // A theme removed while another is worn leaves that one on.
    const worn = apply(theme, { theme: "dracula" }, saved);
    expect(apply(own, { remove: "own-old-terminal" }, worn).colorTheme).toBe("dracula");
  });

  it("lets the theme line wear an own theme by its id and refuses one not saved", () => {
    const saved = apply(own, { save: TERMINAL }, start);
    const elsewhere = apply(theme, { theme: "light" }, saved);
    expect(apply(theme, { theme: "own-old-terminal" }, elsewhere)).toMatchObject({
      theme: "dark",
      colorTheme: "own-old-terminal",
    });
    expect(() => apply(theme, { theme: "own-nothing" }, elsewhere)).toThrow(
      /^No theme own-nothing\. Themes: dark, light, rose-pine, .*, tokyo-night, own-old-terminal\.$/,
    );
    // Activity names an own theme as the person said it, never by its id.
    expect(theme.done(theme.readValue(saved))).toBe("switched to the Old terminal theme");
  });
});
