import { z } from "zod";
import type { ActionLine } from "./actions";
import { BUILT_IN_THEME_IDS, BUILT_IN_THEMES, builtInTheme, isBuiltInTheme } from "./colorThemes";
import { type Appearance, themeSchema } from "./preferences";
import { themeChoiceValue } from "./settingValues";

/** What the theme line takes: Dark, Light, or a built-in color theme's id (docs/themes.md). */
const THEME_CHOICES: readonly string[] = ["dark", "light", ...BUILT_IN_THEME_IDS];

const themeChoiceSchema = z.strictObject({
  theme: z.string().refine((id) => THEME_CHOICES.includes(id), {
    // i18n-exempt: served to the first mate, a model, never shown
    message: `Choose one of ${THEME_CHOICES.join(", ")}.`,
  }),
});
type ThemeChoice = z.infer<typeof themeChoiceSchema>;

/** Settings → Appearance's Theme row as the first mate's line (primitives/app-actions.md). */
export const themeLines = {
  theme: {
    fields: ["theme", "colorTheme"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: themeChoiceSchema,
    // i18n-exempt: served to the first mate, a model, never shown
    line: `The window's color theme when asked, preserving size, window wash and crew model names: dark, light, or a built-in theme by its id (${BUILT_IN_THEME_IDS.map((id) => `${id} for ${BUILT_IN_THEMES[id].name}`).join(", ")}). A theme changes colors only. Each computer's window keeps its own; the phone keeps its own Theme setting.`,
    // A built-in theme saves its base as the theme, so whatever knows only Dark and Light follows it.
    toRequest: (v, c) => {
      const { colorTheme: _was, ...look } = c as Appearance;
      const { theme } = v as ThemeChoice;
      return [
        isBuiltInTheme(theme)
          ? { ...look, theme: builtInTheme(theme).base, colorTheme: theme }
          : { ...look, theme: themeSchema.parse(theme) },
      ];
    },
    readValue: themeChoiceValue,
    done: (v) => {
      const { theme } = v as ThemeChoice;
      return `switched to the ${isBuiltInTheme(theme) ? BUILT_IN_THEMES[theme].name : theme} theme`;
    },
  },
} as const satisfies Record<string, ActionLine>;
