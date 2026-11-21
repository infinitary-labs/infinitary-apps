The app's default state: one input at the foot of the stage.
At one line it is a pill; as the draft grows it grows upward into a rounded rectangle and the stage lifts with it.
Recording keeps the draft on screen and turns the foot row into abandon (left) / waveform / accept / submit (rightmost).
```jsx
<VoiceInput mode="idle" value={text} onChange={edit} onSubmit={go}/>
<VoiceInput mode="recording" value={text} level={lvl} onAbandon={x} onAccept={ok} onSubmit={go}/>
<VoiceInput mode="idle" disabled keybindHint="connect a subscription first"/>
```
Settings → General has one Dictation row with a key button just before the switch.
The picker accepts right ⌥, right ⌘ or right ⌃; Esc keeps the old key.
While off the button dims and is disabled, the key is retained, and the hint is "type a task for a crewmate".
Off drops capture/pending transcription, leaves keys and microphone to other apps, and hides voice notices; the local model stays.

Default hint: "type, or press/hold right ⌥ to talk" (keybind configurable).
The hint has three states, and the host picks one (`docs/first-launch.md`): the standard hint; the first-run hint "give your first mate a task, or press/hold right ⌥ to talk" from the moment the first subscription connects until the captain's first turn ("give" is not "chat", "task" is the frame); and, while the first-launch gate is up, `disabled` with the line "connect a subscription first".
Disabled dims the whole pill to 45%, takes no typing, shows no submit control, and the host ignores hold-to-talk in the same state - the caption on the stage says what to do instead.
Before the host has read whether the gate is up, it holds the input the same way but keeps the pill at full strength with its usual hint, so a launch that is ready never fades in.
No error color: an empty app is not a fault.
The empty field is one line, so an input too narrow for a hint shows its shorter form, never a hint cut off mid-sentence.
Each shorter form keeps what the empty box does not already say: "press/hold right ⌥ to talk", "give your first mate a task", "type a task" (dictation off) and "transcribing".
A key whose name is longer than a Mac's glyph, such as Linux's right Ctrl, can overflow even the shorter form, so the voice hint has a shortest one: "hold right Ctrl to talk".
The first-run hint keeps its key the same way, before its frame: "give your first mate a task, or hold right Ctrl to talk".
The gated line fits the disabled input whole.

Shape: one line is exactly the pill - `--prompt-height` tall, `--prompt-radius` (half of it), the send control inline on the right.
The field is a textarea at `--text-md` on `--leading-body`.
It grows one line at a time, instantly, up to 8 lines, or less when its top would reach the first mate's frame (about 6 lines at the 960 × 640 minimum window), and then scrolls inside.
The radius stays `--prompt-radius` at every height: a pill at one line, a rounded rectangle taller.
The shell stays clear at every height - its hairline alone, never acrylic, never blur.

Rows, top to bottom: the chip row (only when something is attached), the text, and the foot row (only when the draft is multi-line - it holds a line break, wraps, or carries a chip - or while recording).
The foot row carries the key hint on the left (`--text-sm`, `--fg-3`, keys as `KeyCap` at the kbd style (`--text-sm`): "⏎ send · ⇧⏎ new line"; inside an open code block "in a code block ⏎ adds a line · ⌘⏎ sends"), then the count, then the send control on the right.
The text keeps the send control's column clear at every height, so no line re-wraps when the control moves down to the foot row.

The stage lifts: the input is pinned by its bottom, `--space-9` above the floor.
Short windows: in a page shorter than 864 px (a 1280 × 720 window, or a larger size) the stage's air gives way in proportion - the input's foot down to `--space-3` above the floor, the gap between the top bar and the stack, and the gap between the pager and the last turn - so a card keeps the room it has in an 864 px page down to a 720 px one, and the input's foot never comes down past the notices hanging under it.
The input is centered on the window, at most 560 px wide and `--space-4` clear of each docked rail, and never narrower than 328 px, its width with Activity and Tasks both expanded in the 960 px window at 100%, where every hint has a form that fits its line.
Where a larger Size would leave it less, the docked rails fold for it as they do for a card, with or without a card up: their panels go out of sight, keep running and keep their saved choices, and come back when a wider window or a smaller Size gives the room back.
The input is never drawn over a collapsed side panel's header at a rail's foot, which takes no card room and so can sit under it in a narrow window: with no card up, the input's foot stands on the highest such header it shares columns with; while a card is up, those headers step aside (hidden in place, their pages running) and the input keeps its foot, so the card keeps its room, and they come back when the last card goes.
Its growth is the runtime variable `--prompt-rise` (its height minus `--prompt-height`, plus the last turn's share while it shows (`lastTurnRise`: 76 px with two rounds, 22 px with one); the host writes it on the document, it is not a token).
The first mate and the card lift by half of it; the card's height cap shrinks by all of it, so the air between a tall card and the input never closes (the card body scrolls); the last turn rides above the input's top edge.
The lift eases over `--dur-fast` on `--ease-out`, and nothing moves under reduced motion.
Per-line growth itself is instant.

The last turn (captain's Approve and build on FI3-1089's plan: "Working…", and on INF-2483's plan: the spinning mark; drawn as INF-1770's Chat layout, the captain's Approve and build): the captain's last two messages, each with the first mate's reply, in a slot hung 10 px above the input's top edge, so they never move it; nothing else shows there, and the notices stay under the input.
A round is the captain's words and the reply under them; the newest round sits nearest the input, and the older round 10 px above it at 50% opacity.
The captain's words sit on the right in a soft grey bubble: `--fg-1` mixed at 8%, corners 11, 11, 4 and 11 px, padding 2 px by 10 px, `--text-sm` in `--fg-1` on a 22 px row, at most 75% of the width.
2 px below, the reply sits on the left as plain `--text-sm` in `--fg-1` on a 20 px row, at most 80% of the width, after the first mate's mark: the app's 14 px hexagon in `--accent`, 8 px before the words.
On desktop, newest ordinary words rest at 75% `--fg-2` mixed with 25% `--fg-3`, with a 4% `--fg-1` bubble over transparent (INF-1968’s C, the captain’s Approve and build).
Hovering a round or focusing its reply lights only that round, never its sibling; composer focus alone brightens neither.
The newest round immediately restores ordinary words to `--fg-1` and the bubble to 8%, with no animation or timer; leaving and blurring restores rest.
The older round keeps its colors and lifts from 50% to full opacity while hovered or focused, returning to 50% afterwards.
The captain’s written-in choice keeps the mark cyan (`--accent`) at rest and while reading; the working mark, Working… and problem colors stay unchanged.
A round is 44 px; the lane is 108 px with two rounds and 54 px with one.
No quotation marks: the side says who said it.
A message of pictures alone reads "A picture".
The reply is the first mate's closing sentence, about 40 characters saying what took effect (INF-772), and the app's own words, such as a card's title or "Started:" with the task's title, when it wrote none.
Each line is one line, its words cut with an ellipsis.
While the first mate works, the newest round's mark turns `--hot` (ember, the working color a busy crewmate and a busy row's dot share) over `--dur-fast` and spins one steady turn every 2 s, with no dots (INF-2483's plan, the captain's Approve and build: "simply turn the mark to orange and spin it"): working never hides a reply, and a reply's own mark spins beside its words.
When work ends the mark eases on to its next resting sixth of a turn over `--dur-med` as it fades back to `--accent`; the older round's mark never spins.
A message with no reply yet shows the spinning mark and "Working…" in `--fg-3` in its reply's place; a failed turn's words are `--danger`.
While a card is up only the newest round shows.
A new round rises 6 px into place over `--dur-med`, the rounds that stay glide up over `--dur-med`, the newest eases to the older round's strength, and the round pushed out leaves over `--dur-fast`; the working words leave over `--dur-fast` and the reply rises 4 px in over `--dur-med`; under reduced motion every move is a cut and the working mark turns ember and stands still.
On desktop, becoming second-to-last starts the older round’s 15 seconds of visible reading time, independent of the newest reply or work, then only the older round dissolves in place over `--dur-slow`; the newest stays until the next message.
The count pauses while the window is inactive, the older round is hidden by Settings or any stack entry, or the pointer, a selection or reply focus rests on the lines.
A new message resets the clock for its newly older round; a newest reply or work does not reset it, and reduced motion cuts the dissolve to an instant without shortening the 15 seconds.
Phone keeps its existing completed-reply clock and appearance.
After the dissolve the older round's room stays empty, so the input does not move, and there is no control to bring it back; the next message brings the round before it back as the older round.
A relaunch shows the two saved rounds again and starts a fresh 15 seconds for the older round on desktop, or for a known completed reply on phone.
The captain's words are not a control: the pointer stays an arrow, a click does nothing, Tab passes over them, and they draw no underline or focus ring; resting on a cut line shows its whole text.
Each reply line, the older one included, is a button with no chrome of its own (INF-1102's plan, the captain's Approve and build): it takes the pointer, a Tab stop and the focus ring, and a click, Enter or Space opens that whole reply as a note at the front of the stack, titled with its message in quotation marks, its words as the first mate wrote them; the shared minus or Esc puts it away (`docs/composer.md` "The reply note").

Keys: Enter sends.
Shift+Enter or Option+Enter adds a line (right Option is the default voice key; Enter while recording is ignored).
Cmd+Enter (Ctrl+Enter) always sends.
Inside an open ``` code block - an odd number of fence lines before the caret; `~~~` and a mid-line ``` do not count - Enter adds a line.
An Enter that confirms an input-method candidate (Japanese, Chinese, Korean) neither sends nor adds a line.
Up or Ctrl+P in an empty input (no words, no chips) brings back the last message sent, words and chips, in memory only; with anything in the input, either moves the caret.
Shell keys work beside the Mac's own: Ctrl+U removes to the line's start, Ctrl+K to its end, Ctrl+W the word before the caret, and Ctrl+Y types back what they removed.
The Mac's other Control keys (Ctrl+A, Ctrl+E and the rest) and every Cmd and Option key keep their usual meaning.
Tab is never captured.
There is no setting for the Enter key.

Chips live in the chip row inside the shell, never above it.
Every paste over 20 lines or 2,000 characters becomes a file chip: mono thumbnail, first non-blank line, “file · N lines · N KB”, and remove only (“Remove file, N lines”).
The chip shows no path; clicking it does not restore text inline.
Shorter pastes stay inline with normalized line endings.
Files keep exact clipboard text in memory until send, when the app writes the whole text to its overflow folder and appends its first 2,000 characters and a full-text pointer to the typed words.
Four files per message, 5 MB UTF-8 each; the same chips and caps apply in card replies.

Files: the shell is a drop target, covering its chips; only the input under the pointer lights its border `--accent`, and a file dropped anywhere else is ignored.
An **Add files** icon button (paperclip, `--fg-2`) sits left of the field and opens the system picker, so everything a drop does has a keyboard path.
A dropped or chosen picture or UTF-8 text file becomes a chip with its name: pictures with a thumbnail and the file's size, text files as the file chip with "size · Ready"; a file still being read shows the name, "Preparing" and a Cancel (×) control, and send waits for it.
An unsupported format (PDF, office document, archive) becomes no chip: its absolute path is typed into the field at the caret, one per line, as ordinary editable text.
A file with no place on disk gets a notice instead of a made-up path.
On a computer that controls the first mate on another computer (`../devices/RemoteControl.prompt.md`) a path on this computer means nothing there, so no format becomes a path: pictures and text files still become chips, and any other file is not added and gets one notice instead.
Screen readers hear each file's name and state and "Added N file paths as text" through a polite live region.
Everything uses the existing tokens, focus ring and reduced-motion rule.

Count and limit: only typed words count (20,000 in the task prompt; 4,000 in replies).
File previews do not count.
The count appears from 80%; over the limit it turns `--warn`, send is disabled, and the hint reads “Too long to send.
Trim it, or paste the long part so it goes as a file.”
Screen readers hear the count at band changes.
Recall and failed sends preserve file chips.

Recording keeps the draft: the text stays, read-only and dimmed, and the foot row becomes abandon · waveform · accept · submit.
With an empty draft the text row folds away, so recording from an empty input is the one-row waveform pill.
The transcript lands at the caret, with a space before it only when the character before is not already a space (or the start), and a space after it only when the next character is not a space or closing punctuation.
Esc abandons and never clears a draft.

Dictating into another field: the key writes where the person is typing.
With focus in a card's reply, a note's comment or the crewmate's message box, the recording is that field's, and the main input stays as it was: no waveform pill, no "transcribing" hint.
That field keeps its draft on screen, read-only and dimmed to the same 55%, and keeps the focus.
Under it, at the field's own width, the dictation mark: a 28 px row of abandon (28 px `IconButton`, danger, the Escape key) · waveform (the pill's own, 24 px tall) · accept (28 px, ok); there is no submit, because the field's own Enter sends.
While the words come back the same row reads "transcribing what you said" in `--text-sm` `--fg-3`, so the field does not jump when the mark goes.
The transcript lands at that field's caret by the same spacing rule, and the caret goes after it.
The quiet notice strip's voice lines - the download consent and progress, microphone access, errors - hang under that field too, at its width, below the mark; the main input carries them only when the recording is its own.
A field that leaves the page while its recording runs hands the recording to the main input: the words land there and the strip moves under it, so nothing said is lost.
Each field keeps its own limit: a transcript is never cut to fit; past the limit the field shows its count and the too-long sentence and sends nothing until trimmed.
With focus anywhere else, the main input records as above.

Trim: whitespace alone is empty - no send control, and Enter does nothing.
On send, leading blank lines and trailing whitespace go; the first line's indentation and interior blank lines stay.
A trailing line break stays in the draft while typing.

Under the pill: the quiet notice strip, at the pill's own width (edges aligned, `box-sizing: border-box`), `--bg-1` on a `--line-1` hairline, `--radius-m`, one `--text-sm` `--fg-2` sentence or two and at most two `sm` buttons on the right (ghost for the way out, primary for the acknowledgement).
It hangs in its own container below the input, keeping the input in place while the notice fits beneath it.
When a refusal needs more room, the input lifts enough to keep the whole notice in the window, and first-launch setup stays above the input in its own scrolling band.
It carries the voice model's download consent, progress and errors, microphone access (macOS asking, which clears by itself once answered; access off, with "Close" / "Open System Settings", and on Linux naming the desktop's privacy settings with "Close" alone; a computer whose administrator decides, with "Close"), the first launch's Diagnostics disclosure ("Turn off" / "OK"), and the composer's own line (one ghost "Dismiss notice") when it kept what the captain typed or pasted instead of taking it: "Up to 4 pictures per message.", "That picture is over 5 MB.", "Too long to send.
Trim it, or paste the long part so it goes as a file." and "That message did not send.", "Up to 4 files per message." and "That text is over 5 MB."
The composer's line sits first, nearest the pill; the words live in `src/shared/composer.ts`.
It never stacks more than one message a subject and never uses an error color for news that is not a fault.

Never lose a draft: nothing typed or pasted disappears without being sent.
A draft over the send limit (20,000 characters) is refused before the input clears, and stays.
A fifth picture, or one over 5 MB, is refused at paste while the others stay.
A send the app did not take puts the words, pasted text and pictures back in an empty input; if the captain has started a new draft, that draft is never overwritten and the unsent message waits for Up.
An Enter that confirms an input-method candidate never sends.

Attachments: while idle, paste (cmd/ctrl+v) of png/jpeg/gif/webp images attaches them as chips in the chip row (small thumb + filename + x), at most four.
Text+images and images-only are valid sends.
Enter or the send control sends the composed turn (text + pasted text + attachments).
Draft attachments and files live only in renderer compose state.
Sent file previews and pointers are plain text in records and threads; full file text stays in the overflow folder.

When the installed keys include a key used only when not typing, the unfocused empty main message shows "press [Go to the main message key] to write a message" through its existing placeholder.
While speech is being transcribed, "transcribing what you said" (or the narrow form "transcribing") takes precedence over that return-key hint, even while the message is unfocused.
The focused message, the first-launch gate and a map without such keys keep their existing hints.
There is no mode indicator.
