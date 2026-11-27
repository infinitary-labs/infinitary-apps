import type { OwnThemeAsk } from "../../../src/shared/ownColorThemes";
import type { Scenario } from "../mockProvider";

/** The person's ask for a theme of their own, as the approved plan's trial words it. */
export const OWN_THEME_PROMPT = "make my window look like an old green terminal";
/** Their ask to change it. */
export const OWN_THEME_BLUE_PROMPT = "make the old terminal's accent sky blue";
/** An ask the app sends back: every color in one orange. */
export const OWN_THEME_ORANGE_PROMPT = "make it all orange like a pumpkin";
/** Their ask to remove it. */
export const OWN_THEME_REMOVE_PROMPT = "remove my old terminal theme";

/** The old green terminal the plan's trial first mate wrote from one sentence. */
export const TERMINAL: OwnThemeAsk = {
  name: "Old terminal",
  colors: {
    background: "#020a03",
    text: "#3ddc5a",
    accent: "#8dff9c",
    hot: "#ffd23d",
    danger: "#ff5a4d",
  },
};
/** The same theme with a sky blue accent. */
export const TERMINAL_BLUE: OwnThemeAsk = {
  ...TERMINAL,
  colors: { ...TERMINAL.colors, accent: "#7fd6ff" },
};
/** The trial's all-orange ask, whose hot and danger sit too close to its accent. */
export const PUMPKIN: OwnThemeAsk = {
  name: "Pumpkin",
  colors: { background: "#140a02", text: "#ffe6cc", accent: "#ff9a3d", hot: "#ffa257" },
};

/** The first mate saves, changes, is refused, and removes the person's own theme, each with one call. */
export const ownColorTheme: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    for (const [words, value] of [
      [OWN_THEME_PROMPT, { save: TERMINAL }],
      [OWN_THEME_BLUE_PROMPT, { save: TERMINAL_BLUE }],
      [OWN_THEME_ORANGE_PROMPT, { save: PUMPKIN }],
      [OWN_THEME_REMOVE_PROMPT, { remove: TERMINAL.name }],
    ] as const)
      if (latestUserTail.includes(words))
        return {
          calls: [{ name: "app_change", args: { action: "own-theme", value, evidence: words } }],
        };
    return undefined;
  };
