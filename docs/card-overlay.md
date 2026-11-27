# The card overlay

On a Mac, one system-wide key shows the card stack in a small panel over whatever app is in front, a full-screen game included, so a person answers a card without switching to Infinitary's window.
It is this computer's own, off until a person turns it on in Settings → Keyboard, and it gives the keys back to the app behind it as soon as it goes.

| Part | Where |
| --- | --- |
| The switch and key, their rules, the panel's place | `src/shared/cardOverlay.ts` |
| The shortcut, the phases, the saved file and the carried-key rule | `src/main/cardOverlay.ts` (`CardOverlayController`, `cardOverlayFile`, `carriedKeys`) |
| The panel window, its keys and the system events that send it away | `src/main/cardOverlayWindow.ts` (`startCardOverlay`) |
| The page: its reads, the card it shows, Escape, the pointer | `src/renderer/src/overlay/` |
| The row in Settings → Keyboard | `CardOverlayRow` in `src/renderer/src/settings/KeyboardTab.tsx` |
| The newest notification's card, read without taking it | `noteNoticedCard`, `noticedCard` in `src/main/notifiedCard.ts` |

## The switch and the key

The key is Control+Shift+O until a person records another.
It must hold Control, Option or Command, so plain typing and a game's Shift-modified movement never press it, and it is never Escape, Tab, Return, Space or Delete (`overlayKeyAllowed`).
The switch and key live in `card-overlay.json` in this computer's app data, whichever first mate the window follows, since the key is pressed on this keyboard; `cardOverlayFile` is that file's one writer, and a file it cannot read is off.

The app registers the key with the system (`globalShortcut`) only while the switch is on, and lets it go when the switch goes off, the key changes, or the app quits.
A key another program already holds is refused whole: the switch and key stay as they were and the key that worked keeps working, and the row says which key was refused and which one the cards keep.
At startup, a saved key another program has taken since shows on the row as not working.
The dictation key is not a system-wide shortcut and stays as it is.

Every desktop but a Mac's reports `unsupported`, and the row does not show there.

## Which card it shows

The panel reads the cards as the window draws them: put-aside cards and the cards the project focus holds back are not on its stack (`overlayTarget`).

1. The card the newest notification on this computer was about, while it is on the stack and still asks for a choice.
   The overlay reads that card without taking it (`noticedCard`), so a later click on the notification still opens it in the window (`docs/view.md`).
2. Else the first card on the stack that asks for a choice.
3. Else the card the stack shows now, else the first.

With no card at all the panel says that none waits, for a moment, without taking the keys or raising the window.
A card that arrives while one is shown waits behind it as in the window; it never replaces the card being read.

## The panel

`startCardOverlay` makes one `type: "panel"` window on each press and destroys it on each leave, so no overlay page, timer or poll runs while it is hidden.
It is frameless, clear, shadowless and floating above full-screen apps on every Space, at the trailing edge of the display the pointer is on (a game holds the pointer on its own display): one 560-point card 24 points from the edge, centred in the display's height and no taller than it (`overlayBounds`).
In a right-to-left language it sits at the left edge.
A card made large takes the display's whole work area while it stays large, and the panel returns to its place when it shrinks: the page tells the main process (`inf:overlay:wide`), which resizes the panel, and the clear area around the large card still lets the pointer through.
There is no glass, dimmer, sound or badge; the card moves in once from the edge, and under Reduce Motion it is there at once.

The page is marked as the overlay's by a preload argument (`--inf-card-overlay`), which sets `html[data-card-overlay]` before its first paint.
It starts only the stack's reads (`startOverlayStore`): the cards, their threads and drafts, and the project focus, never the board, crew, voice or a notification's card.
It draws `CardLayer` itself, so every card's peeks, pager, replies, fields, thread and host choices work as in the window, and so does card admission: a choice runs once through the same action path, and a refusal stays on the card.

A choice that opens Infinitary's window - Settings, a browser, a sign-in - is refused on the card with the words that it opens the window, so it is made there and never runs out of sight.
The system's file and folder pickers are refused the same way (`pickFiles`, `pickProjectFolder`): a picker would take the keys and send the panel away under it.
Files dropped on the thread still attach.

The page tells the main process it is ready once the shown card is drawn and live, or at the stack's own hold limit (`HOLD_LIMIT_MS`), past which the stack shows the card as it is; only then does the panel show, with the keys when there is a card (`show()`) and without them when none waits (`showInactive()`).
As a nonactivating panel it takes the keys while the game stays the front app.

## Keys and pointer

The shown card takes focus as a card the window points at does (`focusCard`), so the first key reads or acts on that card.
In the panel the card's own installed keys run as in the window (`overlayRunsCommand`); every other window key does nothing.
The menu's ⌘Q and ⌘W send the overlay away, and ⌘H, ⌘M and ⌘, do nothing, so no key quits, hides or opens the app from the panel.

A key the person was already holding when the panel took the keys - the overlay's own key, a game's movement key - keeps repeating into the panel without ever being pressed there.
`carriedKeys` drops every one of those repeats and its let-go before the page and the window's commands hear it, so a held key never answers or moves on a card; the window's held-Enter rule (`docs/keyboard.md`) still holds for keys pressed in the panel.

Off the card, the panel's clear area lets the pointer through: the page tells the main process whether the pointer is over the card, and the panel ignores mouse events elsewhere, so a click beside the card reaches the game.

## Going back

Each way out sends the panel away without answering, keeping what was typed:

- the key again;
- Escape, which first closes card search, then shrinks a card made large, then leaves a control inside the card for the card, and only then leaves;
- the hide corner at the panel's top;
- a choice made on the card, and a stack with no cards left;
- a click on the game, another app, another Space (the panel loses the keys);
- the screen locking, the computer sleeping, or a display going away.

The panel hides at once, the page sends its unsent drafts (`DraftSync.settle`), and the window is destroyed once it has, or after one second.
Nothing ever brings the game or the main window forward: the game is still the front app, and a game that quit meanwhile stays gone.
A click on the card can still make Infinitary the active app, although the panel is nonactivating (seen on macOS 26), and the game would then get no keys once the panel went.
So when the card was clicked and the panel still has the keys as it goes, the panel hides Infinitary (`app.hide()`), which gives the activation back to the app behind it; an Infinitary window open on another desktop hides with it until Infinitary is opened again.
A panel that lost the keys first went because the person moved to another app, Infinitary's own window included, and that app keeps them.

A press while the page is still starting, or while it is letting go, does nothing.

## Timing marks

With `INFINITARY_OVERLAY_MARKS=1` the main process prints one line when the key is pressed and one when the page is ready, with the milliseconds between them, for a timing check.
