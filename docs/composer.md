# The composer

The task prompt at the foot of the home stage: how it takes more than one line, makes room for itself, holds long pastes, meets voice, and never loses a draft.
The last turn, the captain's message and the first mate's reply above it, is part of the same dock (below, "The last turn").
A card's one field uses the same field (below, "The card reply row").
The captain's decisions are the board review of 2026-09-28 (scout `fm3000-multiline-input-s1`): key model A, the stage lifts by half the growth with the shell kept clear, a long paste becomes a chip, and Up brings back the last message.
How it looks is the design skill's `components/voice/VoiceInput.prompt.md`; this page is how it behaves and where that lives.

| Piece | Where |
| --- | --- |
| The field both inputs share: growth, keys, IME guard, paste; the count | `src/renderer/src/design/core/ComposerField.tsx` (`ComposerField`, `ComposerCount`, `ComposerCountAnnouncer`) |
| The prompt's rows, chips, hint | `src/renderer/src/design/voice/VoiceInput.tsx` |
| The card reply row | `ReplyRow` in `src/renderer/src/cards/CardThread.tsx` |
| The key model, the shell keys and the code-block test | `src/renderer/src/design/core/composerKeys.ts` (`enterAction`, `messageKey`, `killRange`, `joinKill`, `isInsideOpenFence`); the shell keys' and recall's keys are keyboard commands (`docs/keyboard.md`) |
| Trim, long-paste threshold, limit band, limits' words | `src/shared/composer.ts` (`composeTurnText`, `shouldChip`, `limitBand`, `COMPOSER_HINTS`, `PASTED_TEXT_WORDS`) |
| The send limits | `src/shared/cards.ts` (`CONVERSE_TEXT_MAX_CHARS`, `TURN_IMAGES_MAX`) |
| Compose state, send, recall, transcript | `src/renderer/src/app/composer.ts` (`inputText`, `pastes`, `attachments`, `inputCaret`, `lastSent`, `submit`) |
| Growth and the stage's reflow | `HomePrompt` in `src/renderer/src/app/HomePrompt.tsx`; `src/renderer/src/app/promptGeometry.ts`; what the input's foot stands on, `src/renderer/src/app/promptFoot.ts` |
| The last turn above the input | `src/renderer/src/app/LastTurn.tsx`, `lastTurn.css`, its whole-word cut `src/renderer/src/design/core/wholeWords.ts`; the shell store's `lastTurn`; `src/shared/lastTurn.ts`; the reply line's rule `src/core/orchestrator/replyLine.ts` |
| The IME guard | `src/renderer/src/design/core/composing.ts` (`isComposing`) |

## Keys

One pure function decides every Enter, `enterAction`, and the field calls `preventDefault` on every Enter, so a line is only ever added on purpose and never by the platform's default:

- an input method's Enter (`isComposing`, or keyCode 229) is `ignore` - it neither sends nor adds a line (the Korean 2-Set trap: a guard that only skips the send lets the textarea insert one);
- Enter while recording, or while the field's host holds it read-only (a reply that is sending), is `ignore`;
- Cmd or Ctrl + Enter always sends;
- Shift or Option + Enter adds a line;
- inside an open ``` code block Enter adds a line;
- otherwise Enter sends;
- a held Enter sends once: its repeats are `ignore`, so an Enter held on a card's button that closes the card never sends the message focus goes back to (`docs/keyboard.md`, "Cards and frames"), while a held Shift+Enter adds a line per repeat.

An Enter keydown cannot tell left Option from right.
The chosen dictation key starts recording (`dictationKey.ts`, "Voice"), and Enter while recording is `ignore`.
Otherwise Option+Enter adds a line and Command/Control+Enter sends, including while dictation is off.

`isInsideOpenFence(text, caret)` counts the lines before the caret that open with ``` (indentation allowed), the caret's own line up to the caret; an odd count is inside. `~~~` and a ``` in the middle of a line are not fences.
It is typed state, never a guess about the words.

A line is added by typing `\n` at the caret (`execCommand("insertText")`), so the change event sees it like a keystroke and undo takes it back with its line ("Undo").
Up or Ctrl+P in an empty field - no words, no chips, not recording - calls `recallLastSent`; with anything in the field either moves the caret.
A held key brings the message back once and then moves the caret.
Cmd+L, wherever focus is in the window, puts focus back in the main message with its words, chips and caret as they were; it is a window command (`docs/keyboard.md`, "Who runs a window command").
A card's reply has no recall, so Up and Ctrl+P there are the platform's.
Tab is never captured.
There is no setting for the Enter key (the captain chose none).

### Shell keys

The field takes a shell's editing keys alongside the Mac's own, so text is removed and put back the way a terminal does it.
`messageKey` decides them through the keyboard commands (`docs/keyboard.md`), with the window's installed keys: by default Control held alone - never with Cmd, Option or Shift, and never during an input method's composition, whose Control keys stay its own.
A person can change or remove each of them, and recall's, in Settings → Keyboard; each keeps its own place, a message field or the main message.
It reads the layout's letter, or the physical key on a layout without Latin letters.
On Linux the shell keys have no key, because Ctrl takes ⌘'s place there and Ctrl+K searches (`docs/keyboard.md`, "Keys on each system"); a person may still give each one a key in Settings → Keyboard.

- Ctrl+U removes from the caret back to its line's start; at a line's start it removes the line break, joining the line to the one above.
- Ctrl+K removes from the caret to its line's end; at a line's end it removes the line break.
- Ctrl+W removes the word before the caret: back over any spaces and line breaks, then back to the next one, as bash does, so `src/app/store.ts` goes as one word.
- With text selected, each of the three removes the selection.
- Ctrl+Y types back what they removed.
  Removals straight after each other join in the order the text stood, so Ctrl+W twice then Ctrl+Y brings back both words.

`killRange` and `joinKill` are the pure rules; `ComposerField` holds the one kill buffer the task prompt and every reply row share, in memory only and never the clipboard.
A removal selects its range and deletes it with `execCommand("delete")`, and Ctrl+Y types at the caret, so the change event sees both like a keystroke and undo takes each back as a step of its own.
A read-only field (recording, or a reply that is sending) or a disabled one takes none of them.

The field owns these four because Chromium has no Ctrl+U or Ctrl+W and its Ctrl+Y brings back nothing.
The rest of the Mac's Control keys stay the platform's and are not reimplemented: Ctrl+A and Ctrl+E to the line's start and end, Ctrl+B and Ctrl+F by a character, Ctrl+P and Ctrl+N by a line (Ctrl+P in an empty field recalls, above), Ctrl+D and Ctrl+H delete forward and back, Ctrl+T swaps two characters.
Cmd and Option keys are untouched, so Option still types its characters and Option+Delete and Cmd+Delete delete as they always do.

### Undo

Each message field keeps its own undo history (`composerHistory.ts`), and Cmd+Z and Cmd+Shift+Z step through it: what was typed comes back in runs, as in a Mac text field, never one character at a time.

- A run is the typing since the caret last moved: moving the caret, a click, or typing over a selection starts a new one.
  Deleting with Delete or Ctrl+H runs on the same way, apart from the typing around it.
- A line the field adds (Shift+Enter, Option+Enter, Enter in a code block) ends its line's run, so Cmd+Z takes back one line at a time, its line break with it.
- Every other edit is a step of its own: a paste, a cut, a drop, file paths, Option+Delete, and each shell key's removal or Ctrl+Y.
- Cmd+Z restores the words and the selection from before the step; Cmd+Shift+Z goes forward again until the next edit.
- A draft replaced from outside (sent, recalled, a transcript) starts a new history, so a sent message never comes back through Cmd+Z; Up brings it back.
- A held field (recording, or a reply that is sending) takes no step.

The field records every edit from its `beforeinput` and `input` events, and the edits it makes itself (`asOwnEdit`) with their own kind.
It answers ⌘Z and ⇧⌘Z on keydown (`historyKey`), and the Edit menu's Undo through its `historyUndo` event, never letting the platform's own undo run.
On Linux, which has no Edit menu, it answers Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y forward, the same way.
The platform's history is not usable here: Chromium ends a run of typing whenever any node leaves the page, so a card or a feed line going away while someone types would split a run mid-word, and a controlled textarea, whose `defaultValue` React rewrites on every render, split it after every character.
Its history is also the whole window's, so it could undo an edit in another field.
The Edit menu's Redo item reaches the page only when the platform has something to redo, so in a message field it does nothing; ⇧⌘Z is the way forward.

## Growth and reflow

- The field is a `<textarea rows=1>` named `task-prompt`, labelled "Task prompt" (the role stays `textbox`; `tests/e2e/prompt.ts` finds it by name).
  A layout effect sets its height from `scrollHeight` less the field's vertical padding, one line at a time, up to 8 lines or the room left, then it scrolls.
  The room left is what its host's frame (`frame`, `frameMaxHeight`) holds beyond its other rows and the field's own padding.
  It measures when the text, width, line cap, room or font changes, not on an unrelated render.
  An empty field is one line whatever its placeholder would wrap to.
  So each hint also has a shorter form (`src/shared/firstRun.ts`; transcribing's is in `inputPlaceholder`), and the field shows the fullest form that fits that line in its own font (`ComposerField`'s `placeholder` list, `fittingHint`).
  A narrow input, such as the minimum window with both side panels docked, shows the shorter form rather than cutting the hint off mid-sentence.
  That window at 100% leaves the input 328px, the narrowest it is drawn: where a larger Size would leave it less between docked panels, the panels fold away instead (`docs/renderer.md`, "Docked rails and the input's room").
  The voice hint has a shortest form too, "hold right ⌥ to talk", for a key whose name is longer than a Mac's glyph: at that window Linux's "press/hold right Ctrl to talk" is a few pixels too wide, and "hold right Ctrl to talk" fits.
  The first-run hint has the same form before its frame, "give your first mate a task, or hold right ⌥ to talk": at the default window Linux's full first-run hint is too wide, and that one fits.
- The room: the shell is at most `promptShellMax(innerHeight)` tall, which puts its top exactly at the first mate's frame bottom once the frame has lifted (8 lines at 800 px, about 6 at the 640 px minimum), less `LAST_TURN_RISE` while the last turn shows, and less what collapsed panel headers lift its foot by.
- Multi-line means a line break, a wrap, or a chip.
  Then the foot row appears (hint, count, send).
  A first word that starts with `/` and could still be `/feedback` shows the foot row too, its hint naming the command: "/feedback: tell Infinitary's maker about a problem or an idea" (`typingSlashCommand`; `docs/feedback.md`).
  The text keeps the send control's column clear at every height, so it wraps at the same width in both layouts and cannot flip between them.
- The input is pinned by its bottom, `--prompt-floor` above the floor: at least `--space-9` in a page 864 px tall or taller.
  A shorter page gives back up to 84 px of it, all of it at 720 px (`docs/renderer.md`, "Short windows").
  With no card up it stands on a collapsed side panel header it shares columns with rather than cover it, and while a card is up that header steps aside instead (`docs/renderer.md`, "Collapsed headers under the input").
  A `ResizeObserver` on the shell writes `--prompt-rise` (its height over one line, plus the last turn's `LAST_TURN_RISE` while a turn shows) on the document, and the height over one line alone as `--prompt-growth`, which a side rail that ends above the input follows (`docs/renderer.md`, "Expanded panels beside the input").
  It never goes through the store, so a new line never re-renders the stage: `HomeMate` and `HomeScreen` subscribe only to whether there is a draft.
- Readers of `--prompt-rise`: the first mate and the card layer are centred at `50% - 60px - rise/2`; the card's cap `CARD_MAX_HEIGHT` (`ResponseCard.tsx`, also the thread pair's) subtracts the whole rise, and the card's 340 px floor yields to that cap, so the 56 px of air between a tall card and the input holds at every height, less the 14 px a short window takes back; the last turn's slot hangs from the input's top edge.
  The notices hang in their own container under the input's pinned bottom, keeping it in place while they fit below it.
  `usePromptFoot` (`promptFoot.ts`) writes their height as `--prompt-notices`, and the input's foot stays high enough for the whole notice even when a refused save needs more room.
  The first-launch gate's scrolling band ends above that foot and keeps a minimum band of room, so setup remains reachable while a notice is open.
- Motion: per-line growth is instant; the lift eases over `--stage-lift-duration` (`--dur-fast`, `0ms` under the shared reduced-motion rule in `design/tokens/effects.css`; alias in `design/styles.css`).

## The last turn

The captain's last two messages, each with the first mate's reply kept beside it, sit just above the input, and nothing else does (FI3-1089's plan, the captain's Approve and build: "Working…"; INF-2483's plan, the captain's Approve and build: "turn the mark to orange and spin it"; drawn as INF-1770's Chat layout, the captain's Approve and build: "allow last two rounds of messages instead of one round, with the older one fading a bit", "'working' should not block the user from seeing the last message if there is one" and "looks a bit more like chat for familarity").
They replace the activity line that used to pass there; the Activity panel keeps every line.
A round is one message of the captain's and the reply line kept beside it.

- **What shows.**
  The newest round sits nearest the input and the older round above it at 50% opacity.
  The captain's words sit on the right in a soft grey bubble (`--fg-1` mixed at 8%, corners 11, 11, 4 and 11 px, padding 2 px by 10 px), `--text-sm` in `--fg-1` on a 22 px row, at most 75% of the width; a message that was only pictures reads "A picture".
  The first mate's reply sits 2 px below on the left, plain `--text-sm` in `--fg-1` on a 20 px row, after the first mate's mark, the app's 14 px hexagon in `--accent`, 8 px before the words, at most 80% of the width.
  Newest ordinary words rest at 75% `--fg-2` mixed with 25% `--fg-3`, and the newest bubble rests at 4% `--fg-1` over transparent (INF-1968, the captain’s C selection).
  Hovering a round or focusing its reply lights only that round, never its sibling.
  The newest round restores ordinary words to `--fg-1` and its bubble to 8% immediately; leaving and blurring restores its quiet treatment, with no animation or timer.
  The older round keeps its colors and lifts from 50% to full opacity while hovered or focused, returning to 50% afterwards.
  The mark stays cyan (`--accent`) in both states, as the captain requested; composer focus alone does not brighten either round.
  The working mark, Working… and problem colors do not change.
  Neither carries quotation marks.
  Each line is one line; a line too long for its row ends on the last whole word that fits beside an ellipsis, never part way through a word, and resting on a cut line shows its whole text.
  The cut follows the row's width as the window or a side rail changes it, the line keeps all its words for a reader, and only a first word too wide for the row is cut part way (`src/renderer/src/design/core/wholeWords.ts`).
  A press anywhere on a round opens the conversation (below) at that round, unless it ended a drag that selected words; the captain's words take no Tab stop and draw no underline or focus ring.
  Each reply line, the older one included, is a button that opens the conversation at its round: it takes a Tab stop and the focus ring, and no other chrome; the working words are not a button.
  While a card or another stack entry is up, only the newest round shows, so a card keeps about the room it had with one round.
- **Working.**
  While the first mate's busy signal is up (`firstmate_state`), the newest round's mark turns `--hot`, the ember the app uses for work in flight, over `--dur-fast` and spins one steady turn every 2 seconds; no dots show.
  Working never takes a reply's place: an operational wake leaves the reply on screen with its own mark spinning beside it.
  A message with no reply yet shows the spinning mark and "Working…" in `--fg-3` where its reply will go.
  When the busy signal falls, the mark eases on to its next resting sixth of a turn over `--dur-med` as it fades back to `--accent`; the older round's mark never spins.
  The phone draws the same spinning mark (`MessageComposer.swift`); card threads keep their own working words.
  Before its turn has started, and after a turn that closed with no words where nothing took effect, the first mate's line is absent and the captain's words stand alone.
- **The reply line.**
  The core chooses it at the end of each captain turn that read the newest message (`replyLine`; INF-772's plan, the captain's Approve and build).
  It is the turn's closing words: the words of the turn's last model request, one plain sentence of about 40 characters that says what took effect, held to that by the prompt alone (`FIRSTMATE_PROMPT_CORE`'s close sentence); the core joins their lines with spaces and cuts nothing.
  The closing words are the line whatever else the turn did, a turn that only talked included (INF-4453).
  The typed facts the turn recorded where each call succeeded give the line when the turn closed with no words.
  Only inputs witnessed by the backend's owner-only `input_read` event count: Pi when the user message enters context, Claude when the client acknowledges it.
  Reading the newest message resets the reply facts and the closing words, excluding even the step already running when the message arrived.
  With no closing words, a shown or revised card's title comes first, regardless of its order in the turn.
  Without one, the latest app-written reply says `Started: <task title>` when work starts, or the app's reply words (`AUTOMATIC_EMOTE_WORDS`: Got it, Noted, All set).
  Successful filing says `Filed <task key>: <title>`; task updates, drops, links and unlinks, merge-approval withdrawals, and schedule creation or cancellation also name the action that took effect.
  Refused and unchanged record writes supply no success reply.
  A reply under the first mate's own card whose closing words land in the card's thread shows those words on the line as well; another action supplies Got it when nothing else replied.
  When the turn closed with no words and nothing took effect, the line stays absent.
  The answer check judges the message apart from the line, so a words-only turn still gets its retry when nothing answers the message (`docs/task-capture.md`).
  An unread message receives no line, and a later turn that never reads the newest message leaves its saved reply untouched.
  A failed or paused turn's line is `plainProblem`'s words for it, in `--danger`.
  A message the paused seat keeps says so at once: its receipt (`keptMessageWords`) is the reply line as well as a feed line.
  The core sends it as `firstmate_reply` before the busy signal falls, so the working words turn straight into it as it arrives, and an operational wake never sends one.
  When the closing words are the line and differ from it, the core keeps them as written beside it (`replyWords`, the reply's optional `words`), line breaks included, for the conversation.
- **What stays.**
  A message sent becomes the newest round at once (`user_turn`), the round it follows becomes the older one, and the round before that leaves; one sent while the first mate is busy keeps the spinning mark.
  The older round comes back as the older round on a new message even after it dissolved.
  Becoming the second-to-last round starts 15 seconds of visible reading time, then only that older round dissolves in place over `--dur-slow` (700 ms), with no movement; the newest round stays until the next message.
  The clock belongs to the older round’s arrival, not the newest reply’s completion or eligibility: work, a queued receipt, an unanswered newest message or a newest problem neither delays nor restarts it.
  It pauses while the window is inactive, the older round is hidden (Settings or any stack entry), or the pointer, a text selection or reply focus is on the lines.
  Each window keeps its own remaining time across those temporary hides.
  A new message starts a fresh 15 seconds for the round that has just become second-to-last, even when its words repeat.
  A new reply or background work does not restart that count or bring a dissolved older round back.
  A relaunch shows the two saved rounds again and starts a fresh 15 seconds for the older round.
  Dissolving never clears a saved message or reply line, and it does not move the input: the older round's room stays reserved and empty, with no link and no dim text.
  Reduced motion cuts the dissolve to an instant and does not shorten the 15 seconds.
  Fading does not move focus, change the draft, or read the reply out again.
  The saved rounds are the two newest `captain_asks` rows and the reply lines kept beside them (`TaskService.capture.setAskReply`, migration 68), read once as the window opens (`inf:conversation:last-turn`, the older round as its `previous`).
- **The conversation.**
  Pressing a round, or Enter or Space on its reply line, opens the conversation at the front of the stack, in front of any open card (INF-6337's plan, the captain's Approve and build: "a thread that has everything the user directly interacted with", "a place for people to find their recent cards"); it lands on the round pressed.
  The window holds it, as it holds a past card (`{ conversation }` in `OpenRecord`, `stack.ts`, `ConversationCard.tsx`): opening and reading it tell the first mate nothing.
  It is 720 px wide until dragged, carries the Note chip, a quiet Conversation heading and two views, Everything and Cards, and has no buttons or reply row; the shared minus or Esc puts it away.
  While it is the shown entry the lines above the input are not drawn, and the message box is its field: a message sent there joins its foot as it is sent, and the first mate's reply follows.
  There is one conversation: opening it again brings it to the front at the round asked.
  Everything holds the captain's acts oldest at the top and the newest at the foot: their messages with the first mate's whole reply as written, unboxed beside its mark; a press of a card's own button as a small tile naming the card, then "Chose" and the button's words; and a line typed under a card as its tile, the line, and the card author's first answer under it.
  A day line separates days, a time shows where the minute changes, the captain's words are whole in the grey bubble, and a problem reads in `--danger`.
  Cards lists the cards waiting on the captain first, those put aside included, newest first, then the cards they answered, newest first, each once with what they last did and when.
  A tile opens its card: a live card comes forward, and a closed one opens as a past card whose minus or Esc returns to the conversation, in the view it showed.
  The rounds come from the core a page at a time (`inf:conversation:thread`, `src/core/storage/conversationRead.ts`): the newest 30, and the 30 before the oldest one shown as a reader scrolls to the oldest end; Find in this card searches the rounds read so far.
  A round is a `captain_asks` row, a `card_observations` action whose actor is the captain, or a `card_messages` line of the captain's; a choice a card's own script made, a card put aside or taken down, and anything an agent did alone are not rounds.
  A line typed under the first mate's own card is saved both as a message and as a card line that message names (`typed_card_id`, `typed_line`), and it draws once, as a line under that card; one saved before that link existed draws twice.
  A card deleted with its task takes its tile rounds with it, and a message typed under a card now gone draws as a plain message.
  A home that cannot answer the read shows the two rounds the strip holds and says only those could be read.
  Open the conversation (`firstmate.reply`, `docs/keyboard.md`) opens it at its newest round from command search, after the lines have faded too, and comes home from Settings first; it keeps the reply note's id, so a key bound to it keeps working.
- **Motion.**
  A new round rises 6 px into place over `--dur-med`, the rounds that stay glide up to their new places over `--dur-med`, the newest eases to the older round's strength, and the round pushed out leaves over `--dur-fast`; the working words leave over `--dur-fast` and the reply rises 4 px in over `--dur-med`.
  Under reduced motion the durations are zero, so every move is a cut, and the working mark turns ember and stands still.
  A screen reader hears the newest reply once as it arrives, never the working words or the older round.
- **Room.**
  A round is 44 px tall; the two rounds are 10 px apart and the newest is 10 px above the input's top edge, in the slot hung from that edge, so it never moves the input; the notices stay under the input.
  The lane is 108 px with two rounds and 54 px with one (`lastTurnLane`, `promptGeometry.ts`).
  The stage's air already held one 22 px line and its gap there, so while a turn shows the rest of the lane (`lastTurnRise`) rides in `--prompt-rise`: the first mate and the card lift by half of it, a tall card's cap shrinks by all of it, and the input's own growth gives up as much.
  An expanded panel beside the input always clears the whole 108 px lane, so a message coming or dissolving never moves it.

## Paste and limits

- Picture paste limits are unchanged: four, 5 MB each.
  Every text paste over 20 lines or 2,000 characters becomes a remove-only file chip (`file · N lines · N KB`), not inline text.
  Short pastes remain inline with normalized line endings.
- Files hold the exact clipboard text, including line endings, in memory until send.
  Up to four files, 5 MB UTF-8 each; refusals are spoken beside the field without changing held files.
  A chip shows no path and cannot put text back inline.
- On send the core writes each full paste to the retained overflow folder as `pasted-text-<id>.txt`, using `capWithOverflow` with a forced write (even a short many-line paste).
  The message carries typed words, the first 2,000 characters and the existing truncation/pointer line.
  Nothing prunes the files.
- Only typed words count against the unchanged 20,000-character limit.
  Over the limit: “Too long to send.
  Trim it, or paste the long part so it goes as a file.”
  File previews are transport context, not typed input; even four previews can accompany a full typed draft.
  Recall restores file chips; a failed send preserves them.
- The first mate has no file reads: it carries the preview and pointer verbatim into `user_words` and tells the crewmate to read the whole file.
  Records display that text plainly.

## Files

The task prompt and a card's reply row (both layouts) take files through the same primitives: `useFileIntake` and `attachments/intake.ts` in the renderer, `FileControls.tsx` for the drop target, **Add files** button and preparing chips, `src/shared/attachments.ts` for what a file is, `src/core/attachments.ts` for what the host and core do with one.

- **Drop and choose.**
  The drop target is the whole input shell, chips included, and only the input under the pointer lights (`--accent` border).
  **Add files** opens the system picker (`inf:files:choose`: `openFile` with `multiSelections`, every file type) and is the keyboard path to everything a drop does.
  A file dropped anywhere else is ignored (`guardStrayFileDrops`): the window never navigates to it or opens it.
  A disabled input (the first-launch gate, or a window that has not read it yet) and a reply that is sending take no files.
- **What a file is** is decided from its content: PNG, JPEG, GIF and WebP by their leading bytes, text by strict UTF-8 (a BOM is kept; NUL and other binary control bytes are not text) - never by extension or the browser's MIME type.
  An empty file is text and attaches by name.
  Only the first 8 KB decide an unsupported file; it is never read in full.
- **Supported files become chips.**
  A picture is a picture chip (name, size, thumbnail), counted with pasted pictures (four, 5 MB).
  A text file is the file chip a long paste makes, with its name (`PastedText.name`): it shares the four-file text allowance with pasted text.
  Text keeps every byte and line ending; on send the core writes it to the overflow folder as before and the message carries `[attached file: name]`, the first 2,000 characters and the full-text pointer.
  While a file is read the chip says *Preparing* with a Cancel control; send waits until none is preparing (a voice send waits for it, `whenPrepared`), and a refused send keeps its draft and chips.
  An over-5 MB file, a full allowance, a folder, a shortcut (never followed) or a read failure each get their own notice and are never turned into a path.
- **A folder dropped on the task prompt** offers itself as a project, in a window on the first mate's own computer.
  The host answers its path (`inf:files:inspect`), and `inf:repos:offer-folder` puts up the project setup card for it with Add project (`docs/fleet.md`, "Asking the first mate to add a project"); nothing is added until that click.
  A folder already on the list gets the notice `folder-project` ("That folder is already one of your projects"), and one the app refuses gets `folder-not-project` ("That folder could not be added as a project").
  A folder given to a card's reply, to a view, or chosen through **Add files** keeps its notice (`FileDestination.addFolder`).
- **An unsupported format becomes its path.**
  A PDF, office document, archive or any other format is typed into the input, at the caret, as its absolute local path - ordinary editable text, one path per line, set apart from the words around it (`pathInsertion`), through the field's normal edit so undo works.
  No chip, no copy, no preview, no long-paste chip, no send.
  The path comes from Electron's `webUtils.getPathForFile` in the preload (`window.infinitary.files.dropped`), which the host checks is a regular file (`inf:files:inspect`, `lstat`, no link followed); the page never names a path.
  A generated File with no place on disk (a clipboard picture, a web download) cannot give one, and says so instead.
  Path text counts toward the 20,000 or 4,000 typed characters like any typed text and is never truncated; if it makes a draft too long, send is refused as usual and the text stays.
  Sending shares the path with the AI provider as part of the words; the file itself is not preserved, and the path goes stale if the original moves.
- **On an app controlling the first mate on another Mac** (`docs/view.md`) a path on this Mac would mean nothing where the words go, so no file becomes one.
  Pictures and text files become chips and go with the message as above, and the other Mac keeps their copies.
  Any other format, with a place on disk or without one, is not added, and the input's line names that Mac ("Only pictures and text files can go to MacBook Pro.
  Other files were not added.", `file-other-mac`).
  Each destination says whether a path means anything where its words go (`FileDestination.takesPaths`); the intake asks it when a result lands.
- **A mixed batch** is read in selection order: chips for what is supported, then all the paths as one block at the caret.
- **Destinations.**
  Every file is bound to its input by key (`main`, or the card's id) when it is given, not to whichever input is on screen when it finishes; a result for an input that no longer takes files (its card closed, its reply sending) is dropped.
  Other drafts are never touched.
- **Where bytes live.**
  Preparation is local and in renderer memory: nothing is copied before the captain sends, so there is no staging to clean, and drafts (words, paths, chips, recall) stay session-only.
  On acceptance the core gives the message its own copies of its pictures (`src/core/attachments.ts`: `<userData>/attachments/<message id>/`, 0700 folders, 0600 files, digest and type recorded, written through a temporary file) and its inbox row names them, so a parked, queued or retried message still has its bytes after a restart (`docs/inbox.md`).
  Its ask row names them too, so they stay with every task the message attaches to and reach the crewmate that takes it (`docs/task-capture.md`, "Pictures stay with the task").
  Originals are never edited, moved or deleted.
  Sent copies, like retained pasted text, have no automatic expiry.
- **Screen readers** hear each file by name, *Preparing*, ready and path insertion ("Added 2 file paths as text") through a polite live region (`FilesStatus`); the reply's button is "Add files to this reply".
- **Privacy.**
  Local preparation shares nothing.
  Send shares the typed words (paths included), previews and pictures with the selected model; a crewmate that later reads a file may share its contents.

## Voice

Settings → General has one **Dictation** row: the key button, then the switch.
Dictation defaults on with right ⌥, and with right Ctrl on Linux, where right Alt types accented letters.
Click the key and press right ⌥, right ⌘ or right ⌃ (right Alt, right Super or right Ctrl on Linux); Esc cancels.
The hint follows the saved key.
A tap of the key starts talking and the next press stops it; a hold talks until it is released (`followDictationKey`, `src/renderer/src/app/dictationKey.ts`).
Right ⌥ starts talking the moment it goes down.
Right ⌘ and right ⌃ also hold shortcuts, so their press starts nothing until it is a tap, released within a quarter of a second, or a hold, held that long on its own.
Another key pressed with one of them before then is that key's shortcut, and it runs with nothing recording: right ⌘+L goes to the main message, right ⌘+Enter sends, right ⌃+U deletes back to the start of the line.
Another key pressed once a hold has started talking drops what the hold recorded, then does its own work; Escape drops it as it always does.
A key the window takes before the page, such as ⌘L or a size key, never reaches the page, and Chromium then holds back every key's release until the next key goes down, so the window tells the page that it took a key, never which (`inf:keyboard:taken`), and the press ends there.
The window losing focus ends a press too, so a right ⌘+Tab to another app records nothing.
Off disables the picker but keeps its key, leaves key events alone, and changes the hint to "type a task for a crewmate".
The core persists both choices across launches.
Off discards capture and pending transcription, hides voice notices, and denies microphone access in the main process.
The downloaded model stays; an already-running download finishes quietly. macOS retains any permission previously given.
A computer with no graphics card its speech library can run on has no dictation: the hint reads "type a task for a crewmate" and the key does nothing, as on a Mac without WebGPU (`docs/architecture.md` section 8, "Where speech runs").

Microphone access is a line under the input, never a card (design skill `components/voice/VoiceInput.prompt.md`, "Under the pill").
Each hold reads macOS's answer without asking (`inf:voice:mic-access`, `systemPreferences.getMediaAccessStatus`) before the microphone opens.
While macOS has yet to ask, the line says it is asking and that what you say becomes text on this Mac and is never stored; it goes away by itself once macOS has its answer.
With access off the hold opens nothing, and the line says so with Close and Open System Settings (Privacy & Security, Microphone; `inf:voice:open-mic-settings`).
On a Mac whose administrator decides, the line says so with Close alone.
On Windows each hold reads Windows' answer the same way, from its Privacy & security switches, which Windows never asks a person about for a desktop app; access off says to turn it on in Windows Settings, under Privacy & security, Microphone, with Close and Open Windows Settings, which opens that page (`ms-settings:privacy-microphone`, `micSettingsUrl`, `src/main/voice/micAccess.ts`).
On Linux the lines name the desktop instead of macOS, and access off says to turn it on in the desktop's privacy settings with Close alone, as no desktop gives the app one page to open.
Any other failure to open the microphone keeps the line that says it is unavailable and you can still type.
A line about access stays through later holds until one works, and the window reads macOS again when it comes back, so access turned on in System Settings takes the line down without a restart.
The macOS prompt carries the app's own sentence (`NSMicrophoneUsageDescription` in `electron-builder.yml`, which the local app's config inherits).
A "Microphone access" card an earlier version raised comes down at the next launch.
Development and e2e runs stand in for macOS's answer with `INFINITARY_MIC_ACCESS`; the e2e launcher sets `granted` unless a spec names another.

- Recording keeps the draft on screen, read-only and dimmed; the foot row becomes abandon · waveform · accept · submit.
  From an empty field the text row folds away, so the pill is the one-row waveform it always was.
- The field reports its caret (`onSelect`, blur) into `inputCaret`.
  `insertVoiceTranscript(draft, caret, transcript)` puts the transcript there, with a space before it only when the character before is not a space, an opening bracket or the start, and a space after it only when the next character is not a space or closing punctuation.
  The caret lands after it through `focusCaret`, a caret position tied to one focus request (a card closing keeps the selection instead).
  A submit from the recording inserts the same way, then sends.
- Typing still holds the listening state; Esc abandons a recording and never clears a draft.

### Where the words go

The dictation key records into the field that has focus when it goes down: the main message, a card's reply, a note's comment or the crewmate's message box.
With focus anywhere else, such as on a card, a button or the empty stage, it records into the main message as it always did.
The other three offer themselves while they are on the page (`useDictationField`, `src/renderer/src/app/dictationField.ts`, over the registry in `src/renderer/src/voice/dictationFields.ts`), and the press takes the one whose element has focus.
The voice store keeps that field as `voiceField`, an opaque handle, and names none of them; null is the main message.
The words go in at that field's caret with the same `insertVoiceTranscript` spacing, the field keeps focus and the caret goes after them.
While it records, that field keeps its draft read-only and dimmed, and a mark row under it draws abandon · waveform · accept, with no submit (`DictationMark`, `src/renderer/src/design/voice/VoiceInput.tsx`); "transcribing what you said" takes that row while the words come back.
Microphone lines and voice errors draw under the field that records (`VoiceNotice`'s `field`), and the main message keeps its own pill and hint.
Enter in a field that records sends nothing, and Esc there abandons the recording and keeps the draft, before the field's own Escape.
A field that leaves the page before its words come back hands the recording, its words and its lines to the main message, so nothing said is lost.
Each field keeps its own limit: dictated words are never cut, and a field past its limit says so and sends nothing until trimmed ("The card reply row"; `docs/card-threads.md`, "Pointing at a card"; `docs/task-card-tabs.md`, "Typing").
The other fields still stop every other key at the field: the dictation key is the one key that passes.
Under control of a task's browser with focus on its page, the keys the page takes stay the page's: right ⌥ and right ⌃ go to the page and record nothing (`TaskBrowserView.tsx`, `docs/task-browser.md`).
A right ⌘ press there stays the app's, as every ⌘ shortcut does, and records into the main message.

## Recall and a failed send

`lastSent` holds the last turn sent - words, pastes and pictures - in memory only, never persisted.
Up in an empty field restores it with the caret at the end.
A send the core did not take puts everything back in an empty composer; if the captain has started a new draft, that draft is never overwritten, and the unsent turn waits in `lastSent` for Up.

## A draft started with words

`beginDraft(text)` (`src/renderer/src/app/composer.ts`) puts words at the head of the main message for the captain to finish: the caret goes right after them and focus goes to the field, and what was already typed stays after them.
Words the field already starts with are not added twice.
Two controls start one: the task browser's Report a problem ("This task's browser has a problem: ", `docs/task-browser.md`) and the create-your-own-panel slot ("Make me a panel that shows ", `docs/first-launch.md`), which is refused while the field is held, as Cmd+L is.
A panel starts one with `point.draft` (`docs/ui-plugins.md`, "Pointing and the view"), from the captain's own click or key and refused the same way: the Knowledge browser's Ask about this puts a question naming the entry it shows there (`docs/knowledge.md`, "Ask about this").
The finished words are an ordinary message.

## The card reply row

`ReplyRow` is the card's one field (INF-924; `docs/card-authoring.md`, "The card's one field"): the same `ComposerField` at `--text-sm` inside a pill `--reply-height` tall with the constant `--reply-radius` (design skill `components/cards/CardThread.prompt.md`).
Its send control is Chat (`ChatButton` in the same file): at the right edge of the card's button row while the field sits above the buttons, and beside the clip at the thread's foot.
It differs from the prompt only where a card needs it to:

- it grows to 5 lines, then scrolls; the clip, and Chat at the thread's foot, stay centred on the last line;
- the limit is `CARD_REPLY_MAX_CHARS` (4,000): the count shows from 80% under the field (`[data-card-reply-limit]`), and past it Chat is off (`aria-disabled`), Enter does nothing, and the too-long words sit beside the count; `sendReply` refuses the same way for any other path, and the draft stays;
- the text sent is `composeTurnText(draft, [])` plus core-written file previews/pointers, so typed words trim as the prompt does;
- a long paste becomes the same remove-only file chip (four, 5 MB each); the 4,000-character limit counts only typed words, and there is no hint row and no recall: every key but the dictation key stops at the field (`stopPropagation`), and the dictation key records into the reply ("Voice", "Where the words go"), whose Esc abandons the recording before the reply's own Escape;
- on send the words and chips clear immediately; while the core takes the reply, the empty field stays read-only, never disabled, so it keeps the focus: Enter and a paste do nothing until the reply is taken, and a click on Chat puts the caret back in the field, so the next reply is typed straight away;
- a reply the core refused restores its exact draft, pictures and file chips (`replyDrafts` and `replyPastes`, per card);
- picture pastes use the task prompt's `TURN_IMAGES_MAX` cap and size limit; refused pictures show the same shared notice beside the reply, without changing the main prompt's notice;
- ⇧⌘L, wherever focus is in the window, puts focus in the shown card's reply with its words and caret as they were; it is a window command (`docs/keyboard.md`, "Who runs a window command"), and the empty reply field shows that key at its far end until it has focus or words.

Thread messages render with `white-space: pre-wrap`, so a multi-line reply keeps its lines.

## Tests

- Files: `src/shared/attachments.test.ts` (classes, paths), `src/core/attachments.test.ts` (copies, picker import, symlinks), `attachments/intake.test.ts` (drops, batches, cancel, late results), and `tests/e2e/file-drop.spec.ts` (real disk-backed Files through the preload bridge, the picker handler, a card reply).
- The last turn: `src/core/orchestrator/replyLine.test.ts` (the closing words first, a words-only turn's words included, the typed fallbacks, no line when the turn closed with no words and nothing took effect), `firstmateAgent.reply.test.ts` ("FirstmateAgent reply line": the closing words of the turn's last request, never ones written before the newest message was read, an own card's thread answer on the line too, a words-only turn's words with the answer check still retrying, sent before busy falls, kept beside the message, a failure's words, an operational wake leaves it alone), `settingsMigrations.test.ts` (migration 68), `store.test.ts` ("the last turn above the input"), `LastTurn.test.tsx` (what each bubble says), `tests/browser/last-turn-whole-words.test.tsx` (at every width from the default window down to a third of it, both lines end on a whole word with the bubble hugging its words), and `tests/e2e/last-turn.spec.ts` (renderer lane: your message at once, the working bubble, the reply in its place, the input never moving, the keyboard reaching the reply, the closing words as the reply, a card's title, `Started:` and `Filed` when a turn closes with no words, the pair back after a relaunch, a whole turn under reduced motion with the character standing still, a mid-turn message receiving its own reply, and both bubbles reachable below a tallest card at the minimum window).
- Unit: `composerKeys.test.ts` (the whole Enter table, composing with every modifier; the shell keys, their ranges and joined kills; fence edge cases; the undo keys), `composerHistory.test.ts` (runs, lines, steps, redo, the smallest change), `src/shared/composer.test.ts` (trim, chip boundaries, line endings, the limit band at both limits, words, the hint form that fits), `dictation.test.ts` (each hint's forms), `voiceInput.test.ts` (transcript at the caret; chips inside the shell), `composer.test.ts` ("the multi-line composer") and `stackActions.test.ts` (a reply's lines and its limit), `CardThread.test.tsx` (a message keeps its line breaks), `promptGeometry.test.ts`.
- E2E: `tests/e2e/multiline-composer.spec.ts` (application lane: the long paste's chip and its file, and the shell keys with undo and Ctrl+P), `tests/browser/multiline-composer.test.tsx` (keys, fence, a short paste inline, recall, and undo and redo by the run and by the line while something else leaves the page, read from the turns the window sends), `tests/browser/multiline-composer-smallest.test.tsx` (at the smallest window a tall draft stays in view and clear of the card, as order between measured boxes), `tests/browser/voice-prompt-focus.test.tsx` (a click on send leaves the prompt focused for the next turn), `tests/browser/composer-safety.test.tsx` (PR 1's never-lose-a-draft, and an input method's Enter that never sends, read from the turns the window sends), `tests/e2e/now-panel.spec.ts` (at the narrowest stage the empty hint stays on its one line), `tests/e2e/card-threads.spec.ts` (a reply past the limit sends nothing; the reply field keeps its empty height on the first character and grows one line at a time; a reply typed over two lines with Shift+Enter keeps them in the thread; a reply's typing undoes and redoes as one run), `tests/browser/card-threads.test.tsx` (a reply refuses pictures past the shared count and size with the shared notice, and a reply typed over two lines with Shift+Enter shows both), the desktop lane's `voice-prompt-focus.spec.ts` (a transcript at the caret mid-draft, the draft visible while recording), the desktop lane's `voice-fields.spec.ts` (the dictation key writes into a card's reply by a hold and a note's comment by taps, at their caret with the focus kept, and Esc while the reply records abandons it and keeps the draft; both voice journeys supply their speech through `tests/e2e/speech.ts`), `src/renderer/src/app/store.voice.test.ts` (a recording into the focused field never touches the main message, and a field that leaves first hands its words to the main message), and `tests/browser/stage-reveals-reply-focus.test.tsx` (after a reply by Enter or by Chat, the next reply is typed straight into the field).
- Not automated: a real input method.
  The synthetic e2e proves the handler's branch, not an IME; a manual pass with Japanese (Kotoeri), Chinese (Pinyin) and Korean (2-Set) on the built app is the check.
  The Korean expectation: Enter commits the syllable and does not send; a second Enter sends.
