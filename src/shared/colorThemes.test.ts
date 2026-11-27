import { describe, expect, it } from "vitest";
import {
  APART,
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  type BuiltInThemeId,
  builtInTheme,
  colorDistance,
  contrast,
  FLOORS,
  frameThemeRule,
  shownTheme,
  workOutTheme,
} from "./colorThemes";

// The approved plan for color themes (INF-6888): each built-in theme is six
// colors, worked out into every token with readability floors and distances.
// The expected tokens were worked out by the plan's own lab script, a separate
// implementation, from the same six colors.
const WORKED_OUT: Record<
  BuiltInThemeId,
  {
    base: "dark" | "light";
    bg0: string;
    bg2: string;
    fg1: string;
    fg3: string;
    accent: string;
    hot: string;
    onAccent: string;
  }
> = {
  "rose-pine": {
    base: "dark",
    bg0: "#191724",
    bg2: "#292341",
    fg1: "#e0def4",
    fg3: "#7a778e",
    accent: "#9ccfd8",
    hot: "#f6c177",
    onAccent: "#191724",
  },
  "rose-pine-moon": {
    base: "dark",
    bg0: "#232136",
    bg2: "#332f51",
    fg1: "#e0def4",
    fg3: "#87839b",
    accent: "#9ccfd8",
    hot: "#f6c177",
    onAccent: "#232136",
  },
  "rose-pine-dawn": {
    base: "light",
    bg0: "#faf4ed",
    bg2: "#ffffff",
    fg1: "#544e75",
    fg3: "#8f89b4",
    accent: "#56949f",
    // Its gold #ea9d34 reaches only 2.2:1 on white, so it is darkened to reach 3:1.
    hot: "#d08405",
    onAccent: "#05070d",
  },
  "catppuccin-latte": {
    base: "light",
    bg0: "#eff1f5",
    bg2: "#ffffff",
    fg1: "#4c4f69",
    fg3: "#8689a6",
    accent: "#8839ef",
    hot: "#fd6309",
    onAccent: "#ffffff",
  },
  "catppuccin-frappe": {
    base: "dark",
    bg0: "#303446",
    bg2: "#3d4467",
    // Its text #c6d0f5 reaches less than 7:1 on its brightest surface, so it is lifted.
    fg1: "#e7edff",
    fg3: "#939bbf",
    accent: "#ca9ee6",
    hot: "#ef9f76",
    onAccent: "#303446",
  },
  "catppuccin-macchiato": {
    base: "dark",
    bg0: "#24273a",
    bg2: "#313658",
    fg1: "#ccd6f8",
    fg3: "#828baa",
    accent: "#c6a0f6",
    hot: "#f5a97f",
    onAccent: "#24273a",
  },
  "catppuccin-mocha": {
    base: "dark",
    bg0: "#1e1e2e",
    bg2: "#2c2b4d",
    fg1: "#cdd6f4",
    fg3: "#78819b",
    accent: "#cba6f7",
    hot: "#fab387",
    onAccent: "#1e1e2e",
  },
  "one-dark": {
    base: "dark",
    bg0: "#282c34",
    bg2: "#343d4e",
    fg1: "#d7deec",
    fg3: "#8692a8",
    accent: "#61afef",
    hot: "#d19a66",
    onAccent: "#282c34",
  },
  "one-light": {
    base: "light",
    bg0: "#eaeaeb",
    bg2: "#f8f8f8",
    fg1: "#383a42",
    fg3: "#80869d",
    accent: "#4078f2",
    hot: "#c18401",
    onAccent: "#05070d",
  },
  dracula: {
    base: "dark",
    bg0: "#282a36",
    bg2: "#363954",
    fg1: "#f8f8f2",
    fg3: "#919178",
    accent: "#bd93f9",
    hot: "#ffb86c",
    onAccent: "#282a36",
  },
  "night-owl": {
    base: "dark",
    bg0: "#011627",
    bg2: "#03263e",
    fg1: "#d6deeb",
    fg3: "#6c788d",
    accent: "#82aaff",
    hot: "#ffcb8b",
    onAccent: "#011627",
  },
  "night-owl-light": {
    base: "light",
    bg0: "#f0f0f0",
    bg2: "#fefefe",
    fg1: "#403f53",
    fg3: "#8a88a1",
    accent: "#2aa298",
    hot: "#b78e00",
    onAccent: "#05070d",
  },
  "tokyo-night": {
    base: "dark",
    bg0: "#1a1b26",
    bg2: "#282942",
    fg1: "#c0caf5",
    fg3: "#727ba2",
    accent: "#7aa2f7",
    hot: "#e0af68",
    onAccent: "#1a1b26",
  },
};

describe("the color math", () => {
  it("measures contrast as WCAG does", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    // #767676 is the lightest gray that reaches 4.5:1 on white.
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("measures distance in OKLab, where black and white are 1 apart", () => {
    expect(colorDistance("#000000", "#ffffff")).toBeCloseTo(1, 3);
    expect(colorDistance("#7fdcff", "#7fdcff")).toBe(0);
  });
});

describe("the built-in themes", () => {
  it("are the thirteen the captain chose, under their makers' names", () => {
    expect(BUILT_IN_THEME_IDS).toEqual([
      "rose-pine",
      "rose-pine-moon",
      "rose-pine-dawn",
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha",
      "one-dark",
      "one-light",
      "dracula",
      "night-owl",
      "night-owl-light",
      "tokyo-night",
    ]);
    expect(BUILT_IN_THEMES["catppuccin-frappe"].name).toBe("Catppuccin Frappé");
    expect(BUILT_IN_THEMES["rose-pine"].name).toBe("Rosé Pine");
  });

  for (const id of BUILT_IN_THEME_IDS) {
    it(`works ${id} out as the plan's lab did`, () => {
      const want = WORKED_OUT[id];
      const theme = builtInTheme(id);
      expect({
        base: theme.base,
        bg0: theme.tokens["--bg-0"],
        bg2: theme.tokens["--bg-2"],
        fg1: theme.tokens["--fg-1"],
        fg3: theme.tokens["--fg-3"],
        accent: theme.tokens["--accent"],
        hot: theme.tokens["--hot"],
        onAccent: theme.tokens["--on-accent"],
      }).toEqual(want);
      expect(theme.faults).toEqual([]);
    });

    it(`holds ${id} to every floor and distance`, () => {
      const t = builtInTheme(id).tokens as Record<string, string>;
      const worst = builtInTheme(id).base === "dark" ? t["--bg-3"] : t["--bg-0"];
      const on = (a: string | undefined, b: string | undefined) => contrast(a ?? "", b ?? "");
      expect(on(t["--fg-1"], worst)).toBeGreaterThanOrEqual(7);
      expect(on(t["--fg-2"], worst)).toBeGreaterThanOrEqual(4.5);
      expect(on(t["--fg-3"], worst)).toBeGreaterThanOrEqual(3);
      for (const state of ["--accent", "--hot", "--danger", "--captain"]) {
        expect(on(t[state], t["--bg-2"])).toBeGreaterThanOrEqual(3);
      }
      expect(on(t["--on-accent"], t["--accent"])).toBeGreaterThanOrEqual(4.5);
      const apart = (a: string, b: string) => colorDistance(t[a] ?? "", t[b] ?? "");
      expect(apart("--accent", "--hot")).toBeGreaterThanOrEqual(0.12);
      expect(apart("--accent", "--danger")).toBeGreaterThanOrEqual(0.12);
      expect(apart("--hot", "--danger")).toBeGreaterThanOrEqual(0.06);
    });
  }

  it("states the plan's floors and distances", () => {
    expect(FLOORS).toEqual({ text: 7, quietText: 4.5, faintText: 3, state: 3, onAccent: 4.5 });
    expect(APART).toEqual({ accentHot: 0.12, accentDanger: 0.12, hotDanger: 0.06 });
  });
});

describe("working out a theme", () => {
  it("names a hot color too close to the accent as a fault", () => {
    const { faults } = workOutTheme({
      background: "#1e1e2e",
      text: "#cdd6f4",
      accent: "#89b4fa",
      hot: "#8aadf4",
      danger: "#f38ba8",
      captain: "#cba6f7",
    });
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/^hot .* is too close to accent/);
  });

  it("lifts text that misses its floor and says so", () => {
    const { tokens, moved } = workOutTheme({
      background: "#303446",
      text: "#c6d0f5",
      accent: "#ca9ee6",
      hot: "#ef9f76",
      danger: "#e78284",
      captain: "#8caaee",
    });
    expect(tokens["--fg-1"]).toBe("#e7edff");
    expect(moved.some((line) => line.startsWith("text #c6d0f5 → #e7edff"))).toBe(true);
  });
});

describe("which theme a look shows", () => {
  it("shows a built-in theme only on its own base", () => {
    expect(shownTheme("dracula", "dark")).toBe("dracula");
    // A Light picture of a window wearing Dracula shows plain Light (INF-5511).
    expect(shownTheme("dracula", "light")).toBeNull();
    expect(shownTheme("one-light", "light")).toBe("one-light");
  });

  it("shows the base for a name this build lacks", () => {
    expect(shownTheme("solarized", "dark")).toBeNull();
    expect(shownTheme(null, "light")).toBeNull();
  });

  it("gives a frame the theme's accent, or the base's own", () => {
    expect(frameThemeRule("dark", "dracula")).toContain("--accent: #bd93f9;");
    expect(frameThemeRule("light", "dracula")).toContain("--accent: #0e8fd0;");
    expect(frameThemeRule("dark", null)).toContain("--accent: #7fdcff;");
    expect(frameThemeRule("dark", null)).toMatch(
      /^:root, \[data-theme="light"\], \[data-theme="dark"\] \{/,
    );
  });
});
