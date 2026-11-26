# Color themes

A color theme recolors the computer's window: its surfaces, words and marks, every open card and panel, the first mate, the crew ring and the voice waveform.
Settings → Appearance → Theme offers Dark, Light and the built-in themes as one group of tiles, each a small window in its own colors; the arrow keys move the pick, and a pick applies at once.
The first mate's `theme` line takes the same choices (`src/shared/themeActions.ts`).

## A theme is six colors

Each built-in theme is six colors in `BUILT_IN_THEMES` (`src/shared/colorThemes.ts`), each a value its published source theme uses:

| Color | Its job |
| --- | --- |
| `background` | The window's own color; every surface steps from it in its hue. |
| `text` | Words. |
| `accent` | Calm: done, links, the first mate's light. |
| `hot` | Working and attention. |
| `danger` | Errors. |
| `captain` | The person's own activity. |

A theme keeps its maker's name in every language, since the captain chose makers' names for all.
NOTICE credits each source theme with its MIT copyright and permission notice.

The built-in themes are Rosé Pine, Rosé Pine Moon, Rosé Pine Dawn, Catppuccin Latte, Catppuccin Frappé, Catppuccin Macchiato, Catppuccin Mocha, One Dark, One Light, Dracula, Night Owl, Night Owl Light and Tokyo Night, in that order.

## Working out the tokens

`workOutTheme` turns the six colors into every color token `colors.css` declares (`COLOR_TOKENS`, `src/shared/designTokens.ts`), in OKLab and OKLCH:

- **The base.**
  A background lighter than 0.6 OKLab lightness sits on Light, and any other on Dark.
  The base is the theme's `data-theme`, so everything that asks Dark or Light, such as a picture pair or the window material, keeps asking it.
- **Surfaces.**
  `--bg-1` to `--bg-3` step from the background as Dark and Light step, in the background's hue, and a near-black window still gets cards a person can tell from it.
- **Floors.**
  Each color is moved in lightness only, never hue, until it reaches its floor (`FLOORS`): text 7:1, quiet text 4.5:1 and faint text 3:1 on the surface they read worst on, and `--accent`, `--hot`, `--danger` and `--captain` 3:1 on a card's `--bg-2`.
  What moved is listed in `moved`.
- **Distances.**
  `--accent` and `--hot`, and `--accent` and `--danger`, stay at least 0.12 apart in OKLab, and `--hot` and `--danger` at least 0.06 (`APART`), so a working crewmate never looks idle and an error never looks like a link.
  A theme that misses one lists it in `faults`, and a built-in theme has none.
- **Words on the accent.**
  `--on-accent` is the color of words on an accent-filled control, such as a primary button or an on switch: a dark theme's own background when it reads best, else white or Dark's void, at least 4.5:1.
  Dark and Light keep their own `--on-accent` in `colors.css`.
- **The wash.**
  `--material-tint` is the theme's background, so the Mac's wash shows it at the strength the person chose.

`src/shared/colorThemes.test.ts` holds each built-in theme to typed values and to every floor and distance.

## Where the choice lives

The look's optional `colorTheme` holds the chosen theme, and `theme` keeps its base.
`SettingsStore` keeps it in a row of its own, `color-theme`, with the base it was chosen on, and never in the `appearance` row.
Picking Dark or Light is a look with no color theme, which removes the row.
An older build writes only the `appearance` row, so when the saved base no longer matches it, the base wins and the window shows plain Dark or Light.
A theme name this build does not know stays saved and shows the base (`shownTheme`).

A view that does not list the `color-theme` contract change is never sent the field (`viewHello.ts`), so it never saves a look it cannot read back.
A view keeps its own look, color theme included.

## Drawing it

The window lays the theme with one rule in a sheet of its own, `<style id="inf-color-theme">`, kept last in the head, and marks the body `data-color-theme` (`src/renderer/src/app/colorTheme.ts`).
Dark and Light lay nothing: they are the color sheets themselves.

A frame gets the same rule two ways:

- At its birth, its stylesheet ends with `frameThemeRule`, so a card opened later is drawn in the theme from its first paint.
- On every later change, the bridge's `theme` message carries the rule as `colors`, so an open card or panel follows without being built again.

A frame drawn in the other base, such as a hero picture of a Light window while the window wears a dark theme, takes that base's own tokens.
Canvas drawings that read colors once, the first mate and the crew ring, read them again whenever the base or the theme changes (`useThemeColorsDrawn`), and picture marks follow `data-color-theme` as they follow `data-theme`.

## What stays

A color theme leaves `data-theme`, the picture pairs, the window material, the wash strength, shadows, fonts and a card's hand-written colors as they are.
