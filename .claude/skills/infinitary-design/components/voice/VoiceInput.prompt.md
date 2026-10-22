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
Short windows: a larger size can make the window shorter than 640 px to the page; then the stage's air gives way in proportion - the input's foot down to `--space-3` above the floor, the gap between the top bar and the stack, and the gap between the pager and the last turn - so a card keeps the room it has in the 640 px window, and the input's foot never comes down past the notices hanging under it.
The input is centered on the window, at most 560 px wide and `--space-4` clear of each docked rail, and never narrower than 328 px, its width with Activity and Tasks both expanded in the 960 px window at 100%, where every hint has a form that fits its line.
Where a larger Size would leave it less, the docked rails fold for it as they do for a card, with or without a card up: their panels go out of sight, keep running and keep their saved choices, and come back when a wider window or a smaller Size gives the room back.
The input is never drawn over a collapsed side panel's header at a rail's foot, which takes no card room and so can sit under it in a narrow window: with no card up, the input's foot stands on the highest such header it shares columns with; while a card is up, those headers step aside (hidden in place, their pages running) and the input keeps its foot, so the card keeps its room, and they come back when the last card goes.
Its growth is the runtime variable `--prompt-rise` (its height minus `--prompt-height`, plus the last turn's extra 18 px while it shows; the host writes it on the document, it is not a token).
The first mate and the card lift by half of it; the card's height cap shrinks by all of it, so the air between a tall card and the input never closes (the card body scrolls); the last turn rides above the input's top edge.
The lift eases over `--dur-fast` on `--ease-out`, and nothing moves under reduced motion.
Per-line growth itself is instant.

The last turn (captain's Approve and build on FI3-1089's plan: dots, "Working…"; drawn as FI3-1225's Subtitles, the captain's Approve and build; quoted as FI3-1387's Quotes, the captain's Approve and build): the captain's last message and the first mate's reply, two lines of type in a slot hung 10 px above the input's top edge, so they never move it; nothing else shows there, and the notices stay under the input.
Neither line has a border, a fill or padding.
Each line's words sit inside quotation marks drawn in `--fg-3`, 1 px from the words, so even a bare "Got it" reads as something said, never as a button; the order says who said it.
Both are centered on the axis the character and the input share.
The captain's words come first, `--text-sm` in `--fg-2` on an 18 px row (the captain's pick of grey over `--captain` violet); 4 px below, the reply is the same `--text-sm` in `--fg-1` on an 18 px row, 40 px in all.
A message of pictures alone reads "A picture" with no quotation marks, since it said no words.
The reply is the first mate's closing sentence, about 40 characters saying what took effect (INF-772), and the app's own words, such as a card's title or "Started:" with the task's title, when it wrote none.
Each line takes at most 80% of the width, and its words are cut with an ellipsis inside the marks.
While the first mate works its line shows three 4 px `--hot` dots (ember, the working color a busy crewmate and a busy row's dot share), 3 px apart, each brightening in turn over 1.2 s, and "Working…" in `--fg-3`, with no quotation marks; a failed turn's words are `--danger` inside the `--fg-3` marks.
A new pair rises 6 px into place over `--dur-med` as the old one leaves over `--dur-fast`; the working words leave over `--dur-fast` and the reply rises 4 px in over `--dur-med`; under reduced motion every move is a cut and the dots stand still.
A completed reply fades after 15 seconds of visible reading time, then both lines dissolve in place over `--dur-slow`, with no movement; reduced motion cuts that dissolve to an instant and does not shorten the 15 seconds.
The count pauses while the window is inactive, the message area is hidden, or the pointer or a selection rests on the lines, and a problem, a queued receipt, an unanswered message or an unknown line stays until the next message.
After the dissolve the slot stays empty, the same 40 px and the same 10 px gap, so the input does not move, and there is no control to bring the lines back.
A relaunch shows the saved pair again and starts a fresh 15 seconds for a known completed reply.
Neither line is a control: the pointer stays an arrow, a click does nothing, Tab passes over both, and neither draws an underline or a focus ring; resting on a cut line shows its whole text.

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
