# Fonts

Settings → Appearance lets a person choose the font of three places, in the rows after Crew model names.
They sit below the rows that must stay on screen in the smallest window, as the Language row does.
Each is Infinitary's own font until chosen.

- **App font**: the window's own words, its panels, buttons and Settings (`--font-ui`).
- **Reading font**: what the crew writes on cards, the bodies of cards and of panels drawn from a template (`--font-text`).
  Until chosen it follows the app font.
- **Code font**: code, keys and task keys (`--font-mono`).

Each row offers Infinitary's own font, this computer's own font (`system-ui`, or `ui-monospace` for code: San Francisco on a Mac, Segoe UI on Windows, the desktop's own font on Linux), and every font installed on the computer, by its family name.
A choice changes the window at once, lasts across a restart, and the first mate makes it too when asked (the `font` action in `src/shared/actions.ts`).

## The choice

The choice is the appearance's optional `fonts` (`fontChoicesSchema` in `src/shared/fonts.ts`), one family name for each chosen slot.
The core keeps it in a settings row of its own, so an older build still reads the rest of the look (`docs/saved-data-compatibility.md`, "The font choice").
A view older than major 16 whose hello does not list `font-choice` reads the look strictly, so the home leaves `fonts` out of the look it pushes or answers there (`lookFor` in `src/core/connection/cardCompatibility.ts`).
A family name holds no quote, backslash, angle bracket, brace, semicolon or control character, since it is written inside a CSS string and inside a frame's `<style>`.

The installed fonts come from the browser's own list (`queryLocalFonts`), which only the window's own page may read (`local-fonts` in `src/main/security/permissions.ts`); no card, panel or page can.
A family whose name starts with a dot is one the system keeps for itself and is left out.
A saved font this computer does not have stays chosen, and its row says it is not on this computer; the window draws Infinitary's own font in its place.

## How a choice reaches every view

Every view reads the type tokens, and no view names a font outright.
Each token is a stack: the face, then the faces for other scripts, then the computer's own (`tokens/typography.css`):

```css
--font-ui: var(--font-ui-face), var(--font-script-ui, system-ui), system-ui, sans-serif;
```

A choice sets only the faces, `--font-ui-face`, `--font-text-face` and `--font-mono-face`, each the chosen family with Infinitary's own after it for any letter it lacks (`fontDeclarations`).
The window sets them on its document (`followFonts` in `src/renderer/src/app/fonts.ts`).
A frame's document is built with the fonts of its birth: the frame's stylesheet ends with the same declarations (`fontFrameStyle`), and a frame is mounted anew when they change, as it is for a new language (`useFontsDrawn`).
A preview drawn in a project's own look keeps its own fonts, since it names them itself.

A key hint on a button takes the room of the code font's glyphs: the window measures one glyph of the chosen code font and sets `--key-glyph`, and a button reserves that room for each glyph of the key (`keyPadding` in `src/renderer/src/design/core/Button.tsx`).
Infinitary's own JetBrains Mono needs no measuring.

## Letters in other scripts

A chosen font, like Infinitary's own, may lack Chinese, Japanese, Korean or Arabic letters.
The stack names this computer's typeface for each such script after the chosen face, so those letters take the script's face rather than whichever face the browser guesses.
The app's own language comes first, by the document's `lang` (`:lang()` in `tokens/typography.css`).
After it come the scripts of the computer's own languages, in the order the computer prefers them (`scriptOrder`): the main process passes every preferred language to the window (`computerLanguagesArgument`), and its preload marks them on the document.
So Japanese words in an English window take a Japanese face on a computer that also reads Japanese, and Chinese and Japanese, which share many characters, take the face of the language the computer puts first.
`SCRIPT_FACES` in `src/shared/fonts.ts` names the same faces as the tokens' `:lang()` rules, and its test holds the two together.

## The phone

The phone keeps its own look and draws in Infinitary's own fonts; a view never receives the home's fonts.
Its words follow the device's Text Size rather than the Mac's Size, cards and panels included (`docs/ios.md`, "Text size").
