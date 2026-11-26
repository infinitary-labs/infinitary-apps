# Keyboard commands

How a key becomes something the app does: one catalog of commands, one resolver, and handlers that stay with the code that owns what they change.
The captain chose complete keyboard access with conventional controls and customizable shortcuts (FI3-800, direction B), and later presets that start from Vim's, Emacs's or VS Code's keys (INF-3547, piece 4; "Presets"); there is no Vim editing mode inside a text field.

| Piece | Where |
| --- | --- |
| The catalog: each command's id, words, default keys, scope, repeat and risk | `src/shared/keyboardCommands.ts` (`KEYBOARD_COMMANDS`, `KeyboardCommand`, `KeyBinding`), read through `src/shared/keyboard.ts` |
| Matching a press to a chord, scopes, the resolver, two-key shortcuts, menu accelerators and key hints | `src/shared/keyboard.ts` (`DEFAULT_BINDINGS`, `commandFor`, `chordMatches`, `startsTwoKeys`, `secondKeyCommand`, `menuAccelerator`, `keyHint`, `ariaKeyShortcuts`) |
| The presets, their keys and which a profile is offered | `src/shared/keyPresets.ts` (`PRESET_IDS`, `presetKeys`, `presetsOffered`, `NEW_PROFILE_PRESET`) |
| What is saved, which keys a command may take, clashes, the installed map and a refused change | `src/shared/keymap.ts` (`savedKeymapSchema`, `bindingProblem`, `clashesWith`, `resolveBindings`, `keymapRefusal`) |
| The installed map, the window's commands heard before the page, and recording | `src/main/keyboard.ts` (`InstalledKeymap`, `followWindowCommands`, `recordWindowKeys`) |
| Where the keys are kept | `ShellPreferencesService.keymap` (the `keyboard` settings row) on the Mac that holds the first mate, `ViewLook.keymap` on one that controls it, switched by the shell's `SwitchablePreferences` (`src/main/shell.ts`) |
| The size commands' handlers | `src/main/windowSize.ts` (`sizeCommands`), held once by `src/main/shell.ts` (`Shell.size`) |
| The app menu: the app's name in About, Hide and Quit, the size items, Check for Updates…, Settings…, Keyboard Settings…, Reset All Keys… and the Help menu's What’s New | `src/main/appMenu.ts` (`nameAppMenu`, `installAppMenu`, `resetAllKeysAfterAsking`) |
| The shell's window commands: told to the page by id | `src/main/keyboard.ts` (`shellCommands`), the `inf:keyboard:command` push (`src/shared/ipc.ts`) |
| The next-keys hint: the pairs that may finish a first key, told to the page and drawn at the window's bottom | `src/main/keyboard.ts` (`followWindowCommands`), the `inf:keyboard:next` push, `nextKeys` (`src/shared/keyboard.ts`), drawn by `src/renderer/src/app/NextKeysHint.tsx`; the design skill's `components/core/NextKeysHint.prompt.md` |
| A key the window took, told to the page without the key | `src/main/keyboard.ts` (`followWindowCommands`), the `inf:keyboard:taken` push, read by the dictation key (`src/renderer/src/app/dictationKey.ts`) |
| The shell's window commands' handlers | `src/renderer/src/app/shellCommands.ts` (`followShellCommands`, `runWindowCommand`) |
| Why a window command cannot run now | `src/renderer/src/app/commandRefusals.ts` (`commandRefusal`) |
| Command search | `src/renderer/src/app/CommandSearch.tsx`, its list `commandRows.ts`; the design skill's `components/core/CommandSearch.prompt.md` |
| A main-process command chosen by name | the `inf:keyboard:run` request (`src/shared/channels/shell.ts`, `src/main/ipc/index.ts`) |
| A control's key hint | `src/renderer/src/app/keyHints.ts` (`useCommandKeys`), drawn by `IconButton`'s label |
| The installed map in the page | `src/renderer/src/design/core/installedKeys.ts`, read before the first render (`hydratePreferences`) and followed through the `inf:keyboard:keymap` push |
| Keyboard settings | `src/renderer/src/settings/KeyboardTab.tsx`, its recorder `keyRecorder.ts`; the design skill's `components/core/KeyboardSettings.prompt.md` |
| The shown card's paging, close and size, lent to the commands | `src/renderer/src/app/cardStage.ts`, lent by the card layer in `stage/CardLayer.tsx` |
| The window's parts F6 moves between | `src/renderer/src/app/regions.ts` (`moveToRegion`), each part's root marked `data-window-region` by the code that draws it |
| A panel's body taking focus | `railStore.askBodyFocus` (`src/renderer/src/plugins/railStore.ts`), answered by the panel's mount in `Rail.tsx` |
| The Tasks list's keys | `src/panels/now/nav.ts`, run by the Tasks panel (`src/panels/now/panel.tsx`) |
| The task board's keys | `src/panels/now/boardTiles.ts` (`boardNavMove`), run by the board (`src/panels/now/cards/board.tsx`; `docs/task-board.md`) |
| Settings' tabs | `src/renderer/src/settings/SettingsScreen.tsx` (`tabStep`) |
| The focus ring | `src/renderer/src/design/styles.css` and the panel stylesheet (`frameStylesheet.ts`); focus a key moved, with its ring: `src/renderer/src/design/focus.ts` (`focusWithRing`) |
| A label on rest, the pointer's or the keyboard's: an icon button's words, or a fact shown on rest | `src/renderer/src/design/core/restLabel.ts` (`useRestLabel`), drawn by `iconLabel.ts`; words cut short: `overflowTitle.ts` (`useCutWords`) |
| The shown card's own places, its body, buttons and reply | `src/renderer/src/app/shellCommands.ts` (`toShownPart`), each entry named by its `StageEntry` (`data-stage-entry-id`) |
| The card's reading keys | `src/renderer/src/cards/cardKeys.ts` (`readingScrollTop`), run by `StageEntry` (`cards/SurfaceReveal.tsx`) |
| Focus given back into a frame, and a frame's gesture counted only from focus | `src/renderer/src/plugins/frames/frameFocus.ts` (`giveFocusBack`, `guardFrameFocus`, `giveHandedFocusBack`, `whenFrameHoldsFocus`); the frame's side is the bridge (`src/shared/plugins/frameScript.ts`: `keys`; `frameKeyboardScript.ts`: `focus`, `escape`) |
| A frame's click or key spent as focus leaves it, and the window's own gesture | `src/renderer/src/plugins/frames/frameActivation.ts` (`guardFrameActivation`, `windowGesture`) |
| A card pointed at takes focus once it appears, unless a press began since | `src/renderer/src/app/presses.ts` (`countPresses`, `pressesSoFar`), read by `focusCard` (`stackActions.ts`) and the stage's focus in `stage/CardLayer.tsx`; the frame's side is the bridge's `pressed` |
| A held key presses a control once | `src/renderer/src/app/heldKeys.ts` (`guardHeldPresses`) and `enterAction`'s repeat (`composerKeys.ts`) |
| A message field's commands | `src/renderer/src/design/core/composerKeys.ts` (`messageKey`), run by `ComposerField` |
| A panel's commands: told to the window, run and refused | `src/renderer/src/plugins/panelCommands.ts` (`startPanelCommands`, `runPanelCommand`, `panelCommandRefusal`), the `inf:keyboard:panels` request; their keys in `src/shared/keyboard.ts` (`PanelCommand`, `panelCommandFor`) and `src/shared/keymap.ts` (`resolveBindings`) |
| A DOM keydown as a press | `src/renderer/src/design/core/composing.ts` (`keyPress`) |

## A new feature

Every feature works from the keyboard.
The short rule is in `AGENTS.md`; the record is `docs/principles.md` ("Standing product principle (captain, 2026-10-04)").
A new control is reached with Tab, or the arrows inside a list, and draws the focus ring.
A list is one Tab stop and the arrows move through it ("Lists and Settings"); a control that is not in a list is its own Tab stop.
A focus a key moves goes through `focusWithRing` (`src/renderer/src/design/focus.ts`), which asks for the ring, and the window and every frame draw that ring on whatever the keyboard reaches.
An action a person repeats becomes a window command in `KEYBOARD_COMMANDS` (`src/shared/keyboardCommands.ts`).
Command search lists every window command but search itself (`SEARCHED_COMMANDS` in `src/renderer/src/app/commandRows.ts`), so that is the command this rule adds.
Its handler stays with the code that owns what it changes, and `followWindowCommands` takes one handler for every window command, so a new one cannot be left without one ("Handlers").
It gets a default key only where none clashes: no two commands that can work in the same place share a default key, which `src/shared/keyboard.test.ts` checks, and a window command may instead have none and be chosen by name.
Its control shows the key hint: the command's first key after the control's words, and every key in `aria-keyshortcuts`, read from the installed map (`useCommandKeys`, "Key hints").
A command that changes or removes what holds focus follows "Where focus lands", so repeated shortcuts chain without Escape.
An end-to-end journey drives the feature by keys and checks the result the person came for.
A window key goes through `pressWindowKey` (`tests/e2e/windowKeys.ts`), because Playwright's keyboard reaches the page through the debugger and skips `before-input-event`.
`runFromSearch` runs a command by its id the way a person does in command search.
The catalog table in this file names every command, so a new one is added there in the same change.

## A command

Each command in `KEYBOARD_COMMANDS` has:

- a stable id, which is how a changed key is remembered, so it is never renamed or reused;
- a label, the words a person reads in a list of commands;
- a scope, where it works (below), and for a window command who runs it: the main process itself, or the shell page it tells (`runs`);
- a repeat rule: whether a held key runs it again or only the first press does;
- a risk, what running it may change: `view` (how the window looks), `edit` (the focused field's words), `navigate` (where focus is and what the window shows, with nothing saved) or `close` (a card it closes);
- its default keys, the first of which a menu and a hint show; a window command may have none and is then chosen by name in command search.
- optionally other words command search finds it by (`searchWords`), the words a person might type for it that its label does not hold.
- optionally the Settings section it acts in (`section`), which this build may not offer: command search and Keyboard settings list it only where that section shows (`commandOffered`, read from the shell's `devicesShown` and `secretsShown`), and it is refused anywhere else.
  A key is one chord or, for a window command, two pressed one after the other (`KeyBinding`, "Two-key shortcuts").

A command that opens, closes or moves focus never repeats while its key is held; only the size keys and a message field's edits do.

`DEFAULT_BINDINGS` is the catalog's keys by id.
`commandFor` takes a `Bindings` map, so a different set of keys changes which press runs a command but never where the command works.
Every reader takes the installed map ("The installed map"), never the catalog's keys directly.

| Command | Scope | Default keys |
| --- | --- | --- |
| `commands.search`, Search commands | window, run by the shell page | ⌘K |
| `focus.main-message`, Go to the main message | window, run by the shell page | ⌘L |
| `focus.card-reply`, Go to the card's reply | window, run by the shell page | ⇧⌘L |
| `focus.card-body`, Go to the card's body | window, run by the shell page | none: chosen by name |
| `focus.card-actions`, Go to the card's buttons | window, run by the shell page | none: chosen by name |
| `cards.choice-1`, Press the recommended choice | window, run by the shell page | ⌘1 |
| `cards.choice-2`, Press the second choice | window, run by the shell page | ⌘2 |
| `cards.choice-3`, Press the third choice | window, run by the shell page | ⌘3 |
| `cards.choice-4`, Press the fourth choice | window, run by the shell page | ⌘4 |
| `regions.next`, Go to the next part of the window | window, run by the shell page | F6 |
| `regions.previous`, Go to the previous part of the window | window, run by the shell page | ⇧F6 |
| `regions.left`, `regions.down`, `regions.up`, `regions.right`, Go to the part of the window on the left, below, above or on the right | window, run by the shell page | none: chosen by name or given a key |
| `move.left`, `move.down`, `move.up`, `move.right`, Move left, down, up or right | window, run by the main process | none: chosen by name or given a key |
| `move.first`, `move.last`, Move to the start or the end | window, run by the main process | none: chosen by name or given a key |
| `move.page-up`, `move.page-down`, Move up or down a page | window, run by the main process | none: chosen by name or given a key |
| `cancel`, Cancel | window, run by the main process | none: chosen by name or given a key (escape, close and back find it too) |
| `cards.previous`, Show the previous card | window, run by the shell page | ⇧⌘[ (`[` or `{` with Shift) |
| `cards.next`, Show the next card | window, run by the shell page | ⇧⌘] (`]` or `}` with Shift) |
| `cards.next-new`, Show the next new card | window, run by the shell page | ⌥⇧⌘] (`]` or `}` with ⌥ and Shift; unread, new and jump find it too) |
| `cards.minimize`, Put card aside | window, run by the shell page | ⇧⌘M |
| `cards.minimize-all`, Put every card aside or bring them back | window, run by the shell page | ⌥⇧⌘M |
| `cards.done`, Press the note's Done or Got it | window, run by the shell page | none: chosen by name |
| `cards.decline`, Decline every choice on the card | window, run by the shell page | none: chosen by name (no, not now, none and reject find it too) |
| `cards.maximize`, Maximize or restore card | window, run by the shell page | none: chosen by name (full, screen, enlarge, expand and bigger find it too) |
| `cards.find`, Find in this card | window, run by the shell page | ⌘F (Ctrl+F on Linux and Windows; search, look for, words, text, match and highlight find it too); "Finding in the shown card" |
| `cards.find-next`, Find next match; `cards.find-previous`, Find previous match | window, run by the shell page | ⌘G and ⇧⌘G (Ctrl+G and Ctrl+Shift+G on Linux and Windows), while the find field is open |
| `cards.next-revision`, Go to the next revised area | window, run by the shell page | none: chosen by name; selected revision, otherwise newest released list |
| `cards.next-question`, Go to the next question; `cards.previous-question`, Go to the previous question | window, run by the shell page | ⌘J and ⇧⌘J (Ctrl+J and Ctrl+Shift+J on Linux); the shown card's body ("Moving between a card's questions") |
| `cards.unanswered-question`, Go to the next unanswered question | window, run by the shell page | none: chosen by name, or the footer's picked count clicked |
| `cards.point-at`, Point at a part of the card | window, run by the shell page | ⇧⌘A (Ctrl+Shift+A on Linux) |
| `viewer.save-picture`, Save the picture | window, run by the shell page | ⌘S (Ctrl+S on Linux and Windows), while the picture viewer is open |
| `cards.thread`, Show or hide the card's thread | window, run by the shell page | ⌘\ (collapse, expand, chat, replies and messages find it too) |
| `cards.thread-new`, Go to the thread's new messages | window, run by the shell page | none: chosen by name; the shown card's jump down, while the captain reads above the thread's foot (`docs/card-threads.md`, "Keeping your place") |
| `cards.sound`, Play or pause the card's sound | window, run by the shell page | none: chosen by name (sound, audio, listen and narration find it too); the shown card's sound strip ("Sound clips" in `docs/card-authoring.md`) |
| `cards.show-info`, Show Info; `cards.show-cards`, Show Cards; `cards.show-activity`, Show Activity; `cards.show-crewmate`, Show Crewmate; `cards.show-browser`, Show Browser; `cards.next-tab`, Next tab; `cards.previous-tab`, Previous tab | window, run by the shell page | none: chosen by name (open and task record find Show Info too); on a card about a task, each Show command opens that task's tab in front of the card |
| `browser.control`, Take or return browser control | window, run by the shell page | none: chosen by name; the shown browser uses the same control and shows an assigned key hint |
| `browser.page`, Go to the browser page | window, run by the shell page | none: chosen by name; from the request docked beside the page back to the page, which `focus.card-reply` (⇧⌘L) leaves for the request's field |
| `browser.card`, Back to the card | window, run by the shell page | none: chosen by name; from a card docked beside a browser page to that card in front of the stack, with its choices |
| `task.move-computer`, Move the task to another computer | window, run by the shell page | none: chosen by name (computer, Mac, machine, device and record find it too); presses the shown record's Move to a computer, which opens its picker |
| `task.close-done`, Close the task as done | window, run by the shell page | none: chosen by name (done, finish, complete, close and record find it too); presses the shown record's Close as done, which opens its one confirm with focus on Cancel |
| `task.edit-tags`, Edit the task's tags | window, run by the shell page | none: chosen by name (tags, label, category and record find it too); on the shown card or any of a task's tabs, opens its record's Info tab and presses Edit tags there, which opens the menu of its project's tags with focus on the first |
| `settings.open`, Open Settings | window, run by the shell page | ⌘, |
| `settings.keyboard`, Open Keyboard settings | window, run by the shell page | none: chosen by name, or Keyboard Settings… in the app menu |
| `updates.later`, Update later | window, run by the shell page | none: chosen by name (update, later, cancel, saving and work find it too) |
| `updates.check`, Check for updates | window, run by the shell page | none: chosen by name (update, version, release and new find it too), or Check for Updates… in the app menu |
| `updates.home`, Update the first mate's computer | window, run by the shell page | none: chosen by name (update, computer, remote, restart and version find it too) |
| `whats-new.show`, Show what's new | window, run by the shell page | none: chosen by name (release, notes, changes and version find it too), or What’s New in the Help menu |
| `feedback.start`, Send feedback | window, run by the shell page | none: chosen by name (feedback, report, problem, bug, idea, suggestion and issue find it too), or Send Feedback… in the Help menu |
| `firstmate.reply`, Open the conversation | window, run by the shell page | none: chosen by name (conversation, chat, history, reply, message and cards find it too), or a press on a round above the message box, or Enter or Space on its reply line or a card round's name |
| `message.take-back`, Revert your last message | window, run by the shell page | none: chosen by name (revert, undo, take back, unsend, retract and message find it too), or the revert icon beside the newest message |
| `settings.runbooks`, Open Runbooks; `runbooks.open-folder`, Open your runbooks folder | window, run by the shell page | none: chosen by name |
| `settings.usage`, Open Usage | window, run by the shell page | none: chosen by name (tokens, models, cost and dollars find it too) |
| `settings.panels`, Arrange panels | window, run by the shell page | none: chosen by name (rails, layout, order, move, hide and show find it too) |
| `settings.automation`, Open Automation | window, run by the shell page | none: chosen by name (schedule, recurring, reminder and pause find it too) |
| `automation.pause-all`, Pause all automations | window, run by the shell page | none: chosen by name (schedule, recurring and stop find it too) |
| `ambient.toggle`, Play or stop ambient music | window, run by the shell page | ⌥⌘P |
| `ambient.style`, Choose ambient music | window, run by the shell page | none: chosen by name (music, style, lofi, sound, ambience, pick and change find it too) |
| `usage.unit`, Switch Usage units | window, run by the shell page | none: chosen by name (tokens, cost, dollars and estimate find it too) |
| `allowance.recheck`, Recheck allowance | window, run by the shell page | none: chosen by name (quota, refresh, usage, limit, account and switch find it too) |
| `devices.try-again`, Try again to reach your computers | window, run by the shell page | none: chosen by name (devices, ssh, reconnect and connect find it too), only where Devices shows |
| `project-focus.open`, Focus on a project | window, run by the shell page | ⇧⌘P (filter, project and pill find it too) |
| `project-focus.clear`, Show all projects | window, run by the shell page | none: chosen by name (filter, focus, project and clear find it too) |
| `size.larger` | window | ⌘+ and ⌘= (and ⌃+, ⌃=) |
| `size.smaller` | window | ⌘- (and ⌃-) |
| `size.reset` | window | ⌘0 (and ⌃0) |
| `message.delete-to-line-start` | message field | ⌃U |
| `message.delete-to-line-end` | message field | ⌃K |
| `message.delete-word-before` | message field | ⌃W |
| `message.put-back-deleted` | message field | ⌃Y |
| `message.recall` | main message | ↑ and ⌃P |

What each message command does is `docs/composer.md` ("Keys", "Shell keys").

These keys are not commands and keep their own owners:

- Enter, which `enterAction` decides and which has no setting (`docs/composer.md`);
- ⌘Z and ⇧⌘Z in a message field, which `historyKey` reads and the field answers from its own undo history, with no setting (`docs/composer.md`, "Undo");
- Tab and Shift+Tab, which move focus the platform's way;
- the Mac's own editing keys (Cmd+C, Option+Delete, Ctrl+A, ...);
- the dictation key, a lone right-hand modifier with its own tap-or-hold rules, which leave a shortcut held with right ⌘ or right ⌃ to that shortcut (`dictationKey.ts`; `docs/composer.md`, "Voice"; Settings → General → Dictation);
- Escape, which closes the one topmost thing that is open (`App.tsx`; a part full screen before the card under it; the find field in the shown card's head before the card, "Finding in the shown card"; on the task board, in its own page, a move that asks before its Find's words, and its Find's words before the board; in the Tasks search, its words before the search; in the top bar's open project row, its menu before the row; a maximized card restores before a record or a panel's card hides, "Cards and frames"), and the keys a menu, the picture viewer (a demo's play control and seek slider included), a slider or a card's own controls use inside themselves; in a card's body, an Escape nothing there used leaves the body for its card ("Cards and frames");
- the arrows, Home and End in a list or Settings' tabs ("Lists and Settings"), which belong to the list that has focus.

## A panel's commands

A side panel adds its own commands to the window's (`commands` in its `manifest.json`; `docs/ui-plugins.md`, "A panel's cards"), whoever made it.
Each is a window command the shell page runs, `panel:<panel>/<command>`, that never repeats on a held key and only shows or brings forward: it puts up one of the panel's named cards at the front of the stack, from anywhere, the panel collapsed or not, with the keyboard's focus in the card once it is drawn, or it presses one of the panel's header buttons, or asks the panel by a name of its own with no button (`asks`), either of which opens the panel and asks it.
A focus move still waiting for the card to draw is forgotten once command search opens or the stage has shown that card and then shows another entry, even if the first card returns before it draws.
The id is how a key a person gives it is kept: a saved key whose panel is not here now is listed under the commands this window does not know, runs nothing, survives Reset all keys, and works again when the panel comes back.

The page tells the window its panels' commands whenever the panels change (`startPanelCommands`, the `inf:keyboard:panels` request), and the window installs them with the catalog's (`InstalledKeymap.setPanels`).
`resolveBindings` places a panel command's keys after the catalog's at each step: a key a person gave it with the other changed commands, and the key its panel suggests last of all, in the order the panels were added, so a suggestion is taken only where no other command already uses it and the first panel to ask keeps it.
The main process runs a panel command's key once no catalog command took the press (`panelCommandFor`, `secondKeyPanelCommand`) and tells the page its id on the same `inf:keyboard:command` push.

Command search lists the panels' commands after the catalog's, each panel's under its title, found by its words, its panel's title or the other words its manifest names (`words`); Keyboard settings lists them in the same list, saying where each works as "<panel title> · anywhere in the window", with Record, Remove and Reset like any row.
The app's own panels' commands read as the window's own, as the app's own panels carry no maker's name (`PanelCommand.own`): both lists show them among the catalog's, before Open Settings (`APP_PANEL_COMMANDS_BEFORE`, `allCommandIds`), under no title, found by their words alone, and Keyboard settings says only where they work.
They are worded as the catalog's commands are, in the window's language and found by their English words too, from the catalog's messages rather than their manifest's English (`panelCommandEntry`; `docs/i18n.md`, "The app's own panels").
A header button shows the key of its panel's command that does the same: the one that presses it, or that puts up the same card - with the same data first, else with any.
A panel's own page reads its commands' keys too (`PanelProps.keys`; `panelKeys` and `usePanelKeys` in `src/renderer/src/app/keyHints.ts`): each of its commands that has a key now, by its id in the manifest, drawn as this computer draws it, with its `aria-keyshortcuts` where one press makes it.
The window pushes them into the page's frame with its view state, again whenever a key changes, so a control in the page that does what a command does names that command's key; a crewmate's draft panel gets none, as its commands reach nothing.
A command that presses a button or asks the panel refuses while its panel is hidden or has nothing to show (for a panel whose own code decides, while it says it does not show, in the words it gave `rail.show` when it gave some); one that puts up a card refuses only while a recording runs, beside what holds every key.
A panel's page may also say one of its commands cannot run now, and why (`rail.refuse`), whatever the command does; command search keeps it listed with those words until the page takes them back.
A button that presses is pressed as the captain's key (`via: "key"`), its own click as `click`, so a panel may tell them apart: the Tasks panel's search opens and closes on its click, and its key always opens it.

### The Tasks panel's commands

The app's own Tasks panel is an ordinary panel folder (`docs/ui-plugins.md`, "The app's own panels are ordinary folders"), so its commands are a panel's, `panel:now/<command>`, read as the window's own where the catalog's commands for the stage end; the app adds its panels before any other, so the keys they suggest are theirs:

| Command | Does | Suggested key |
| --- | --- | --- |
| `panel:now/find`, Find a task | presses the header's Search tasks: the panel comes out of its collapse and opens its search with the caret in it, or puts the caret back; with nothing to list it refuses, "There are no tasks yet" | ⇧⌘F |
| `panel:now/board`, Open task board | puts the task board up at the front with focus on its tiles' stop (`docs/task-board.md`); the header's Open task board does the same without moving focus | ⌘B (kanban and columns find it too) |
| `panel:now/board-find`, Find on task board | the board, with the caret in its Find | none: chosen by name |
| `panel:now/board-backlog`, Show the backlog | the board, its Backlog list shown with focus on its rows | none: chosen by name |
| `panel:now/board-done`, Show done tasks | the board, its Done · 7d list shown with focus on its rows | none: chosen by name |
| `panel:now/board-dropped`, Show dropped tasks | the board, its Dropped · 7d list shown with focus on its rows | none: chosen by name |
| `panel:now/board-move`, Move the selected task | the board, the selected tile's ⋯ menu open with focus on its first entry | none: chosen by name |
| `panel:now/collapse-parts`, Collapse all parts | asks the panel to collapse every task with parts listed under it (`.claude/skills/infinitary-design/components/now/NowPanel.prompt.md`, "Parts"); focus on a hidden part goes to its task's row | none: chosen by name (fold, subtasks, children and hide find it too) |
| `panel:now/expand-parts`, Expand all parts | asks the panel to expand every collapsed task | none: chosen by name (unfold, subtasks, children and show find it too) |
| `panel:now/tag-filter`, Filter tasks by tag | asks the panel to open its search with focus on the tag row (`.claude/skills/infinitary-design/components/now/NowPanel.prompt.md`, "Tags"); while no tag row shows it refuses, saying why | none: chosen by name (tags and label find it too) |
| `panel:now/group`, Group tasks | presses the header's Group tasks: its menu opens with focus on the current choice, By status or By tag | none: chosen by name (sort, tags and order find it too) |
| `panel:now/board-tags`, Show tasks by tag | the board, its By tag view shown with focus on its rows; while no tags apply it refuses, saying why | none: chosen by name (tags and label find it too) |

The board's commands put the same card up with the place in its data (`{ "focus": "find" }`), and the board answers each time it is put up once (`card.revision`).
Once one has a key, the board shows it on its own control that does the same (`docs/task-board.md`, "Keys").
They were the catalog's `tasks.find`, `tasks.board`, `tasks.board-find`, `tasks.board-dropped` and `tasks.board-move`: a key a person saved under one of those is read as the panel command's (`RETIRED_COMMANDS` in `src/shared/keymap.ts`), unless the panel command has a saved key of its own, which wins.

### The Knowledge panel's command

In a build with knowledge to show, the app's own Knowledge panel (`docs/knowledge.md`, "The browser") adds one command, `panel:knowledge/open`, Open Knowledge: it puts the knowledge browser up at the front with focus on its shown tab's own stop (`{ "focus": "pane" }`), and has no default key, so it is chosen by name (concepts, findings, graph, learned and evidence find it too).
Inside the browser the graph is one Tab stop: the arrows choose concepts, Enter opens one in the inspector, Shift with the arrows orbits, + and − zoom, and Home resets the camera; the lists and the inspector's sections are one stop each, walked by the arrows; Escape goes from the inspector back to the pane, then clears Find, then hides the card.

## Chords

A `KeyChord` is a key and the modifiers held with it.
Cmd, Ctrl and Option must be held exactly as the chord says.
A letter matches in either case, with Shift only when the chord holds it; it is the layout's own letter, or the physical key's (`KeyboardEvent.code`) on a layout without Latin letters or under a modifier that types another character, so ⌃U still works on a Cyrillic layout.
A named key (`ArrowUp`, `F6`) matches by name, with Shift only when the chord holds it.
Any other character matches as typed, and Shift is part of the character, so `+` is one chord whether or not the layout needs Shift to type it.
A chord that holds Shift with a character is that character with Shift held, and nothing else, so ⇧⌘] is not ⌘].
While ⌘ is down a Mac reports the key's own character with Shift (⇧⌘] arrives as `]` with Shift), and other input, Electron's own `sendInputEvent` among it, reports the shifted character (`}` with Shift), so the card arrows hold both.
The card arrows go round past either end (INF-4541): ⇧⌘] on the last card shows the first, ⇧⌘[ on the first shows the last, and only a lone card refuses them, as the only card.
A layout whose brackets need another modifier reaches the cards through command search, or a key of its own recorded in Keyboard settings.

## Keys on each system

The catalog, and a panel's suggested key, are written as a Mac writes them.
Each computer's keyboard reads them through its key system (`KeySystem` in `src/shared/platform.ts`, from `desktopConventions`): a Mac's are the keys as written, and on Linux, and Windows when it comes, Ctrl takes ⌘'s place (the captain's pick on FI3-1432).
`systemChord` and `systemKeys` (`src/shared/keyboard.ts`) turn a chord that holds ⌘ into the same chord holding Ctrl, and leave out a chord a Mac holds ⌃ for, since Ctrl already holds ⌘'s place there.
So on Linux Ctrl+K searches, Ctrl+L goes to the main message and Ctrl+Plus, Ctrl+Minus and Ctrl+0 change the size, while the message box's Mac-style Control keys (Ctrl+U, Ctrl+K, Ctrl+W, Ctrl+Y and Ctrl+P) have no key; ↑ still brings back the last message.
`catalogKeys(id, system)` is a command's own keys on a system and `catalogBindings(system)` the catalog's; `DEFAULT_BINDINGS` is the Mac's.
The installed map resolves with the key system the app gives the shell (`ShellOptions.keySystem`, `InstalledKeymap`), and the page reads its own from `thisDesktop()` (`src/renderer/src/design/core/desktop.ts`) wherever it draws a key or judges one.
A key reads in its system's words: a Mac's glyphs (`⇧⌘L`), or the words Linux writes, joined by `+`, Ctrl, Alt, Shift and Super in that order (`Ctrl+Shift+L`, `Ctrl+,`, `Ctrl+Plus`), with Esc and Space in words and the arrows as ↑ ↓ ← → (`chordLabel(chord, system)`).
A message field's undo keys follow too (`historyKey`): ⌘Z and ⇧⌘Z on a Mac, Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y on Linux.
A Mac's app menu holds ⌘Q and ⌘W; Linux has no menu bar, so the window takes Ctrl+Q, which quits, and Ctrl+W, which closes the window, itself (`desktopKeyAction`, run by `followWindowCommands`).
The dictation key is right Ctrl on Linux by default, read as "right Ctrl" (`dictationKeyLabel`), because right Alt types accented letters on many keyboards there.

## Where a key is heard

A scope says where a command works, and the listener that hears a key says where it was pressed (`KeyContext`):

- `window`: anywhere in the focused Infinitary window, card and panel frames included.
  `followWindowCommands` hears these keys in the main process through `before-input-event`, before the page or any frame: Chromium hands the window a key typed into any of its frames, a sandboxed card's or a panel's served at a host of its own, before that frame sees it.
  A window command's key is the window's, held or not: `followWindowCommands` cancels it, so neither the page, a frame nor the menu sees it, and the command runs once.
  A held key runs the command again only when it repeats; otherwise the repeats are cancelled and run nothing.
- `message-field`: in the main message or a card's reply; `ComposerField` hears these, told by its host which field it is (`messageField`).
- `main-message`: in the main message only.

App-wide means the focused Infinitary window and nothing else: the app registers no system-wide shortcut and watches no keys while another app is active.

## Resolving a press

`boundCommand(press, context, bindings)` returns the command whose keys a press is, where it was pressed, held or not, and `commandFor` the command it runs, or nothing:

- during an input method's composition both return nothing, so the input method keeps every key it uses;
- they look only at commands whose scope works in the context;
- `commandFor` returns a held key's (`repeat`) command only if that command repeats (`runsOnPress`), so a held ↑ brings back the last message once and then moves the caret.

A message field's held key that runs nothing reaches the field (the caret moves); a window command's never does (above).

No two commands that can work in the same place share a default key; `src/shared/keyboard.test.ts` checks it.

## Handlers

A handler stays with the code that owns what it changes.
The size commands' handlers are `sizeCommands` in `src/main/windowSize.ts`, one set the shell holds (`Shell.size`) for every window's keys, the View menu and command search.
Each step is the `window-size` catalog change the Size picker makes, so it leaves the same trail, and a held key's steps settle into one line (`docs/renderer.md`, "Whole-window size"); the menu's accelerators are the commands' first keys (`menuAccelerator`).
`followWindowCommands` takes one handler for every window command, so a new window command cannot be left without one.
A message field's commands run inside `ComposerField`, which still decides whether the field takes them now (a read-only or disabled field takes no edit, and recall needs an empty field).

### Who runs a window command

A window command whose handler owns main-process state runs there (`runs: "main"`, the size commands), and so does one that presses a key where focus is, which only the main process knows (the movement commands and Cancel).
One that moves focus or changes what the shell shows runs in the shell page (`runs: "shell"`): its main-process handler, from `shellCommands`, sends the page the command's id alone on the `inf:keyboard:command` push.
The key, and anything typed, never leaves the main process, and only the page's own preload listens on that channel, so no card or panel frame hears the command.
For every key the window takes, the page is also told that it took one, never which (`inf:keyboard:taken`): after a key the window took, Chromium holds back every key's release until the next key goes down, so without it the dictation key would never learn that it was pressed with another (`docs/composer.md`, "Voice").
The page decides whether the command may run now, against the window as it is when the command arrives (`followShellCommands`): a key held by a refused command does nothing.
The key of a command the shell runs does nothing before the shell follows the commands, so the shell marks the document once it does (`data-window-keys="commands"`, `windowKeysMark.ts`), after one round trip to the main process, which by then holds every panel's keys the page told it before it drew.
While Keyboard settings records a key the mark reads `recording`, from the main process's answer to starting it until its answer to stopping it.
A person never sees the mark and nothing in the app reads it: the end-to-end tests wait on it before they press a key ("Tests", below).

`commandRefusal` (`commandRefusals.ts`) says why a command cannot run, in the words command search shows beside it, from the store and the window's facts (another modal dialog is open; a panel's command asks its panel, `panelCommandRefusal`).
What holds every key comes first: Settings picking the dictation key, then command search itself (only its own key closes it), then another open modal dialog (the picture viewer, the custom API form; Escape closes it first).
The main process's own commands, the size keys, are never refused by the page.

- `focus.main-message`, Go to the main message, is the way back from wherever focus is.
  It focuses the main message through the store's `focusMainMessage`, the same focus request a closing card uses, so the words, pictures, pastes and caret wait as they were.
  From Settings it goes home first.
  It does nothing while a recording runs, while Settings picks the dictation key, or while the main message is held: the first-launch gate is up, or the window has not yet read whether it is (`mainMessageRefusal`).
- `focus.card-reply`, Go to the card's reply, focuses the shown card's one field (`docs/card-authoring.md`, "The card's one field"), its words and caret as they were; from Settings it goes home first.
  In the Browser tab it focuses a docked card's reply field or, with no card docked, opens the Crewmate column and focuses its message box.
  `browser.page`, Go to the browser page, takes focus back to the page while you hold control; a request card's open-browser click puts focus there by itself once the page is yours (`docs/task-browser.md`, "Asking for help").
  Command search also finds it by "anything to add" and "comment".
  It refuses when no card is shown, when the shown entry takes no reply (a host card, a task record, a past card) and while a recording runs.
  It focuses the reply of the card that was shown when it ran, never another one shown since.
- `focus.card-body`, Go to the card's body, puts focus in the shown entry's body, a card's, a task's record or a past card, ringed inside its edge: the reading keys scroll it, and Tab goes on to its first control ("Cards and frames").
  The body takes focus only from this command, never from a click, so a click on a card's words never takes focus from the main message.
  From Settings it goes home first; it refuses when nothing is shown and while a recording runs.
- `focus.card-actions`, Go to the card's buttons, focuses the shown card's default button, or its first that can be pressed; it never presses one.
  It refuses when the shown entry has no buttons (a note, a task's record, a past card), while the card is still being written and while a recording runs.
  Like the reply, both act on the entry shown when they ran, never another one shown since.
- `cards.choice-1` through `cards.choice-4` press the shown card's footer buttons (`choiceOrder` in `src/renderer/src/cards/footerGroups.ts`). ⌘1 is always the card's default, wherever it is drawn, so a person can learn one key for the recommended step (the captain's ask: "the default should always be cmd+1, and the number should grow from the right to the left"). ⌘2, ⌘3 and ⌘4 take the other buttons from the right edge leftward, quiet actions included; a card with no default starts ⌘1 at its rightmost button.
  On Linux Ctrl takes ⌘'s place.
  A fifth button has no key.
  The press is that button's click: an unanswered required question on the default focuses the question and sends nothing, and a pending or disabled button does not run.
  They refuse in Settings, while a recording runs, while the card is still being written, when nothing is shown, when that place has no button, and while the other Mac is out of reach.
  A held key presses once.
  The button shows the installed key, and a person may change it in Keyboard settings.
- `regions.next` and `regions.previous`, Go to the next or previous part of the window, move focus between the window's parts ("Parts of the window"); they refuse only while a recording runs.
  The four directional part commands go the same way by where each part is drawn, and refuse only while a recording runs too.
- The movement commands and Cancel press ←, ↓, ↑, →, Home, End, Page Up, Page Down or Escape where focus is ("Moving by a key of your own").
- `cards.previous` and `cards.next` are the pager's own arrows, with the same slide; `cards.minimize` puts any shown card away without ending work or asking about retained drafts.
- `cards.minimize`, Put card aside (⇧⌘M), puts a decision aside, reads a note or hides a window panel through its shared corner; it never ends work.
- `cards.minimize-all`, Put every card aside or bring them back (⌥⇧⌘M, INF-4002), puts every card in the stack aside in one move while a card is shown, each through its own corner as `cards.minimize` would, and lands focus in the main message.
  On an empty stage it brings back every card put aside; cards the project focus holds back are neither put aside nor brought back.
  It refuses while Settings is open, in a view with changes off, and when no card is shown or put aside.
  A ⌥-click on a card's minus puts every card aside too, and the minus's label says so while ⌥ is held.
- `cards.done`, Press the note's Done or Got it, presses the shown note's footer button, or the host’s Done in an answer's record, and refuses when the card has neither.
- `cards.decline`, Decline every choice on the card, presses the shown decision's way to say no: its author's own marked choice or the app's Decline (INF-3108, `docs/card-authoring.md`); it refuses when the card has neither.
- `cards.maximize`, Maximize or restore card, is the card's size control (the design skill's `components/cards/ResponseCard.prompt.md`, "Maximize"), with focus on that control after it.
  The card layer lends these to the commands (`cardStage.ts`) and says which entry it shows; a command acts only while the store still shows that entry.
  They work on the home screen only, and an arrow refuses at the stack's end.
- `cards.show-info`, `cards.show-cards`, `cards.show-activity`, `cards.show-crewmate`, `cards.show-browser`, `cards.next-tab` and `cards.previous-tab` switch the shown task card's tab (`docs/task-card-tabs.md`).
  The card's strip lends itself to them while it is mounted, and they refuse when the shown card has no tabs, when it has no such tab, when the tab is already shown and when there is no other tab to go to.
  A tab a command chose takes focus, with its ring, on the strip the swap draws.
  On a card about a task - a crewmate's, the app's own, or a first mate decision whose buttons act on a task - each Show command opens that task's tab in front of the card, which Hide or Esc returns to (`docs/task-card-tabs.md`, "From a card"); the key in a crewmate's or the app's card's head is the same door for the pointer, and a Tab stop with Enter, while a first mate card names its tasks only in its words (INF-2714).
  They refuse on a card about no task ("This card is not about a task"), and Show Crewmate while no crewmate has run the task.
  The Crewmate tab's prompt keeps two keys of its own, as a message field keeps Enter: Enter sends its line to the crewmate, and ⌃C stops the crewmate's running turn, with Stop beside the hint for the pointer; Esc still hides the card (`docs/task-card-tabs.md`, "Typing").
- `cards.point-at`, Point at a part of the card, enters pointing from the reply row or command search with ⇧⌘A (Ctrl+Shift+A on Linux).
  The reply-row control shows the installed key, and the mode uses arrows, Enter and Escape inside the card body.
  Selecting words keeps their usual Copy behavior; Tab enters the popover's comment field.
  With the picture viewer open it turns Point at on for the shown picture instead, where the arrows show and move a box, Shift with the arrows sizes it and Enter opens the popover (`docs/card-threads.md`, "Pointing at a place").
  On a task's Browser tab it holds the page's picture still, where the arrows step through what the page's outline names, Shift with an arrow makes and sizes a box, Enter opens the popover and Escape ends it (`docs/task-browser.md`, "Pointing at a page"); with no page to point at it refuses in words.
- `viewer.save-picture`, Save the picture, is the picture viewer's Save to Downloads on the picture or recording it shows, with ⌘S (Ctrl+S on Linux and Windows) or from command search (the design skill's `PictureViewer.prompt.md`, "The picture's menu").
  It is one of the two window commands the open viewer takes, with Point at, and refuses in words while no viewer is open.
  The viewer's Copy picture is the system's own Copy key, ⌘C, which copies the picture whenever no words in the viewer are selected.
- `cards.thread`, Show or hide the card's thread, is the thread head's Collapse thread and the collapsed card's latest line in one key (`docs/card-threads.md`, "Collapsing the thread"), lent by the card layer like the arrows; on a browser view it opens or folds the docked card or Crewmate column (`docs/task-browser.md`, "The request beside the page").
  It refuses on a card that takes no reply or has no thread yet, and while a recording runs; a focused reply field keeps the focus, and otherwise focus lands, ringed, on what undoes it.
- `cards.thread-new`, Go to the thread's new messages, presses the shown card's jump down in its thread (`docs/card-threads.md`, "Keeping your place"); it is refused while the thread shows its foot.
- `cards.sound`, Play or pause the card's sound, presses the shown card's sound strip's Play, Pause or Replay; it is refused until a clip's Listen draws the strip ("This card is not playing a sound").
- `settings.open`, Open Settings, is the gear's own step; it refuses in Settings.
  The app menu's Settings… item shows its key and tells the page the same command when clicked.
- `settings.keyboard`, Open Keyboard settings, opens Settings at its Keyboard tab, with the caret in the tab's search; it works from Settings too.
  The app menu's Keyboard Settings… item tells the page the same command.
- `updates.later`, Update later, is the update panel's Update later: it lets an update go while it saves the crew's work, so nothing is replaced and the work carries on (`docs/alpha.md`, "Saving work before an update").
  It refuses unless an update is saving work ("No update is saving work now"); once the copy is being replaced it cannot wait.
- `updates.check`, Check for updates, opens Settings at General with focus on the Version row's next step and presses Check for updates, reading the release source now (`docs/alpha.md`, "Update channels"); it works from Settings too.
  It refuses on a copy whose installation the app could not confirm, which has no button.
- `updates.home`, Update the first mate's computer, opens Settings at General with focus on the row for the first mate's computer's update, on a Mac that controls another (`docs/view.md`, "Updating the first mate's computer"); it works from Settings too.
  It installs nothing: the row's Update asks first.
  It refuses where this window is the first mate's own, or the first mate there does not answer its update from here.
- `whats-new.show`, Show what's new, goes home and asks the core's What's new door for the newest release note that listed changes: an open note comes to the front of the stack, a closed one comes back read-only (`showReleaseNote`, `docs/release-notes.md` "Reading a note again").
  It works from Settings too, and refuses until a note was shown ("No release notes yet").
  The Help menu's What’s New in Infinitary tells the page the same command.
- `feedback.start`, Send feedback, goes home and starts `/feedback ` in the main message box with the caret after it, for the person's words (`docs/feedback.md`).
  It refuses, as Go to the main message does, while the box is held.
  The Help menu's Send Feedback… tells the page the same command.
- `firstmate.reply`, Open the conversation, goes home and opens the conversation at the front of the stack at its newest round, as a press on the newest round above the input does, after the lines have faded too and before anything has been said (`docs/composer.md` "The conversation").
  It works from Settings too, and before anything has been said it opens the conversation empty.
- `message.take-back`, Revert your last message, takes back the newest message while it may be, as the revert icon beside it does (`docs/composer.md` "Taking back").
  It refuses past one minute after the message was sent, once it is taken back, and on a view of another Mac whose changes are off.
- `settings.usage`, Open Usage, opens Settings at its Usage tab with focus on the unit switch; it works from Settings too (`docs/usage.md`).
- `settings.panels`, Arrange panels, opens Settings at its Panels tab with focus on its rows' stop ("Lists and Settings"); it works from Settings too, and on a Mac that controls another it arranges that Mac's own layout (`docs/view.md`, "Settings on a view").
- `settings.automation`, Open Automation, opens Settings at its Automation tab with focus on New automation; it works from Settings too (`docs/automation.md`).
- `settings.integrations`, Open Integrations, opens Settings at its Integrations tab with focus on its first row's chevron, or on its first chip while nothing is connected; it works from Settings too (`docs/integrations.md`).
- `secrets.move`, Move secrets from another tool, goes home and starts the ask to move secrets from another tool in the message box, for the person to name the tool, as Settings → Secrets' Move from another tool does (`docs/secrets.md`, "Bringing secrets from another tool").
  It is offered only where Secrets is, and refuses while the message box takes no words.
- Open Keyboard settings, Open Usage, Open Automation and Open Integrations put focus there once the tab draws it, which a window that paints late does many frames after the command (`openSettingsAt`).
  Focus a person has moved into the tab by then stays where they put it (INF-963).
- `automation.pause-all`, Pause all automations, opens the same tab and pauses every running automation, as its Pause all button does; drafts, paused and done ones stay as they are.
- `ambient.toggle`, Play or stop ambient music (⌥⌘P, INF-5053), turns Settings → Appearance's Ambient music switch on or off, as the top bar's sound button does (`docs/ambient-music.md`).
- `ambient.style`, Choose ambient music (INF-5610), turns the music on if it was off and opens the sound button's style list with focus on the chosen style (`docs/ambient-music.md`, "Turning it on").
- `usage.unit`, Switch Usage units, switches every amount in Usage between tokens and estimated dollars, which the core keeps, and opens Usage the same way.
- `allowance.recheck`, Recheck allowance, reads which login each account's store names and its allowance again, the way the spent-allowance card's button does, so a switched Claude login is heard at once (`docs/quota.md`, "A changed login").
- `devices.try-again`, Try again to reach your computers, opens Settings at Devices and tries this Mac's own SSH connection once more to every Mac it stopped trying (`docs/devices.md`, "Through the home's SSH").
- `project-focus.open`, Focus on a project, opens the top bar's project pill into its row with focus on the checked pill, where the arrows, Home and End move and Enter picks (`docs/project-focus.md`); it refuses in Settings and while there is only one project.
- `project-focus.clear`, Show all projects, lets the window's project focus go; it refuses while every project is shown.
- While Keyboard settings records a key every shell command refuses ("Settings is recording a key"), after the dictation key's pick.

## Parts of the window

F6 goes to the next part of the window and ⇧F6 to the previous one (`regions.next`, `regions.previous`), from wherever focus is, a card's or a panel's frame included, as F6 moves between panes in other desktop apps.
On a Mac F6 may need Fn, so like any key it can be changed in Keyboard settings.

The parts go in the order a person reads the window:

- home: the create-your-own-panel slot while it shows, then each side panel on the left rail, top to bottom, then its More row while present; the shown card; each side panel on the right rail and its More row; then the main message;
- Settings: its tabs, then the open section.

`moveToRegion` (`src/renderer/src/app/regions.ts`) reads the parts from the window as it stands: each part's root carries `data-window-region` with its kind (`panel`, `card`, `main-message`, `settings-tabs`, `settings-section`), painted by the code that draws it (`SidePanelChrome`, `CreatePanelSlot`, `StageEntry`, `HomePrompt`, `SettingsScreen`), so the module keeps no list of its own.
A part that is hidden, inert, held transparent (a card selected but not ready to appear) or not drawn is skipped, and so is the main message while it is held (the first-launch gate, or a window that has not read it yet).
A side panel on a folded rail is hidden, so it is skipped until the rail opens again (`docs/renderer.md`, "Docked rails and the input's room").
From outside every part (the top bar, nothing), F6 starts at the first part and ⇧F6 at the last.

Go to the part of the window on the left, below, above or on the right (`regions.left`, `regions.down`, `regions.up`, `regions.right`, `moveToRegionToward`) go to the nearest part drawn that way from the part that holds focus, or from the middle of the window when none does.
A part counts as that way when its middle lies beyond the current part's middle; the nearest is the one with the smallest gap that way plus twice how far it sits off to the side (`regionDistance`), so a part straight ahead wins over a nearer one off to one side.
A part that refuses focus is passed over for the next nearest; where no part lies that way, focus stays.
They have no keys of their own: a person gives them keys in Keyboard settings or runs them from command search.

Focus enters a part where a person starts in it:

- the main message, through the store's `focusMainMessage`, with its words, pictures, pastes and caret as they were;
- the shown card itself, its whole surface ringed, so Tab goes on into the card from there;
- a side panel: while it is collapsed, its chevron; with a frame, the panel's mount gives the frame focus and asks the panel (`railStore.askBodyFocus`, `PanelProps.asks.onFocus`), and a panel that listens puts focus where a person starts in it - the Tasks list's stop, the Activity list - while one that does not keeps it where it last had it; in the window, its first control, and the panel is asked too;
- the create-your-own-panel slot, which has no header or body: its first control, the slot itself, where Enter or Space starts the ask as a click does (`docs/first-launch.md`); Tab goes on to its Hide;
- Settings' tabs: the chosen tab; the open section: its first control, or a frame.

The main process hears F6, so the page never sees the key, and a focus a script moves shows no ring unless it is asked to: every landing goes through `focusWithRing` (`src/renderer/src/design/focus.ts`), which asks Chromium for the ring (`focusVisible`).
A panel's page counts an ask for focus it was born with as an earlier one, never a new one.

## Moving by a key of your own

Move left, down, up and right, Move to the start and the end, Move up and down a page, and Cancel (`move.*` and `cancel` in `src/shared/keyboardCommands.ts`, `MOVE_KEYS` in `src/shared/keyboard.ts`) let a person move with keys of their own, such as Emacs's or Vim's, everywhere the arrows, Home, End, the page keys and Escape work today: the Tasks list, the task board, Settings' tabs, a card while it is read, a card's question options, command search's rows and the Tasks search's.
They have no keys in Legacy, so nothing changes until a person gives them some.

The main process runs them, because only it knows which document holds focus (`pressMoveKey` in `src/main/keyboard.ts`):

- focus in the window's own page: the main process presses the key itself there (`sendInputEvent`), so it does there all the key does, a text field's caret included, and the page cannot tell it from the key pressed;
- focus in a card's or a panel's frame: Electron presses keys only into the window's own page, so the main process names the frame that holds focus (its trusted UUID name, the top frame inside the window's page) on `inf:keyboard:move`, the page hands the key to that frame's bridge only while that frame still holds focus (`moveInFrame`, `FrameController.move`), and the bridge presses it where focus is inside the frame.

In a frame the bridge dispatches the key to the frame's own handlers as an untrusted key press; a handler that takes it (calls `preventDefault`) has the key.
Otherwise the bridge does the browser's own job for the key: it steps a radio group's checked option and a menu list's choice, moves a text field's caret, and scrolls the nearest scrolling box, or the page, a line, a screen or to an end.
Escape a frame's handlers leave alone goes on to the bridge's own Escape, which leaves the body for its card, as the real key does.
A key the main process pressed is the page's alone: it never runs a window command or a not-typing key in turn (`pressedForMoves`), so a key of a person's own on Home or End never presses another movement.
A held movement key repeats as the arrow does; Move to the start, Move to the end and Cancel press once.

## Lists and Settings

In Settings → Devices, Tab reaches Map, List and the device buttons.
On a device button, ↑ and ← go to the previous device, ↓ and → go to the next, and Enter selects it in the inspector.
Map and List keep the same selection.

A list is one Tab stop, and the arrows move through it, as lists do on a Mac.

- The Tasks list (`src/panels/now/panel.tsx`, its keys in `nav.ts`): ↑ and ↓ move between the rows and the headers of the groups that open and close, Home and End to the ends; → opens a closed group and then steps into it, ← closes an open one and goes up from a row to its group's header; on a task with rows listed under it ← collapses it and → expands it first, and from a part ← goes to the row it is listed under (INF-3823); Enter opens the row's task as a click does; on a backlog row → moves to its Start, which Enter presses and ← leaves, and focus follows a task that starts to its row in its new group; → then reaches the row's pin (every row's first → where it has no Start), which Enter pins or unpins, and focus follows the row into or out of Pinned (INF-3127).
  A row's stop is its task's, whatever group lists it, and the stop focus was last on stays the list's Tab stop while it is listed (`rovingKey`), so F6 away and back finds it again; while its task sits in a closed group, that group's header holds the stop.
  A group that is always open has a label, not a stop.
  Focus resting on a row whose task moves to another group (queued to working as its crewmate begins) stays on its row there, or goes to the header of the closed group it moved into; a row that leaves the list hands focus to the list's stop as it then stands.
  In the Tasks search, ↓ goes to the first match, and Esc empties its words, then closes it; Close search, the next stop after the field, closes it too, and closed from the keyboard, focus goes to the list's stop.
  A row the keyboard rests on opens its summary beside it, as the pointer's rest does (`point.peekTask`), and Esc or leaving the row lets it go; a row's name carries its status, and the summary shows that status, the full title and the project.
  That summary goes with its row as the row moves, into another group too, and a summary Esc closed stays closed.
  Keyboard navigation and keyboard focus recovery reveal the row in the panel, across the frame.
  After a pointer Start, focus follows the task without scrolling the panel away from the remaining backlog rows.
- The task board's tiles and rows (`docs/task-board.md`, "Keys") are one stop, the selected tile or else the first: ↑ and ↓ move within a lane and onto its other pages, Home and End to the lane's real ends, ← and → to the nearest drawn tile in the next column that has one, ↓ from Waiting on you's last row into the first column and ↑ from a lane's top back to it; Enter opens the tile's task as a click does, Space opens its ⋯ menu (a RowMenu whose kebab is out of the Tab order, focus back on the tile when it closes), and ↓ in its Find goes to the tiles.
  The tile the keyboard rests on opens its summary beside it, and Esc closes the summary, then clears Find, then hides the board.
- The Activity list is one stop: the arrows and the page keys scroll it, and while it has the keyboard's focus every line reads in full.
  Each task key on its lines is a Tab stop of its own after it, as in a card's body (FI3-1271): focus on one opens its summary beside the panel, Enter opens its task, and F6 leaves for the next part of the window.
- A task key anywhere else the app draws one - a thread line, a card's title, the record's Now line and body, a Knowledge inspector line, a Usage row, a refusal - is a Tab stop too (the design skill's core rule "Task keys"): focus on it opens its summary as the pointer's rest does, Esc or leaving it lets it go, and Enter opens its task; a key in Settings leaves Settings for it.
- Settings' tabs run down a column on the left and follow the vertical tabs pattern (`tabStep`, `aria-orientation="vertical"`): one Tab stop, the chosen tab; ↑ and ↓ move to the previous and next tab and open it, wrapping round, and ← and → do the same; Home and End go to the ends.
  Each tab names the section it opens (`aria-controls`), and the section is a `tabpanel` named by its tab.
- The models board: a model chosen with the keyboard (Enter or Space on its pill) opens its levels with focus on the first level, the keyboard's way to do what a drag does; Escape there closes the levels alone and goes back to the pill.
- Usage: a model's name is a button; Enter or Space opens its details with focus on Close details, and Escape closes them alone and goes back to the model (`docs/usage.md`).
- The Macs nearby under Settings -> Devices' address field (`docs/devices.md`, "Macs nearby") are one stop, the row last focused or else the first: ↑ and ↓ move between rows, Home and End to its ends, ↓ in the address field goes to it and ↑ from its first row back to the field; Enter picks the row as a click does (`nearbyStep`).
- The computers nearby under the first launch's address fields, Join by its address and Another computer's "Set me up on another computer" (`docs/first-launch.md`, "Setting it up from here"), keep the same keys; the setup's seven steps are words, not stops; its key line puts focus on Cancel, so Enter never says yes to a key unread, and each other question and stop puts focus on its first button, so Enter answers it and Tab reaches Ask again, Set it up with commands and Back.
- Settings → Panels' rows (`src/renderer/src/settings/PanelsTab.tsx`, INF-2344) are one stop, the row last focused or else the first: ↑ and ↓ move between rows across the four groups, Home and End to the ends (`rowStep`); ⌥ with an arrow moves the row's panel one place in the saved layout, ↑ and ↓ through its rail as one column and ← and → to the middle of the same group on the other rail, with focus staying on the row (`stepPanel`, `panelStepOf`); Space hides or shows the panel and Enter collapses or expands it.
  The same ⌥ and an arrow on a panel's header chevron moves it on the rails, with focus staying on the chevron; the header's drag is the pointer's way to do it (`docs/ui-plugins.md`, "Arranging the panels").
- Settings → Projects' list is one line per project, each its own Tab stop; Enter or Space on a line opens that project's page with focus on Back (`ProjectsTab.tsx`, `ProjectPage.tsx`).
  The page's strip of repository tabs is one Tab stop, the chosen tab: ← and → move between the tabs, wrapping round, Home and End go to the ends, and Enter or Space chooses one; Tab goes on to Add a repository.
  Escape on a page goes back to the list with focus on that project's line, and Escape on the list closes Settings.
- Every other list in Settings (the Keyboard settings rows, the accounts, the devices) keeps Tab through its controls, because each row holds several.

### Seeing where focus is

Every control the keyboard reaches draws the design system's `--focus-ring` on `:focus-visible`, never the browser's outline: the window's stylesheet (`design/styles.css`) and the panel stylesheet (`panelStylesheet`) carry the same rule, as the card frames' stylesheet already did.
An input keeps its own focus style; a message textarea turns off its own shadow because its surrounding shell draws the ring.
A pill draws its unseen radio's ring, and the Reduced motion badge, which unsets its own styles, draws the ring itself.
What an edge would cut, a card's body, the Activity list, a Tasks row or group header and the Models heading, draws the hairline and its glow inside its own edge (`--focus-ring-inset`).
Focus is the ring, never the open task's tint: a Tasks row whose record is open keeps its accent tint, and the ring is drawn over it.
An icon button the keyboard rests on shows its words and key as the pointer's rest does (`useRestLabel`, `restLabel.ts`).

### Facts shown on rest

A fact the app shows only on rest - a mark's meaning, a quota's reset time, the exact time behind a short age, why a chip, a button or an account cannot be used yet, a page's title and address, words cut short - is reachable from the keyboard and readable by assistive technology too (FI3-864, INF-27).
The element that holds it is a Tab stop of its own, and the keyboard's focus on it shows the label the pointer's rest shows: the one the app draws for an icon button (`useRestLabel`, `src/renderer/src/design/core/restLabel.ts`), never the native title.
Leaving the element or any key lets the label go; Esc while it shows lets it go and nothing else, as a summary's Esc does (`fact`), and with nothing showing Esc means what it always meant, such as closing Settings or the record.
The label is decoration hidden from assistive technology, so the element's accessible name or description carries the same words.
Words cut short are a stop only while they are cut (`useCutWords`, `overflowTitle.ts`); assistive technology reads them whole from the page.
A control that cannot be pressed for a reason is marked off rather than disabled: it stays a Tab stop, `aria-disabled` and dimmed as a disabled one is, its reason on rest and as its description, and a press does nothing (`Button`'s `off` and `note`, `IconButton`'s `off`, whose label says why).
A fact that sits inside another control rides that control: the control's focus shows it, and its description carries it.
The task record's body is a page of its own, which the window's label cannot reach, so it draws the same label in its own page, on the same rest, with the same keys (`restLabel` in `record.frame.js`).

- Settings -> Intelligence, an account's row: its status dot (`StatusDot`'s `focusable`), the ✱ crew work prefers and the first mate tag, each named by its meaning, and each quota meter that has a reset time, named by its window, what is left and the reset (`quotaMeterName`).
- Settings -> Intelligence and the first-launch gate: a provider chip that cannot be pressed stays a stop, marked `aria-disabled` rather than disabled, with its reason on rest and in its description; an account the gate shows in a chip's place says why it cannot answer yet the same way.
- Settings -> Projects: the projects folder's path while it is cut; a custom API's model rows' dots in its form.
- Settings -> Integrations: another computer's own GitHub row's status dot.
- The task record: the ages of Now, Progress and each finished item, each named by the short age and the exact time, and the checks' words, named by their words, when they started and when they were last read; the crew summary, which takes neither pointer nor keyboard, names them for assistive technology alone.
- The record's key and a past card's strip while they are cut, and a task browser's status line with the page's title and address.
- The task record's body: every age, on an Activity or ask line, a closed task's line and a card's line, named by the short age and the exact time; an Activity line that opens is itself the stop, and its age's name reads in the line's.
- A card's buttons on a computer that controls another (`docs/view.md`): while changes are off each is marked off with the reason as its description, and on rest too unless the notice under the top bar already shows that sentence whole; a button done only on the other computer says so on rest.
- Settings -> Intelligence, a custom API connection: Resume while its models are unchecked, and a model's First mate choice while it cannot be used, each with why.
- The models board: a new model's note, which its pill carries in a level, and a pill's ×, whose label says it removes the model from that level only.
- A task's browser: Back, Forward and Reload while someone else drives, their labels saying who.
- The picture viewer: Actual size on a picture shown at its own size.
- A side panel's busy dot, while its work runs.
- A panel's status mark, named by its most urgent line; Enter or Space opens its details, and Esc closes them with focus back on the mark (`docs/personal-panels.md`, "The status mark").

A dot inside a control, or one whose words are already written beside it, stays out of the Tab order: an Activity line's kind dot is such a dot, because the line's own words say what its color does, so it shows nothing on rest.

## Cards and frames

The shown card is one of the window's parts, and inside it a person reads its body, answers its questions, presses its buttons, replies and opens its pictures, all from the keyboard (FI3-800 piece 6).

- F6 lands on the card whole, ringed; while it holds focus the reading keys scroll its body (`readingScrollTop`): ↑ and ↓ a line, Page Up, Page Down and Space (⇧Space back) a screen, Home and End to the ends.
  Tab goes on into the card from there.
- Go to the card's body, Go to the card's buttons and Go to the card's reply (⇧⌘L) go to the card's own places (`toShownPart`), each found inside the `StageEntry` that names the entry; a prepared, leaving or not-yet-ready entry is inert and takes none.
- A button pressed with Enter or Space is the click itself: it reads the body's answers fresh, a default with a question unanswered puts focus on that question inside the body instead of sending, a default sent with every answer given leaves focus in the window's own page, the shared minus preserves picked answers without a close question, and a choice carries the offer the card showed (`docs/card-evidence.md`, "What a click carries"). ⌘1 presses the default and ⌘2 through ⌘4 the other footer choices from right to left, through that same click, and the button shows the key (`cards.choice-1` and the three after it).
  They work from inside the card's one field too, which Tab reaches after the body's last control and before the buttons, so its words go with the choice; Enter there sends them as a reply instead.
  Chat, after the choices, takes no number key: it shows ⏎, which does the same from the field.
- A held key presses a control once: the window drops a held Enter's repeats on its buttons and links (`guardHeldPresses`), and a message field's held Enter sends once (`enterAction`), so an Enter held on a button that closes its card never sends the main message focus goes back to.
- Enter on a card's edge, once Tab has reached it, gives the card back the width the host chose, as a double click does; the arrows, Home and End move it.
- The size control, Maximize card, sits right before the card's put-away control, and the keyboard's focus lands on it after each change of size, by click, command or Escape.
  While the card is maximized the side panels and the main message are hidden, so F6 finds the card alone, and Tab and ⇧Tab go round the card, its thread and its pager: a focus guard at each end of the card layer (`FocusEdge` in `stage/CardEdges.tsx`) passes focus to the other end.
  An Escape nothing in the card used restores it (`App.tsx`): the picture viewer, command search and a card's own controls take theirs first, an Escape in its body leaves the body for the card first, and a task's record or a panel's card restores before a later Escape hides it.
  Under a preset with a not-typing binding (Vim, tmux, Emacs) that Escape instead goes to the card and stops there, from the card itself, its controls, its reply or a panel card's page alike (`escapeToMaximizedCard`), so the reading keys go on scrolling it; Maximize or restore card's key (⌃W O under Vim) or Restore gives the size back.
  Go to the main message, and anything else that asks for the main message, restores the card first, and so does going to Settings.
- A merge card's risk chart puts each of its dots in the Tab order right after the card's put-away control: the keyboard's focus on one opens its note as the pointer's rest does, Esc lets the note go and nothing else, and a dot reached while the body is scrolled brings the chart back (`docs/card-authoring.md`, "The risk chart").

Inside a card's body the bridge completes the keyboard (`src/shared/plugins/frameKeyboardScript.ts`, with the pictures' Tab stops and the demos' Play buttons in `framePictureScript.ts`), once the host says which of the body's keys it hears (`keys`, sent to a mount that opens pictures or hears Escape):

- every picture a click would open is a Tab stop, still an image named by its alt, that Enter or Space opens in the picture viewer; a group's pictures past the fifth thumbnail stay off the Tab order, and the viewer's arrows reach them;
- a demo's Play button, which the bridge draws under its poster, is a button like any other: Enter or Space opens the viewer playing it, and the viewer's focus starts on its play control;
- a task key the keyboard moves focus to opens its summary beside the card once the window has brought it into view, as the pointer's rest does, and Esc or leaving it lets it go;
- an Escape nothing in the body used leaves the body for its card, ringed: not one the body's own script took (`preventDefault`), one an open dialog or popover takes, one that clears a search field, one an input method composes, a held one, or the Esc that let a task key's summary go.

Focus that leaves a frame for an overlay comes back into it.
The bridge keeps the element that last had focus in its document, and a text field's caret, until a press elsewhere in the body.
A page whose process has not yet been told it holds the window's focus moves focus inside itself without a `focusin`, which Chromium sends only once the page is told, so the bridge also keeps the element focus leaves, unless a press in the body moved it.
A part of a body opened full screen (`docs/card-authoring.md`, "A part full screen") takes the keyboard in its own frame on the picture viewer's surface: focus goes into the copy once it is drawn, the part's own keys work there (the map's arrows, `Enter`, `Backspace` up a level, `[` `]`, `+` `−` `0`), Tab moves between Close and the copy, and `Esc` closes it at once, from the copy or the surface.
On close the card's map goes where the copy was left and its Full screen button has focus again.
When command search or the picture viewer closes and the frame had focus, `giveFocusBack` focuses the frame and sends its bridge `focus`, and that element takes focus again with its caret where it was, a card's or a panel's frame alike, unless focus has moved on from the frame by then.

Focus the window's own page takes from a frame comes back into it too.
Every card's and panel's page runs in a process of its own, and Chromium tells a process where focus is only when focus moves from one page to another.
A page born while the keyboard is in another page, such as the card the stage prepares behind the task board, has not been told, so the next time the window is focused, as when it comes forward, it gives the focus to the window's own page.
The page that held it then loses its control, and keys reach nothing.
Where the window's focus rests depends on how focus went into the frame, on a Mac and on Linux alike.
After the shell's own move it rests on the frame element: `guardFrameFocus` sees the window's page take focus onto a frame and still hold it there a frame later, gives the frame focus again and sends its bridge `focus`, so the control it held takes focus again as after an overlay.
After the captain's own click or key inside the frame it rests on nothing.
So the window's page notes which frame holds focus each time it lets focus go, and again each time a frame posts it a message, because focus moves from one frame to another without the page hearing it; a message only makes the page look, and moves nothing.
When the page takes focus onto nothing with no press in it, it gives focus back to that frame the same way, unless something else has taken focus by the next animation frame (`giveHandedFocusBack`).
It gives that focus back through the frame's own window, as the captain's click had put it there, not by focusing the frame element: focus put on the element would stay the page's active element after the captain's next click into another frame, so the window would go on naming the first frame, and F6, the window's gates and the frame guards would count from where the captain no longer is.
The lost-focus fallback asks it first (`guardLostFocus`), so neither the main message nor the shown card takes that focus in its place.
A click in the window's own page is the captain's: it clears focus off the frame first, or calls off giving focus back, so focus stays where the click put it.

A card the captain points at - from a Tasks row, a task key, a record's Show the card - comes forward and takes the window's focus once it appears (`focusCard`), and so does a card the first mate brings forward.
It takes focus only if the captain began no other press since the pointing: a click or key that has begun decides where focus goes.
A card that took focus in the middle of that press would turn away the click it ends in, such as one on the next Tasks row, because a frame's click counts only while its frame holds focus (INF-551).
The window counts each press as it begins, a pointer going down or a key that is not a held key repeating, on its own page and inside every frame, whose bridge says so (`pressed`; `src/renderer/src/app/presses.ts`).
So the card still comes forward and shows, and focus stays where the captain's press put it.
A frame's notice reaches the window in the order the frame sent it, but the frame's process can send it late, after the window has read the task pointed at and drawn its card (INF-1146).
A pointing from a panel therefore asks that panel's frame to answer (`hearFrameOut`, `FrameController.heard`), and the card decides on focus once every frame asked has answered, while it is still the card shown for that pointing.
The request for focus belongs to the visit it was made for: when another card or a record comes forward before the card appears, the request is let go, so it never takes focus on a later visit.

Focus stays put when a push draws a task's record anew.
The record builds its Activity lines, its Cards and Knowledge used rows, its Details and the keys in them again with each push, so the control the keyboard held would leave the page with its old line.
Before it draws, the record notes that control's place: the part of the record it sits in, and its turn among that part's controls that read the same.
Once the bridge has linked the new keys, the control in that place takes focus again, only while the record's frame still holds the window's focus (`record.frame.js`, FI3-1279).

A frame's own script can say anything, so these focus requests move focus only inside itself or out to its card; a separate witnessed key offer is described below.
A frame's gesture that opens something over the window or in the browser, or moves the captain's focus, counts only while that frame holds the window's focus, which the captain's own click or key gives it (`whenFrameHoldsFocus`): opening a picture, opening a task, opening a link, leaving the body.
A frame's own script cannot take that focus itself: only the captain's click or key, or the shell's own move, puts focus in a frame (`docs/ui-plugins.md`, "Focus and the frames"), so a card's or a panel's script also leaves the main message its focus, its caret and the keys typed next.
That holds right after the captain's own click or key in the frame too: as focus comes back to the window's own page, as the pointer leaves the frame for the page's own content, and as focus moves on to another frame, the shell spends the user activation the click or key gave the frame (`guardFrameActivation`).
A click focuses its frame and posts its message at once, and the two reach the shell separately, so the shell waits a few frames for the focus before it counts the gesture as not the captain's.
A message from a document the card has replaced, or from a card the stage prepares or keeps drawn while it leaves, is refused as before.
The window's own keys (F6, ⌘L, ⌘K) are the main process's, so a script that keeps every key it hears cannot keep the captain in its card.

## Moving between a card's questions

A decision whose body asks several questions is answered from the keyboard alone, one question after another (INF-3963; the captain: "a user to easily switch between decisions, and change their options all using keyboards smoothly").
A question is one named group of the body's controls, as the footer's picked count counts them, in the order the body draws them.

- ⌘J goes to the next question and ⇧⌘J to the previous one, from anywhere in the window while a card whose body asks questions is shown; each preset adds its own keys beside them ("Presets").
  Focus lands on the question's picked option, else its Recommended option, else its first control, and landing picks nothing.
  The question comes into view, inside an opened `<details>` if it sat in a closed one, and its box shows the revision highlight for a moment.
- Next past the last question puts focus on the card's default button, which nothing presses; next from the card's buttons starts again at the first question, and previous from them at the last.
  Previous from the first question stays there.
- Go to the next unanswered question goes on to the next question with no answer, going round past the last; it has no key of its own and is the footer count's click.
- Inside the body the bridge adds the question keys a form lacks (`src/shared/plugins/frameScript.ts`): Enter on a radio option takes it and goes on, Shift+Enter goes back and takes nothing, and Enter on a checkbox, a closed select or a one-line field goes on without changing it; a multi-line field keeps Enter for a new line, and a Something else row stops at its own field.
  The number keys 1 to 9 on a radio or checkbox question take that option, a checkbox's as a tick or an untick; the arrows move between a question's checkboxes without ticking them, and ↑ at the start of a Something else field goes back to its row.
  A key a modifier holds, one an input method composes, one the body's own script took, and every key once the card is answered pass these by.
- On a card whose body is not a playable preview (`isPlayableBody`) the footer's picked count is the pointer's stepper (`QuestionStepper.tsx`): the count goes to the next unanswered question, and from two questions on the arrows beside it go to the previous and the next, round past either end; a pointer's step brings the question into view and leaves focus where it was, the main message's caret included.
- The commands are refused, with the reason command search shows, while no card is shown, while the shown card's body asks no questions or is a playable preview, and while a key is being recorded (`commandRefusals.ts`).

The shell asks the shown body through `askQuestionStep` (`questionEvent.ts`), and the card takes the step through its frame's `question` message, which the bridge answers with `questioned`: the box of the question it landed on, or the end (`bridge.ts`).
A frame's own script cannot take focus, so a step by a key gives the frame focus first and its bridge then moves focus to the question (`useQuestions` in `PrototypeBody.tsx`).
On the iPhone and iPad the footer's count is the same stepper, drawn by the phone's own card (`PhoneCards.swift`, `docs/ios.md` "Cards on the phone"): every step goes round past either end, since the phone's choices hold no keyboard focus to rest on, and ⌘J and ⇧⌘J from a keyboard give the body focus so its bridge's keys answer the question.
The phone asks through its card page's `question` (`ios/Infinitary/CardRuntime/cardHost.ts`), and the card's one scroller brings the question's box into view, as it does a body's own Enter or Shift+Enter.
A question's radio and checkbox options are not typing ("Keys used when not typing"), so a digit there would reach a person's own bare digit key; the bridge takes the digit first when it names one of the question's options, and the body's key is then its own, while a digit past the last option still reaches the person's key.

## Finding in the shown card

The words a card shows are found from the keyboard, as a browser finds words in its page (the captain: "cmd + f search functionality within cards").
One finding runs at a time, in whichever entry the stage shows: a card, a past card, the conversation, or a task's record or Crewmate tab.

- ⌘F, or the magnifying glass just before Maximize in the head, opens a find field in the head in place of the meta line, the task's key and the model chip, so nothing under the head moves (`CardFindField.tsx`).
  Focus goes into the field with its words selected; ⌘F while it is open selects them again.
- Matching starts as the person types and ignores case, accents and curly quotes (`findMatches` in `src/shared/cardFind.ts`); the field counts "2 of 7" in reading order, title, body, facts strip and thread, or says there are no matches.
- What is read is the words shown: prose, code, tables, a figure's labels, a folded section's summary and its words while it is closed; never a script, a style, a field's value, a picture's description or words hidden on their own (`visibility`, `display: none`, `hidden`), which no opening shows.
- Enter or ⌘G goes to the next match and Shift+Enter or ⇧⌘G to the previous one, round past either end; the current match comes into the part of each scroller holding it that a person reads, clear of what an outer box or the window cuts off, and a closed folded section that holds it opens and stays open.
- A new revision, a task record's update, a new message in the thread, another tab and another card shown find again; a page that redraws itself on its own is not read again until one of these.
  The current match keeps its place where it still is, and one still on its way into sight gets there; on another card or tab the last one's matches go at once and its words are looked for anew from the first match.
- One Esc, or Close, closes the field back into the magnifying glass, clears every highlight and gives focus back to what had it before ⌘F, or to the magnifying glass when it was pressed; Esc does nothing else.
  An Esc nothing else used, from the field's buttons, Maximize, the card, the card's body or a task record's page, closes the field before it would restore or put away the card or leave the body (`App.tsx`, `PrototypeBody.tsx`, `RecordCard.tsx`).
  While new words are being read the count is blank and Next and Previous wait, so no step lands on a match of the words before.
- Every match is drawn with the CSS Custom Highlight API in `--accent-dim` and the current one in `--accent`, never written into the page, so it never mixes with Point at's marks.
- The commands are refused, with the reason command search shows, while no card is shown or Settings is open, on a panel's card, on a task's Browser tab (a picture of a page), and Next and Previous while the field is closed (`commandRefusals.ts`).

The window's own words are matched in the window (`cardFind.ts`).
A card's page never receives the words typed: its bridge hands out the words it shows on `find-read`, the window matches them, and `find-mark` sends back only where the matches are, as offsets into those words; the bridge draws them, opens the folded section holding the current one and answers `found` with its box (`frameFindScript.ts`, `bridge.ts`; `docs/live-prototype-security.md`, "Finding in a card").
The phone has no find field.

## Where focus lands

A shortcut never changes whether a person is typing while a card is left to act on.
It may move focus to the thing it acted on; only the person moves the caret into a text field or out of one.
This holds in every preset, so a key that pages, answers or puts a card aside can be pressed again at once, with no Escape between.
A key that leaves no card on screen, such as one that answers or puts aside the last card, puts the caret in the main message, so the words typed next reach it, as after a pointer click.

One owner keeps one fact about the last place focus rested: whether the person was typing there (`src/renderer/src/app/focusLanding.ts`).
Focus rests while typing in a text-like control (`typingTarget`, the same test the keys used when not typing make), inside a frame, whose control the window cannot see, and wherever a pointer put it.
Only a key, or code that rings focus as a key would (`focusWithRing`), leaves the person not typing.
That includes a key the window's page or a card's frame offers the window ("Keys used when not typing", `offerNotTypingKey`): each document offers a key only from a control that is not a text field, so the offer shows the person is not typing there, whatever a frame or a pointer left behind.
So a plain key such as Vim's Shift+L, pressed on a link, button or checkbox in a card's body, or on a card button a pointer focused, pages to a card that takes focus, and the same key pages again.
In a text field the key is the field's and is never offered, so it types there and the fact stays typing.
Command search is left out of the fact, because it gives focus back itself.

When the control holding focus goes away, as when the shown card pages, is answered or is put aside, the lost-focus fallback (`guardLostFocus` in `src/renderer/src/app/focusRecovery.ts`) lands by that fact:

1. Typing: the main message, its words and caret as they were.
2. Not typing: the shown card, whole and ringed, never one of its buttons, so a held Enter cannot answer it.
   While the card that takes its place is drawn but not ready, focus waits on the card area (`[data-stage]`), out of every field, and lands on the card once it is.
3. Not typing and no card left, as when a key answers or puts aside the last card: the main message, in every preset, plain keys installed or not.
   Escape in the main message still leaves it for the empty card area, where plain keys work ("Keys used when not typing").

Focus that rests anywhere else, such as in a side panel, stays there when a card changes: the card stack never asks for the main message.
Closing something that opened over the work returns focus where it was: command search gives back the control it remembered ("Command search"), and leaving Settings lands by the fact from before Settings opened, in the main message when no card is left.
A pointer click that removes its own control, such as Got it, leaves the caret in the main message.
A card the person points at, and a card the first mate brings forward, still take focus ("Cards and frames"); sending, starting a draft and recall still focus the main message.
Dictation writes into the field that has focus - the main message, a card's reply, a note's comment or the crewmate's message box - and that field keeps focus; with focus anywhere else the words go to the main message, which takes focus (`docs/composer.md`, "Where the words go").

## Command search

`commands.search` (⌘K) opens command search over the whole window, home or Settings, from wherever focus is (`CommandSearch.tsx`; the design skill's `components/core/CommandSearch.prompt.md` owns its look).
It lists every window command but itself, in the catalog's order, each with its first key, and with the reason beside any that cannot run now, read as the window would stand once search closes.
Typed words narrow the list to the commands whose words hold every one, its label's and the other words it is found by (`commandMatches`); ↑ and ↓ choose, Enter runs the chosen command when it can run, Escape or ⌘K closes it.
While it is open its keys reach nothing underneath, and the window's other commands refuse ("Command search is open").

Closing gives focus back at once to what had it (`closeCommandSearch`), and only then does a chosen command run, so a command that moves focus moves it from there.
When focus was inside a card's or a panel's frame, the field inside it gets it back with its caret, as when the picture viewer closes ("Cards and frames"), unless the chosen command moves focus on.
When nothing had focus, focus lands by the rule in "Where focus lands": the main message while the person was typing, unless the chosen command puts focus somewhere itself in the same render (`focusMainMessage`'s `yields`, `focusTakenElsewhere`), and otherwise the shown card, or the main message when no card is left.
Each opening starts with an empty field and the first row chosen, also when search opens again while its last closing still fades out.
A main-process command chosen there (a size step) is asked of the main process by its id on `inf:keyboard:run`, which runs the same handler its key runs.

## Two-key shortcuts

A window command may answer to two keys pressed one after the other, `⌘K S`: a `KeyBinding` whose `second` is the second chord.
Its first key holds ⌘ or ⌃, or is a plain key with `when: "not-typing"` (`G T`), so typing never starts one; only a window command takes two keys, because only the main process waits between them.
The second key may be an arrow, held or not (`⌘K ⌘→`, `G ↓`), because the window takes a listed second key before anything else hears it.
`followWindowCommands` takes a first key that starts one (`startsTwoKeys`) for the window, heard before the page or offered by a document outside typing ("Keys used when not typing"), and waits for the second with no time limit.
While it waits, the page is told each pair that may follow (`nextKeys`, the `inf:keyboard:next` push) and shows the next-keys hint, a quiet strip at the window's bottom listing each next key and its command's words; the push says null once the wait ends.
The window hears the second key in `before-input-event`, whichever place the first was in: a listed key runs its pair once (`secondKeyCommand`) and reaches nothing else, and any other key ends the wait and acts as it would have, so a mismatch never swallows input.
A key pressed after a not-typing first key but before that key's offer landed reached its document before the wait began, so the wait hears it at its own offer instead, the same way.
Such a key that is also an anywhere key, as Emacs on Linux's Ctrl+B after Ctrl+X, reaches the document too when it is one of the pairs that first key starts, so the pair runs at its offer instead of the anywhere command running at its press; right after a Ctrl+X cut in a text field, it therefore does nothing there.
Escape (taken, to stop the wait), the window losing focus, the window page's navigation, recording a key and an input method's composition end it too, and so does focus moving to another document while a not-typing pair waits; a lone modifier and the first key held do not.
A hint draws both keys (`⌘K S`); a menu cannot show two keys, so it shows the command's first single key, and `aria-keyshortcuts`, which has no way to say two keys in turn, leaves them out.

## Changing keys

Settings → Keyboard lists every command in the catalog's order: its words, where it works (`SCOPE_WORDS`), its keys as key caps, and "Changed" when a person changed them; a search narrows it by words or keys.
Each row has Record, Remove (no key at all) and Reset (the chosen preset's keys); Reset all keys, beside the search, asks once ("Confirm reset") and puts every command back to the chosen preset's keys.
The customization is Keyboard settings only (the captain's `customization=ui-only` on FI3-800): there is no file to import or export, and the first mate never changes keys.

### Presets

The Preset row, above the search, picks a whole set of keys to start from: Vim, the default for a new profile, Emacs, VS Code and Tmux (`PRESET_IDS`, `PRESET_LABELS`).
Legacy is the catalog's own keys, as every version before presets had them; it is offered only to a profile that had it, one updated from an older version, which stays on it with every key it changed (the captain's pick on INF-3547: "They stay on Legacy with every changed key intact"), and What's new tells it presets exist.
Each preset is the catalog's keys with the commands it changes replaced (`presetKeys`), written as a Mac writes keys and read on each system through `systemKeys`, except where a preset has its own table for a Ctrl system (`CTRL_TABLES`), written as that system presses keys, since a Mac's Control keys have no place there:

- Vim keeps every ⌘ key and adds, while not typing, h j k l to move, g g and ⇧G for the start and the end, ⌃D, ⌃F, ⌃U and ⌃B to page, : for command search, / for Find a task, i and r for the main message and the reply, `?` for Keyboard settings, q to put a card aside, and g with c, a, t, ⇧T, s, p or b for a card's body, its buttons, its tabs, Settings, the project focus and the task board; ⌃W with w, p, h, j, k, l, c or o moves between the window's parts and puts aside or maximizes a card; anywhere, ⌃N and ⌃P move, ⌃[ cancels and ⌃Tab steps through a card's tabs.
- Emacs keeps every ⌘ key and adds ⌥X for command search, ⌃G to cancel, ⌃N, ⌃P, ⌃F and ⌃B to move, ⌃V and ⌥V to page, and ⌃X with o, b, ⌃B, p, m, 0, k, 1 and the arrows for the next part, Find a task, the task board, the project focus, the main message, putting a card aside, maximizing it and the cards beside it; while not typing, < and > go to the start and the end, and ⌃H with b or n opens Keyboard settings or What's new, since ⌥⇧< types a character and ⌃H deletes in a text field.
- Emacs on a Ctrl system (Linux) splits Ctrl+X and Ctrl+V the way Emacs's CUA mode does: while typing they cut and paste, and outside a text field Ctrl+X starts the same two-key commands as on a Mac (o, b, Ctrl+B, p, m, 0, k, 1, the arrows and the size keys) and Ctrl+V pages down.
  Since Ctrl+F moves right and Ctrl+G cancels there, Find in this card is Alt+S, Emacs's search prefix, and F3 and Shift+F3 go to the next and the previous match.
  Anywhere, Alt+X searches commands, Ctrl+G cancels, which leaves a message too, Ctrl+N, Ctrl+P, Ctrl+F and Ctrl+B move, a message's cursor included, Alt+V pages up, Ctrl+S finds a task and Ctrl+Tab steps through a card's tabs; in a message Ctrl+K deletes to the end of the line and Alt+Y puts it back; while not typing, < and >, and Ctrl+H with b or n, do what they do on a Mac.
  So Ctrl+K no longer searches commands and Ctrl+B no longer opens the task board there, which Ctrl+X Ctrl+B does (the captain's picks on INF-3547's later piece 5), and Ctrl+S no longer saves the picture viewer's picture there, which Ctrl+X Ctrl+S, Emacs's own save, does; every other Linux key stays.
- VS Code holds no plain key: ⇧⌘P and F1 search commands, ⌘P finds a task, ⌘K starts a second key (⌘K ⌘S Keyboard settings, ⌘K Z maximize, ⌘K W put aside, ⌘K ⌘ and an arrow the part that way), ⌃` shows the crewmate, ⌃R the project focus, ⌃Tab a card's tabs and F7 the next revised part.
- tmux is Vim's keys, as tmux borrows Vim's to move inside content, and tmux's prefix layer, which works anywhere, in the middle of a sentence too: the prefix, ⌃B, then : for command search, ? for Keyboard settings, s for the project focus, w or f for Find a task, n and p for the next and the previous card, o for the next part and an arrow for the part that way, z to maximize a card, d to put it aside and [ for its body (`TMUX_LAYER`); a session is a project, a window a card and a pane a part of the window.
  Vim's keys that start with the prefix are left out, so with ⌃B Vim's ⌃B page up is gone on a Mac, and on a Ctrl system Open task board's Ctrl+B (Vim's ⌘B there), leaving it g b while not typing (`tmuxKeys`).
  A command lists Vim's own keys first, then the layer's, then the catalog's keys Vim keeps, so a hint names a key of the preset's own; a panel's suggested key Vim keeps is not split out, so Find a task lists the Tasks panel's ⇧⌘F before the layer's, while its hint stays Vim's /.

tmux's prefix changes in one place, the Prefix row under the Preset row while tmux is chosen: Record takes one key, Enter saves it and Reset puts ⌃B back.
Every key of the layer moves with it, and so does every two-key shortcut a person recorded in tmux that started with the old prefix (`withPrefix`); Vim's keys that the old prefix took come back.
A prefix holds ⌘ or ⌃ (Ctrl on a Ctrl system), since it starts two keys anywhere; on a Mac it may be one of a text field's own Control keys, which it then takes over while typing, as tmux's ⌃B does in a terminal, but no other key the system or the app keeps and never a key that answers a card (`prefixProblem`).
On a Ctrl system a text field's own keys are Ctrl+X and Ctrl+V, which cut and paste, so neither may be the prefix, though Emacs uses them outside a text field.
A change whose prefix would lose a key of the layer to a key a person gave another command is refused, naming the clash, as any change that moves a preset's key is.
The prefix is pressed as it is on every system, so tmux is offered on a Ctrl system too.

⌘1 to ⌘4 answer a card in every preset, and ⌘J and ⇧⌘J move between its questions in every preset, each preset's own keys beside them: Vim and tmux } and { while not typing, Emacs ⌃X ↓ and ⌃X ↑, and VS Code F8 and ⇧F8.
A preset lists its own key for a command before any key it keeps from Legacy, so a hint, which shows a command's first key ("Key hints"), names the preset's key (`withLegacy`; the captain's pick on INF-3811, "Show each preset's own keys first").
A preset's keys pass the rules a person's key does ("Which keys a command may take"), except the catalog's own keys it keeps, which stay as they always were; `src/shared/keyPresets.test.ts` holds each preset, on each system, to keys that all survive the resolve with no two commands sharing one where both work, and to hints that name its own key where it has one.

### What is saved

`SavedKeymap` is versioned (`version: 2`) and holds the chosen preset, the commands a person changed in it, each with the keys that replace the preset's, and the changes kept for each other preset (`kept`), so picking a preset again brings its changes back (`withPreset`); an empty list is no key at all, which is not the same as a command missing, which keeps the preset's keys.
It also holds tmux's prefix (`prefix`) once a person changed it from ⌃B, kept whichever preset is chosen; Reset all keys on tmux puts ⌃B back.
A saved `version: 1` value, from before presets, reads as Legacy with its changes; nothing saved reads as a new profile's preset.
An updated profile's first launch saves an empty `version: 1` value when it has none (the last migration in `src/core/storage/migrations.ts`, which a new profile's fresh database skips), so it reads as Legacy too.
Saving a command's preset keys is no change at all.
An id this version does not know is kept as saved, listed under the commands as "Not in this version of Infinitary", runs nothing, and survives Reset all, so a downgrade and an upgrade lose nothing.
A saved value that cannot be read is Legacy's keys, said so above the list, and stays as it was until the next change saves over it.

The keys belong to the Mac whose keyboard pressed them.
On the Mac that holds the first mate they are the `keyboard` row of its settings (`ShellPreferencesService.keymap`), outside the `shell.preferences` read, so no paired device reads them; on a Mac that controls another they are kept with that Mac's own look (`ViewLook`, `docs/view.md`), starting on a new profile's preset, or on Legacy for a look kept from before presets.
The window asks the main process for them on host channels (`inf:keyboard:keymap`, `inf:keyboard:save`, `inf:keyboard:record`).
One pair of core requests carries them, on the first mate's own computer only: the window opened beside a first mate a command started reads that first mate's keys at each welcome and saves a change there (`inf:settings:keys:get`, `inf:settings:keys:set`, `reach: "home"`, so no view on another computer is answered them), and keeps a copy with its own look so its keys work before the first mate answers (`docs/run.md`, "The window opened beside it").

### Which keys a command may take

`bindingProblem` refuses, in the words the recorder shows:

- an anywhere first key without ⌘, ⌃ or ⌥, unless it is a function key; a bare key works only with `when: "not-typing"`;
- Space, Enter, Tab, Escape and the arrows for not-typing keys; anywhere keys also leave Delete, Home, End and the page keys alone, but ⌃Tab may be a shortcut, which never moves between controls; dead and unknown named keys are always refused;
- the Mac's own keys and the app's native ones (`PLATFORM_KEYS`): quit, close the window, hide, minimize, the editing keys, Spotlight, the input source, full screen, screenshots, and a text field's own Control keys, except that ⌃N, ⌃F and ⌃B may be the key of the movement command that moves the same way (`TEXT_MOVES`: Move down, Move right, Move left), since pressing it does what the Mac did there anyway, that a text field's Control key may work when not typing or be a second key, where no text field hears it, and that on tmux one may be the prefix that starts two keys anywhere ("Presets");
- two keys for a command that is not a window command, and two keys whose first neither holds ⌘ or ⌃ nor works only when not typing;
- a second key with its own job, except an arrow, which may finish a pair.

A key held with ⌥ alone works anywhere, as Emacs's ⌥X does; it no longer types its character in any text field, so the recorder warns, naming the character (`bindingWarning`: "⌥X types “≈”, which no text field will take from this key once it is a shortcut.").

On a Ctrl system an anywhere shortcut holds Ctrl or Alt instead, and the keys it keeps for itself are its own (`CTRL_SYSTEM_KEYS`): Ctrl+Q and Ctrl+W, Alt+F4, the editing keys with Ctrl+Y and Ctrl+Shift+V, the input method's Ctrl+Space, Ctrl+Shift+U and Ctrl+., a terminal's Ctrl+Alt+T, and Ctrl+Alt with a function key; every chord that holds the Super key belongs to the desktop.
Ctrl+X and Ctrl+V cut and paste only in a text field, so, like a Mac text field's Control keys, they may work when not typing or be a second key; Ctrl+C copies text selected anywhere and keeps its job.

Recall's ↑ and the size keys' catalog keys stay what they are; the rules judge only what a person records and what a preset adds.

### Clashes

Two commands clash when their scopes share a place a key is pressed (`scopesOverlap`; the window shares every place) and a press, or a pair, would run both (`bindingsClash`: `same`), or one is a whole shortcut and the other starts with it (`prefix`).
The recorder names both commands, the keys and where both work (`clashWords`: "⌘L already runs “Go to the main message” anywhere in the window").
A `prefix` clash is refused; a `same` clash says that saving moves the key here and whether the other command keeps keys or will have none, and saving is the explicit choice that changes both commands (`withKeyMoved`).
Nothing is replaced silently.

### Recording a key

Record turns on the window's recording (`inf:keyboard:record`): until it stops, `followWindowCommands` runs nothing and sends each key but a lone modifier and a held repeat to the page alone, as `before-input-event` reported it (`inf:keyboard:recorded`), so the menu, the page's own listeners and the dictation key's listener hear nothing and what is recorded is what the window will match.
While it records, the shell store's `recordingKeys` holds every shell command.
Enter saves the keys in place of the command's others, ⇧Enter adds them beside the others, Escape stops without saving; the recorder's Save, Add beside the others and Cancel buttons do the same for a pointer.
A window command's key that holds ⌘ or ⌃, or a plain key that works when not typing, waits for a second key, which makes it two keys; another key after two starts over.
On tmux the prefix always waits for a second key, and alone it says so instead of saving ("⌃B is the prefix; press the key that follows it").
A key recorded with ⌘, ⌃ or ⌥, or a function key, works anywhere; any other works only when not typing.
Recording stops when the window loses focus, the page navigates, the row is saved or cancelled, or Settings closes.

### The installed map

`InstalledKeymap` (`src/main/keyboard.ts`, `Shell.keymap`) is the one map every reader reads: `followWindowCommands`, the app menu, and in the page the message fields (`messageKey`), every hint (`useCommandKeys`), command search and Keyboard settings.
`resolveBindings` makes it from what is saved: the changed commands first, in the catalog's order, then every other command's keys in the chosen preset, leaving out a key that cannot be a shortcut or that clashes with one already placed, so a key resolves one way only, and a key a newer version gives a command stays with the person's command that already holds it; a panel's command a preset gives keys takes them in place of its panel's suggested key.
Each install is numbered (`KeymapSnapshot.version`) and pushed whole (`inf:keyboard:keymap`); the page keeps the newest it has seen.
A change is installed whole or refused whole (`keymapRefusal`): every key it names must be one its command may take and must survive the resolve, and no catalog key may leave its command unless the change says so; a refused or failed save leaves the installed map as it was, and the reason shows beside the row.
Switching to or from a view of another Mac installs that Mac's own keys.
The first mate reads it too, through its `keyboard.keys` read (`src/core/pi/appReads.ts`): the core is handed the window's map (`HostCapabilities.installedKeys`), asked at each read, and with no main window open (`mainWindowOpen`, `src/main/windows.ts`), as in a run or after the last one closed, it reads the saved keys resolved for the catalog's commands alone and says so (`source: "saved"`).

### The app menu

A desktop with no menu bar (Linux) has no app menu: `src/main/app.ts` sets none, so no window carries Electron's default menu or its keys, and what the menu holds is reached elsewhere - Settings by its gear and Ctrl+,, Keyboard settings, Reset all keys and What's new in Settings and command search, and Quit and closing the window by Ctrl+Q and Ctrl+W ("Keys on each system").
On a Mac, `installAppMenu` builds Electron's menu again at every install: the View menu's zoom items run the size commands, and after About the app menu has Check for Updates…, then Settings…, Keyboard Settings… and Reset All Keys…, in the platform's title case.
Electron words the app menu's title, About, Hide and Quit with `app.name`, the package's lowercase name, so every Mac process that may show a menu, the window or a run macOS brings forward, first puts the bundle's name there (`nameAppMenu`): About Infinitary, Hide Infinitary and Quit Infinitary, or Infinitary Dev for a development build.
Check for Updates… runs `updates.check` and is greyed out on a copy that cannot check, one whose installation the app could not confirm (`checksUpdates`, read once from `inf:update:status`).
Electron's own menu has no Help menu, so the app adds one (`role: "help"`, where the Mac puts its menu search) holding What’s New in Infinitary, which runs `whats-new.show`, and Send Feedback…, which runs `feedback.start`; What’s New is greyed out until a release note was shown, and the menu is built again when the core pushes the first one (`inf:release-notes`).
Each shows its command's first single key from the installed map; the window takes a command's key before the menu does, so an accelerator only shows it.
Keyboard Settings…, Reset All Keys… and What’s New stay whatever keys a person removes; Reset All Keys… asks first, naming the chosen preset (`resetAllKeysAfterAsking`).
Quit, close the window and the editing items keep the platform's own.
The release omits Reload, Force Reload and Toggle Developer Tools, and its main windows disable developer tools.
This follows `packagedFlavor`, not `app.isPackaged` alone: unpackaged development runs and packages stamped `infinitaryBuildFlavor: "dev"` (or the older `fm3000BuildFlavor`) keep all three items and developer tools.
In every build, `followRendererRecovery` reloads a crashed main page (crash, out-of-memory or abnormal exit) at most once per minute, measured with a monotonic clock.
A second crash within that minute stays stopped rather than looping; deliberate exits and failed launches do not trigger recovery.
Recovery restarts the page and loses unsent reply drafts, but keeps a card's picks, the core and saved state running.

## Key hints

A hint shows a command's first key as its system draws it (`keyHint`, `chordLabel`: `⇧⌘L`, `⌘,`, `⇧⌘[` on a Mac, `Ctrl+Shift+L`, `Ctrl+,`, `Ctrl+Shift+[` on Linux).
Command search shows it on every row, and every control that does what a command does names that command's current key, so a person learns the key from the control.
An icon button or a tab shows it after its words in the label the app draws on rest, and names every key in `aria-keyshortcuts` (`commandKeys`, `useCommandKeys`): the Settings gear (`settings.open`), the card pager's arrows (`cards.previous`, `cards.next`), the card corner's Maximize or Restore card (`cards.maximize`) and Put aside (`cards.minimize`, or `cards.minimize-all` while ⌥ is held), the reply row's Point at (`cards.point-at`), the thread's Collapse thread and the folded docks' Show panels (`cards.thread`; the thread's latest line names the key in `aria-keyshortcuts` alone), the revert icon beside the newest message (`message.take-back`), the project pill (`project-focus.open`) and its Show all projects (`project-focus.clear`), the Update button (`updates.show`), the ambient sound button (`ambient.toggle`), a task card's tabs (`cards.show-info`, `cards.show-cards`, `cards.show-activity`, `cards.show-crewmate`, and `cards.show-browser` on the first page's tab), Settings' tabs (`settings.keyboard`, `settings.panels`, `settings.runbooks`, `settings.usage`, `settings.automation`, `settings.integrations`, which draw a label only once their command has a key), and a panel's header buttons (`panel:<panel>/<command>`), the Tasks panel's Search tasks (⇧⌘F) and Open task board (⌘B) among them, and the Automation panel's Open Automation (`settings.automation`, which the panel declares no command for).
The first mate's reply line above the message box, and a card round's name there, names Open the conversation's key (`firstmate.reply`) after its words when they are cut short, else after the command's own words.
A text button shows the key inside itself after its words, the label moved left to make most of the room and the button six pixels wider (`Button`'s `keys`): a card's footer choices (`cards.choice-1` to `cards.choice-4`), an answer's Done (`cards.done`), the record's Move to a computer (`task.move-computer`) and Close as done (`task.close-done`), Take or Return control (`browser.control`), Update later and Check for updates (`updates.later`, `updates.check`), Open your runbooks folder (`runbooks.open-folder`), Settings → Automation's Pause all (`automation.pause-all`), Subscriptions' Refresh (`allowance.recheck`) and the crew ring's Previous and Next computers (`computers.previous`, `computers.next`); Usage's Tokens and Dollars choice draws it after its pills (`usage.unit`, `GroupedPills`' `keys`).
The empty reply field shows Go to the card's reply at its far end until it has focus or words.
A panel's own page shows its commands' keys from `PanelProps.keys` the same ways: the task board's empty Find shows Find on task board's key at its far end until it has focus or words, its Backlog, Done · 7d and Dropped show Show the backlog's, Show done tasks' and Show dropped tasks' inside them after their counts, and a tile's ⋯ names Move the selected task's in its label (`RowMenu`'s `keys`).
Each names the key in `aria-keyshortcuts` and hides the drawn key from the accessible name.
A key the app holds fixed shows the same way (`fixedKeys`): Esc on Close the viewer, Back from Settings, Restore card (when Maximize or restore card has no key of its own), Abandon a recording, a model's Close in Settings → Intelligence, Close search and Close the project row; ← and → on Previous picture and Next picture; Enter on the message box's Submit; and Ctrl+W on Close window where the app draws its own window buttons.
Settings → Appearance's Size row writes the keys Make everything larger and Make everything smaller have now (`sizeKeysWords`).
The app menu shows the size keys, Check for Updates…'s, Settings…'s, Keyboard Settings…'s and What’s New's keys through `menuAccelerator`.
Every hint reads the installed map, the same keys the window resolves.

### The key reminder

A hint shows its key before a click, and only to someone who waits on the control, so a person who clicks quickly never learns it.
The key reminder names it after the click (design skill `components/core/KeyReminder.prompt.md`): a mouse click on a control whose command has a key shows, at the bottom of the window, the key the control's own label shows and the command's words, for about five seconds (`--hold-key-reminder`), fading in and out over `--dur-fast`.
A key that works only when not typing reads "when not typing" beside it, as Q does for Put aside under Vim keys.
`useCommandKeys` marks each control with its command while the command has a key (`data-key-command`), and one listener in the window (`KeyReminder`) hears the click.
Only a pointer's click shows it: Enter or Space on a button, a command's own key, command search and a script's click show nothing, and neither does a control marked off.
Any key or another press takes it away at once, and a click on another control with a key shows that one instead.
It takes no pointer and no focus, nothing moves for it, and a screen reader skips it, since the control already names its key.
It shows on home and in Settings alike, and for a control inside a panel's own page, such as the task board's Backlog, Done · 7d, Dropped and a tile's ⋯.
The window does not hear a click inside a panel's frame, so each of the page's keys (`PanelProps.keys`) carries the same mark under the command's id in its manifest, and the page's runtime (`followKeyClicks`, `src/renderer/src/frameRealm/keyClicks.ts`) tells the window of a mouse click on a marked control by one panel action, `keys.clicked`.
The window answers it only while that page's frame holds focus, as for any of its gestures, and names the command under the page's own panel (`panel:<panel>/<command>`), so a page shows only its own commands' keys; a crewmate's draft of a panel gets no answer.
A press inside a panel's page takes a reminder away as one in the window does, through the press the page already tells the window.
A search field, such as the board's Find, carries no mark, as the main message does not: a click into it is a click to type.

A command's own key, pressed once, stops its reminder: the main process hears the key (`followWindowCommands`' `onPressed`) and keeps the command's keys as they were then (`withPressed`, `src/shared/keyReminders.ts`).
Pressing any of ⌘1 to ⌘4 stops all four, which teach one thing.
Changing the command's keys, or picking another preset, lets its reminder show again, because its keys no longer match what was kept (`remindsOf`).
Settings → Keyboard has one switch, "Show an action's key after I click it", on for a new profile; off, no reminder shows from the next click on.
The switch and the keys pressed belong to this computer, whichever first mate its window follows, in one file of the window's own profile that `KeyReminderStore` (`src/main/keyReminders.ts`) alone writes, on host channels (`inf:keyboard:reminders`, `inf:keyboard:reminders:set`) outside the published contract.
The first mate switches it when asked through the catalog's `key-reminders` line, which asks the named computer's window, or this computer's (docs/view.md, "What the first mate asks of a window").

## Tests

- Unit: `src/shared/keyReminders.test.ts` (when a reminder shows, the keys a press keeps, ⌘1 to ⌘4 stopping together, a changed key showing it again), `src/main/keyReminders.test.ts` (the switch and the keys pressed kept across a restart), `src/shared/keyPresets.test.ts` (each preset's keys survive the resolve and the rules, each hint names the preset's own key, Legacy is the catalog's, ⌘1 to ⌘4 in every preset, which presets are offered), `src/shared/keyboard.test.ts` (the catalog, who runs each window command, chords, scopes, repeat, changed keys, two-key shortcuts, accelerators, hints), `src/shared/keymap.test.ts` (what is saved, which keys a command may take, clashes, the installed map, a refused change, the changes Keyboard settings makes, a panel's commands and their first-come keys), `src/renderer/src/plugins/panelCards.test.ts` (a panel's commands listed, refused and run), `src/main/keyboard.test.ts` (a window command runs once and its key is cancelled, held or not; the shell is told the command's id alone; every other key reaches the page; two keys, their wait with no time limit, the next keys told to the page, a plain first key when not typing and an arrow second; recording; installs; a movement key pressed into the page or handed to the frame holding focus, and never pressing another), `src/renderer/src/app/regions.test.ts` (the directional part commands' nearest part), `src/main/shell.test.ts` (a view's keys are its own), `src/core/preferences/shellPreferences.test.ts` (the `keyboard` row), `src/renderer/src/settings/keyRecorder.test.ts` (the recorder's keys, verdicts and saves), `composerKeys.test.ts` (the shell keys and recall through `messageKey`), `src/renderer/src/app/composer.test.ts` ("going to the main message"), `commandRefusals.test.ts` (why each command cannot run), `commandRows.test.ts` (command search's list, matching by a label's and other words, the app's own panels' commands in another language, and arrows), `src/shared/appPanelWords.test.ts` (the app's own panels' commands worded from the catalog, their English the manifest's), `footerGroups.test.ts` (the order the choice keys press a card's buttons), `CardThread.test.tsx` (the thread's Collapse thread and its latest line, pressed by a key or the pointer), `src/main/appMenu.test.ts` (the release View boundary and the Help menu's What’s New, greyed out until a note was shown, and its key), `src/main/rendererRecovery.test.ts` (crash recovery, the one-minute limit and exits that do not reload), `src/panels/now/nav.test.ts` (the Tasks list's stops and keys), `boardTiles.test.ts` (the task board's arrows), `boardMoves.test.ts` (its menu's entries), `SettingsScreen.test.tsx` (the tabs' keys and their one Tab stop), `src/renderer/src/settings/panelsWords.test.ts` (Settings → Panels' rows and their arrows), `src/renderer/src/plugins/panelDrag.test.ts` (a panel's ⌥ and arrow chords), `railStore.test.ts` (a panel's body asked to take focus), `panelCards.test.ts` (an ask's way in and F6's ask for focus), `frameRealm/panelProps.test.ts` (both heard in a frame, and a panel's keys read from its view state, each marked with its command), `frameRealm/keyClicks.test.ts` (a panel page's mouse click on a marked control told to the window, and no other click), `src/renderer/src/plugins/panelActions.test.ts` (`keys.clicked` answered only while the page holds focus, for its own panel, and never for a draft), `src/renderer/src/app/keyHints.test.ts` (a panel's keys: its own commands that have one, as each system draws them, following a change), `keymap.test.ts` (a key saved under a retired command carried over), `cardKeys.test.ts` (the card's reading keys), `heldKeys.test.ts` (a held Enter presses once), `frameController.test.ts` ("a card body's keyboard": `keys`, `escape` from the current document only, `focus` to a born document; "stepping through a card body's questions") and `bridge.test.ts` (the `escape` envelope).
- E2E: `tests/e2e/release-menu.spec.ts` (the developer boundary in development, stamped local packages and release, a real crashed page recovered and a second crash stopped), `tests/e2e/window-size.spec.ts` (the size keys, the menu and the picker share one saved size), `tests/e2e/keyboard-routing.spec.ts` (⌘L from a card drawn inline, a card served at its own host, a card's reply, the Tasks panel and Settings; command search from inside a card, its reasons, Escape and running a row; the reply, card, task and Settings keys from inside a card; putting a card with unsent answers aside from command search without a confirmation) and `tests/e2e/multiline-composer.spec.ts` (the shell keys with undo, Ctrl+P and recall).
  `tests/e2e/key-reminder.spec.ts`: a mouse click on Put aside shows its key at the bottom of the window and Enter on it shows none, pressing that key stops its reminder for good, and Keyboard settings' switch, reached by Tab and switched by Space, turns every reminder off; a mouse click on the task board's Backlog and Done · 7d names the key the Tasks panel's command has, a press inside the board takes it away, and that command's key pressed once stops it.
  `tests/e2e/key-hints.spec.ts`: a key Keyboard settings sets, changes and removes, followed by Settings' Automation tab's label and `aria-keyshortcuts`; and the task board's Find, Backlog, Done · 7d, Dropped and a tile's ⋯ naming the keys the Tasks panel's commands have, Find's going while the caret is in it, and a changed and a removed key followed.
  `tests/e2e/keyboard-presets.spec.ts`: one journey per preset, each driven by its own keys - Vim chosen on a new profile with no Legacy, Emacs on a Mac, VS Code, Tmux driven by its prefix mid-sentence with its prefix moved in the Prefix row and Reset, and an updated profile on Legacy with its changed key - each picked in the Preset row, keeping its changes across another pick, and Reset all keys returning to it.
  `tests/e2e/keyboard-settings.spec.ts`: opening Keyboard settings from command search, recording a key, a refused key, a key moved from another command, a two-key shortcut, and a restart that keeps them all in the window, the hints and the app menu until Reset all keys.
  `tests/e2e/row-press-card-appears.spec.ts`: a decision a Tasks row pointed at appears without taking the focus a press begun since holds in the Tasks panel, and that press's click opens the next row's record.
  `tests/e2e/whats-new.spec.ts`: Show what's new from command search and the Help menu, bringing an open release note to the front and a closed one back read-only, from Settings and the first mate, by a key recorded for it, and refused before any note.
  `tests/e2e/task-board.spec.ts`: Open task board from the Tasks header in both states and by ⌘B, one board on a repeat, the arrows through every lane, Enter to a record, the board kept while it pages, the selected tile as the turn's hint, Find on task board and Show dropped tasks from command search, Esc in its order, and a fresh board after Hide.
  `tests/e2e/task-board-moves.spec.ts`: Space opens a tile's menu, the arrows and Enter pick Start now, Esc lets go of its confirmation with focus back on the tile, and Move the selected task opens the menu from command search.
  `tests/e2e/task-tag-keys.spec.ts`: Filter tasks by tag with the arrows and Enter on the Tasks search's tag row and the search's close letting go of the tag, Group tasks' menu opened on the current choice with ↓ and Enter picking By tag, kept after a restart, → opening a tag group and ← from a task with parts going back to its header, and Show tasks by tag with ↓ and Enter opening the Board on a row's tag.
  `tests/e2e/tasks-search.spec.ts`: the Tasks search closed by Close search from the keyboard, by Esc after Esc empties its words, and by Search tasks after Find a task opened it, with focus on the list after a close from the keyboard and every task listed again.
  `tests/e2e/tasks-from-elsewhere.spec.ts`: the Tasks panel's folder added from elsewhere under another id, its board put up by its command with focus on its tiles, the arrows, Space for a tile's menu and Enter, as the app's own.
  `tests/e2e/panels.spec.ts`: Arrange panels from command search on the Panels tab's first row, the Settings tabs down a column stepped by ↓ and ↑, ⌥ and the arrows moving a row with focus kept, Space and Enter on a row, Reset to defaults, a header dragged on the rails, Escape during a drag, and ⌥↑ on a header's chevron.
  `tests/e2e/project-page-keys.spec.ts`: a project's page opened by Enter and Space on its line with focus on Back, the repository tabs one Tab stop moved by the arrows and chosen by Enter, Tab on to Add a repository, Escape back to the line, and Escape on the list closing Settings.
  `tests/e2e/usage.spec.ts`: Open Usage from command search, the unit switch on the arrows, the period and the work by typing, a model's details by Enter and Escape, the unit kept after a reload, and Switch Usage units.
  `tests/e2e/keyboard-regions.spec.ts`: F6 and ⇧F6 round the window's parts from the main message, words and caret kept, and from a field inside a card's frame; the arrows, the keyboard's rest and Enter in the Tasks list, and focus, the Tab stop and the summary staying with a row whose task moves to another group; `tests/e2e/now-row-start.spec.ts`: a backlog row's Start reached by →, left by ←, pressed by Enter, with focus following the started task; Settings' tabs on the arrows, and F6 between the tabs and the section; a key of a person's own for the parts.
  `tests/e2e/card-threads.spec.ts` ("the thread collapses into its card…"): ⌘\ both ways with the reply's words and focus kept, Enter on Collapse thread and on the latest line, the collapse's key in its label and gone with it, Show or hide the card's thread from command search, and a new line opening the thread again.
  `tests/e2e/create-panel-slot.spec.ts`: F6 from the main message to the create-your-own-panel slot and Enter on it, which starts the ask in the main message with focus there and the words typed before kept.
  `tests/e2e/card-keyboard.spec.ts`: a card read with the reading keys, its body and buttons by name, a default pressed with a question unanswered going to the question, the answer sent by Enter and recorded against the offer shown, a held Enter sending no message after it; ⌘1 on the recommended choice, with the keys counting leftward from it; command search and the picture viewer giving focus back to the field and the picture inside the frame, caret and all, pictures opened by Enter and Space, a task key's summary on the keyboard's rest, Escape out of the body, and the edge's Enter; and a card script's gestures refused while focus is elsewhere, against the captain's own press on the same picture, with F6 and ⌘L leaving a script that keeps every key.
  `tests/e2e/card-questions.spec.ts` ("a card's questions are stepped through and answered by keys alone"): the footer's arrow bringing a question into view with the main message's focus kept, ⇧⌘J and ⌘J from there, Enter, a number key and Shift+Enter on the questions, the count following, Enter past the last question on the default button, and ⌘1 sending the three answers.
  `tests/browser/risk-chart.test.tsx`: a merge card's risk chart, each dot's note by Tab in the radar's order, Esc letting it go with the card still up, and a dot reached after scrolling to After bringing the chart back.
  `tests/e2e/card-local-links.spec.ts`: a card script's clicks on its own link and its own `link` messages open nothing while focus is elsewhere, against the captain's own press and Enter on the same link.
  `tests/e2e/frame-focus.spec.ts`: a card's and an added panel's script that calls `focus()` while the captain types leaves the words, the caret and the next keys in the main message; F6 and Tab, a click, and the waiting default's move to an unanswered question still put focus in a card, and a default pressed with nothing left to answer puts none there.
  `tests/e2e/panel-cards.spec.ts`: a panel's command by its suggested key, with focus in the card it put up; its commands in command search under its title and in Keyboard settings; a command that presses a header button bringing a collapsed panel out with its search taking the keys.
  `runFromSearch` (`tests/e2e/windowKeys.ts`) runs a command by its id the way a person does in command search, `clickInBody` (`tests/e2e/stack.ts`) plays a press on a body's picture or link as a real one lands, focusing it first, and `pressPointer` (`tests/e2e/layout.ts`) is the captain's own press through Chromium's routed pointer.
  The command search helper is `commandSearch` and the Keyboard settings helper `keyboardSettings` (`tests/e2e/windowKeys.ts`), which find a row by its command id; `focusedRegion` and `regionAfter` read the part that holds focus from `data-window-region`, and `watchFramesFocused` records each frame the page puts focus on.
  A window key in an end-to-end test goes through `pressWindowKey` (`tests/e2e/windowKeys.ts`), Electron's own input path: Playwright's keyboard reaches the page through the debugger and skips `before-input-event`.
  A journey names ⌘ as `meta`, which `pressWindowKey` presses as Ctrl on Linux, so the Linux source lane runs `keyboard-routing.spec.ts` and `keyboard-regions.spec.ts` by the same keys, and the full Linux suite every other keyboard journey (`docs/testing.md`, "The Linux source desktop").
  `launchApp` returns once the window's keys are marked as the shell's, and `untilWindowCommands` waits for that mark again after a reload; `startRecording` and `endRecording` start and end Keyboard settings' recorder and return once the main process has; `typeInto` types with Playwright's keyboard only once the field it names holds the window's focus (`docs/testing.md`, "Keys wait until the app takes them").

### Panels folded for room

The counted More row at a rail’s foot is a panel region in the F6 walk.
Tab reaches its control; Enter opens its menu, arrows choose a panel and Escape closes it.
Choosing a panel writes its move nearest the anchored end of its group and focuses its header.
An expand on a folded header pins it after the other panels in the fold order, without recording the automatic fold itself.

## Keys used when not typing

A window binding may carry `when: "not-typing"`; omission keeps the existing anywhere path, so old saved keys and every default retain their behavior.
Keyboard settings automatically records a bare key with this place, and shows "When not typing" beside its caps.
A saved key held with ⌘, ⌃ or ⌥, or a function key, has an Anywhere / When not typing selector beside it, outside the recorder so Tab and the arrows reach it normally.
A key without Command or Control may bind a close-risk command, including card answer 1–4, Done and Decline.
When recording a key without Command or Control for one of these commands, Keyboard settings shows the non-blocking warning "One press of this key can answer or close a card.
This can also happen while typing inside a card if Infinitary does not recognize its text field." while keeping the normal verdict and valid save controls available.
The warning adds no confirmation when the command runs, and previously saved function keys remain active without blocking unrelated key changes.
Command+1 through Command+4 remain the default answer keys.
Space, Enter, Tab, Escape and the arrows keep their existing jobs.
A bare key may also start a two-key shortcut ("Two-key shortcuts"); a preset's plain keys are this layer's ("Presets"), and the movement commands are "Moving by a key of your own".

The main process lets a not-typing key reach the focused document and remembers the native press, focused frame and installed map.
The shell and the frame bridge offer an unused trusted key after all its handlers finish, only outside text-like inputs, textareas, selects, editable content and declared typing controls, and never during composition.
The target path is read during dispatch, before the browser clears it.
So is whether a frame held the window page's focus: a key the page heard then is that frame's, and the page never offers it, even when focus came back to the page before the offer.
Every text field, the Crewmate prompt and the recorder therefore keep their letters; a controlled task browser consumes and forwards its keys before an offer, and its hidden page has no offering bridge.
A frame's `key` message carries the key, not a command; `FrameController` accepts only the current document and `FrameMount` forwards only the frame that holds focus, with no focus grace.
The host-only `inf:keyboard:offer` request resolves only installed not-typing bindings against the same native key, modifiers and focused frame, once.
The trusted mount gives its frame a UUID name at element creation, before the first navigation, which the main process checks against Electron's focused frame at both the press and the offer; a shell offer must come from the native main frame.
The main process keeps every such witness until its document offers it back, because a fast typist presses the next key before the last one's offer lands.
An offer uses the oldest witness of the same key, modifiers and focused frame under the current map, once.
A document offers its keys in the order they were pressed, so that offer also drops every older witness, whose offer will never come.
Each new press drops the witnesses of another document or an earlier map, which can never be offered back, and composition, recording, a window blur or the window page's navigation drops them all.
A card's frame starts loading whenever the shown card changes, often between a quick press and its offer, so its navigation drops only the witnesses of keys pressed in that frame.
The window keeps the newest 256 witnesses, so a long stretch of typing in one field cannot grow the list.
A not-typing binding has no menu accelerator, which would otherwise bypass the typing check.
Not-typing bindings may share a message-editing key because their places do not overlap; two window commands still cannot share a key.

When such a binding is installed, the last unused Escape in a main message or card reply moves focus to the shown card, or the bare stage if there is none, preserving the draft.
The reply's key isolation (`CardThread.tsx`) lends only an unused, non-composing Escape to that chain while such keys are installed; every other reply key but the dictation key stays the reply's own.
All earlier Escape actions retain priority, and maps without a not-typing binding retain the old chain.
The unfocused empty main message shows its Go to the main message key in its existing placeholder, with no mode indicator.
