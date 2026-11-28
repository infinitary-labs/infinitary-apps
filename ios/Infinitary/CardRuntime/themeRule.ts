import { frameThemeRule, themeRule } from "../../../src/shared/colorThemes";

/**
 * The phone's color theme on a frame's base (docs/themes.md, "On the phone"): a built-in theme's id, worked out here
 * from the computer's own module, or one of the person's own themes as the computer's tokens, which native code sends
 * only on the base the theme sits on; none draws Dark or Light.
 */
export type PhoneColorTheme = string | Record<string, string> | null | undefined;

export function phoneThemeRule(base: "dark" | "light", theme: PhoneColorTheme): string {
  return theme && typeof theme === "object" ? themeRule(theme) : frameThemeRule(base, theme);
}
