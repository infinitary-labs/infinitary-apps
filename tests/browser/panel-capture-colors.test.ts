import { builtInTheme, frameThemeRule, themeOf, themeRule } from "@shared/colorThemes";
import type { SavedOwnTheme } from "@shared/ownColorThemes";
import { expect, test } from "vitest";
import {
  buildCaptureHtml,
  type CaptureColorSheet,
  type CaptureTheme,
} from "../../src/main/host/panelCaptureDocument";
import colors from "../../src/renderer/src/design/tokens/colors.css?raw";

/**
 * The color themes plan (INF-6888, part 1): Dark and Light stay as they are,
 * and so does a picture the app takes of either; a chosen theme shows only
 * on its own base. `capture_panel` copies the window's CSS, with its color
 * theme sheet, and each panel frame's CSS, with the rule it was born with,
 * into a hidden document drawn in Dark and then Light. Each picture must
 * read its own base's colors, or the chosen theme on that theme's base.
 */

const DARK_ACCENT = "#7fdcff";
const LIGHT_ACCENT = "#0e8fd0";
const DRACULA_ACCENT = "#bd93f9";
// Part 2: a person's own theme, the trial's old green terminal, whose accent the app keeps as asked.
const TERMINAL: SavedOwnTheme = {
  id: "own-old-terminal",
  name: "Old terminal",
  colors: {
    background: "#020a03",
    text: "#3ddc5a",
    accent: "#8dff9c",
    hot: "#ffd23d",
    danger: "#ff5a4d",
    captain: "#b99aff",
  },
};
const TERMINAL_ACCENT = "#8dff9c";

type Chosen = "dracula" | "own-old-terminal" | null;

/** What the window and a panel frame born in Dark hold, as `capture_panel` copies them. */
function copied(colorTheme: Chosen) {
  const tokens =
    colorTheme === "own-old-terminal"
      ? themeOf(colorTheme, [TERMINAL])?.tokens
      : colorTheme && builtInTheme(colorTheme).tokens;
  const rule = tokens ? themeRule(tokens) : "";
  return {
    css: `${colors}\n${rule}`,
    frameCss: `${colors}\n${frameThemeRule("dark", colorTheme, [TERMINAL])}`,
    colorSheet: (colorTheme ? { rule, base: "dark" } : null) satisfies CaptureColorSheet | null,
  };
}

/** `--accent` in the capture document and in its panel frame, as drawn. */
async function drawnAccents(
  theme: CaptureTheme,
  colorTheme: Chosen,
): Promise<{ window: string; frame: string }> {
  const { css, frameCss, colorSheet } = copied(colorTheme);
  const html = buildCaptureHtml({
    css,
    panelHtml:
      '<section data-side-panel="tokyo-clock"><div data-capture-frame="0"></div></section>',
    frames: [{ css: frameCss, bodyHtml: "<p>Tokyo 9:05</p>", width: 280, height: 40 }],
    theme,
    colorTheme,
    colorSheet,
    width: 280,
    height: 120,
  });
  const holder = document.createElement("iframe");
  document.body.append(holder);
  try {
    await new Promise<void>((resolve) => {
      holder.addEventListener("load", () => resolve(), { once: true });
      holder.srcdoc = html;
    });
    const inner = holder.contentDocument?.querySelector("iframe");
    if (!inner) throw new Error("The capture document drew no panel frame");
    if (inner.contentDocument?.readyState !== "complete")
      await new Promise((resolve) => inner.addEventListener("load", resolve, { once: true }));
    const accent = (doc: Document | null | undefined) =>
      doc?.body ? getComputedStyle(doc.body).getPropertyValue("--accent").trim().toLowerCase() : "";
    return { window: accent(holder.contentDocument), frame: accent(inner.contentDocument) };
  } finally {
    holder.remove();
  }
}

test("a panel's pictures read Dark's and Light's own colors when no color theme is chosen", async () => {
  expect(await drawnAccents("dark", null)).toEqual({ window: DARK_ACCENT, frame: DARK_ACCENT });
  expect(await drawnAccents("light", null)).toEqual({ window: LIGHT_ACCENT, frame: LIGHT_ACCENT });
});

test("a panel's pictures show a chosen theme on its own base and the other base's own colors", async () => {
  expect(await drawnAccents("dark", "dracula")).toEqual({
    window: DRACULA_ACCENT,
    frame: DRACULA_ACCENT,
  });
  expect(await drawnAccents("light", "dracula")).toEqual({
    window: LIGHT_ACCENT,
    frame: LIGHT_ACCENT,
  });
});

test("a panel's pictures show a person's own theme on its base and the other base's own colors", async () => {
  expect(await drawnAccents("dark", "own-old-terminal")).toEqual({
    window: TERMINAL_ACCENT,
    frame: TERMINAL_ACCENT,
  });
  expect(await drawnAccents("light", "own-old-terminal")).toEqual({
    window: LIGHT_ACCENT,
    frame: LIGHT_ACCENT,
  });
});
