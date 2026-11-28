# The card overlay

On a Mac, one system-wide key shows the card stack in a small panel over whatever app is in front, a full-screen game included, so a person answers a card without switching to Infinitary's window.
It is this computer's own, off until a person turns it on in Settings → Keyboard, and it gives the keys back to the app behind it as soon as it goes.

| Part | Where |
| --- | --- |
| The switch and key, their rules, the panel's place | `src/shared/cardOverlay.ts` |
| macOS's own shortcuts and whether a key is one | `src/shared/macSystemShortcuts.ts` (`systemHotKeys`, `isSystemHotKey`, `isMacOwnKey`) |
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
A key the system will not register is refused whole: the switch and key stay as they were and the key that worked keeps working, and the row says which key was refused and which one the cards keep.
At startup, a saved key the system will not register shows on the row as not working.
On a Mac the system does not refuse a key another program holds: both programs register it, and only the one that registered it last hears it, so the app cannot tell that another program wanted the key, as seen on macOS 26 with a program registering it as a Carbon hot key.
The shortcuts macOS keeps for itself in System Settings → Keyboard → Keyboard Shortcuts (screenshots, Mission Control, Spotlight and the rest) take their key first, so the app refuses one of those itself, the same way, and the row says that macOS uses the key.
Each change of the key reads that list again (`AppleSymbolicHotKeys` in the `com.apple.symbolichotkeys` defaults, through `defaults` and `plutil`); the system writes only the entries a person changed, so a new Mac's defaults stand for the rest, and a shortcut a person turned off is not refused.
The list names keys by their place on the keyboard, so the app finds a chord's key by its place on an ANSI keyboard; a character it does not place, such as one Option types, matches nothing.
The keys every Mac app answers, which Keyboard settings never records for a command either (`reservedKeys`: ⌘C, ⌘Q, ⌃⌘F, a text field's ⌃A and the rest), are refused the same way, since held system-wide they would stop working in every app.
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
A card that closes in the panel - a choice, putting it aside, its author closing it - leaves the panel up on the next card, which the stack picks by its own rule as in the window (the captain, after using the overlay: "the card stack should stay after closing a card").

## The panel

`startCardOverlay` makes one `type: "panel"` window on each press and destroys it on each leave.
While the switch is on and its key held, a notification about a card on this computer also makes it, hidden (`CardOverlayController.noticed`), so the key that follows opens the card without loading the page.
That page reads the stack but picks no card until the key: `inf:overlay:start` answers only then, so the card is the newest notification's at the press, and the panel takes its place on the pointer's display then too.
A page whose first reads fail before the key says so then; the controller keeps that word and, at the key, says that no card waits, as an open with no notification does.
Unpressed, it is destroyed five minutes after the newest notification (`WARM_LIMIT_MS`), and a lock, sleep or lost display destroys it at once.
With no notification waiting, no overlay page, timer or poll runs while it is hidden.
It is frameless, clear, shadowless and floating above full-screen apps on every Space, at the trailing edge of the display the pointer is on (a game holds the pointer on its own display), the full height of its work area (`overlayBounds`).
The panel is half the display's width, never narrower than a regular 560-point card and its air at the Size setting, nor wider than the display.
Inside it every width rule of the window holds unchanged - the width the host decided, the saved Default card size, a drag, the thread beside the card where the panel has room - so a card opens at its window width up to that half.
The card hugs the panel's trailing edge, 24 points from the display's edge, centred in the display's height and no taller than it, and the panel's spare width on its leading side is clear area (`overlay.css`).
The panel's page follows the Size setting as the window does (`followWindowSize`), and the panel grows with it, so a card keeps its own pixel width at every Size.
In a right-to-left language it sits at the left edge.
A card made large takes the display's whole work area while it stays large, and the panel returns to its place when it shrinks: the page tells the main process (`inf:overlay:wide`), which resizes the panel, and the clear area around the large card still lets the pointer through.
There is no glass, dimmer, sound or badge; the card moves in once from the edge, and under Reduce Motion it is there at once.

The page is marked as the overlay's by a preload argument (`--inf-card-overlay`), which sets `html[data-card-overlay]` before its first paint.
It starts only the stack's reads (`startOverlayStore`): the cards, their threads and drafts, and the project focus, never the board, crew, voice or a notification's card.
It draws `CardLayer` itself, so every card's peeks, pager, replies, fields, thread and host choices work as in the window, and so does card admission: a choice runs once through the same action path, and a refusal stays on the card.

Only the stack's place differs from the window's (`overlay.css`).
The pager hangs 10 points under the card and moves with it, card and pager centred together in the panel's height, instead of under the window's fixed lane, which in the panel is nearly its whole height.
It stands on the overlay's pill surface, as the hide button does, so it reads over any scene; the new badge stays beside it on an opaque ground of its own.
The hide button sits just above the card's top corner, clear of the peeks, and follows the card as its height eases; a card made large leaves it in the panel's corner.
So the tallest card gives up a lane above it for the hide button and one under it for the pager.

A choice that opens Infinitary's window - Settings, a browser, a sign-in - is refused on the card with the words that it opens the window, so it is made there and never runs out of sight.
The system's file and folder pickers are refused the same way (`pickFiles`, `pickProjectFolder`): a picker would take the keys and send the panel away under it.
Files dropped on the thread still attach.
Where the panel has no room for the thread beside the card - a narrow display or a large Size - the card holds its thread in place, behind the `card` · `thread · N` control in the card's head (`docs/card-threads.md`); a line that arrives after the thread's first read, the person's own reply or its author's answer, turns the card to its thread.

The page tells the main process it is ready once the shown card is drawn and live, or at the stack's own hold limit (`HOLD_LIMIT_MS`), past which the stack shows the card as it is; only then does the panel show, with the keys when there is a card (`show()`) and without them when none waits (`showInactive()`).
As a nonactivating panel it takes the keys while the game stays the front app.

## Keys and pointer

The shown card takes focus as a card the window points at does (`focusCard`), so the first key reads or acts on that card.
When a card closes in the panel, focus lands on the next one whole by the window's lost-focus fallback (`docs/keyboard.md`, "Where focus lands").
In the panel the card's own installed keys run as in the window (`overlayRunsCommand`); every other window key does nothing.
The menu's ⌘Q and ⌘W send the overlay away, and ⌘H, ⌘M and ⌘, do nothing, so no key quits, hides or opens the app from the panel.

A key the person was already holding when the panel took the keys - the overlay's own key, a game's movement key - keeps repeating into the panel without ever being pressed there.
`carriedKeys` drops every one of those repeats and its let-go before the page and the window's commands hear it, so a held key never answers or moves on a card; the window's held-Enter rule (`docs/keyboard.md`) still holds for keys pressed in the panel.

Off the card, the panel's clear area lets the pointer through: the page tells the main process whether the pointer is over the card, and the panel ignores mouse events elsewhere, so a click beside the card reaches the game.
The stack's own empty boxes around the card and its pager count as clear area too (`CLEAR` in `CardOverlay.tsx`), so a click above or below the card, or beside the pager, reaches the game as well.
The hide button comes after the card in the page, so Tab reaches it after the card's controls.

## Going back

Each way out sends the panel away without answering, keeping what was typed:

- the key again;
- Escape, which first closes card search, then shrinks a card made large, then leaves a control inside the card for the card, and only then leaves;
- the hide button just above the card;
- a stack with no cards left, such as after the choice on the last card;
- a click on the game, another app, another Space (the panel loses the keys);
- the screen locking, the computer sleeping, or a display going away.

The panel hides at once, the page sends its unsent drafts (`DraftSync.settle`), and the window is destroyed once it has, or after one second.
Nothing brings the main window forward, and the game stays the front app; a game that quit meanwhile stays gone.
A click on the card can still make Infinitary the active app, although the panel is nonactivating (seen on macOS 26), and the game would then get no keys once the panel went.
So the panel notes which app was in front when the key was pressed (`lsappinfo`), and when the card was clicked and the panel still has the keys as it goes, it makes that app active again through Launch Services (`open -b`), only while that same instance still runs.
Hiding Infinitary instead would activate whichever app the system orders next, which after a Command-Tab is not the game.
A panel that lost the keys first went because the person moved to another app, Infinitary's own window included, and that app keeps them.

A press while the page is still starting, or while it is letting go, does nothing.

## Timing marks

With `INFINITARY_OVERLAY_MARKS=1` the main process prints one line when the key is pressed and one when the page is ready, with the milliseconds between them, for a timing check.
