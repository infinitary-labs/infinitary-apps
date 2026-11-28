# Copy on select

Settings → Appearance has a Copy on select switch, off by default.
With it on, letting go of the pointer after selecting words copies them as ⌘C or Ctrl+C would, formatting included, and shows nothing.

## What copies

- A drag across words that changed what is selected.
- A double-click on a word and a triple-click on a paragraph.
- Words selected inside a field the person types in. Pasting over such a selection puts the same words back.

Never copied: a click with nothing selected, a drag that leaves the earlier selection as it was (a panel, a card's edge or a file chip moved), a password field, and a selection made with the keyboard.
A double-click on the picture viewer's picture selects no words, so it copies nothing and runs no copy handler.

## How it works

`followCopyOnSelect` (`src/main/copyOnSelect.ts`) listens to each window's `before-mouse-event`, which hears only the person's own presses, so a card's script cannot start a copy.
Card bodies run in sandboxed frames the page cannot see into, and the window's own process reads them, so the frame bridge, its hash and the frame's content policy stay as they are.

1. A left press reads the words selected in the focused frame, before the page handles the press, and records the point and click count.
2. The release reads them again. It copies when words are selected and either a second or third click ended the gesture, or the pointer moved a few pixels and the words differ from the ones at the press.
3. The copy is `webContents.copy()`, the Edit menu's copy.

The read is a script run in the focused frame that returns the selected words: a field's selected text, or the document's selection. It returns nothing for a password field.
`webContents.copy()` alone is not enough: with nothing selected it still fires the page's copy event, which copies the picture in the viewer.

The same hook follows the main window, a window controlling another computer's first mate, and the Mac card overlay. The overlay is given the switch by `startCardOverlay`.
A task's browser is a picture of another browser and is not followed. The iPhone and iPad app is not followed either.

## The saved setting

`appearance.copyOnSelect` is kept in a settings row of its own, `copy-on-select`, only while on (`docs/saved-data-compatibility.md`).
The first mate switches it with the `copy-on-select` line (`src/shared/appearanceActions.ts`), as Settings does; each computer's window has its own.
It is listed by the `copy-on-select` contract change, so a view without the change is not sent it.
