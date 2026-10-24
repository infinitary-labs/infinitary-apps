A card is the head of a thread between the captain and the card's author, and the thread is host chrome - never the author's HTML.
The body's sandboxed frame is untouched by it.

**Before the first message** the thread does not exist and nothing is drawn for it.
The card ends with one reply row - a pill field reading "reply to this card…" and a send control - at the very BOTTOM of the card, below the action row, separated from it by one `--line-1` hairline.
The empty field shows Go to the card's reply (⇧⌘L) at its far end on the placeholder's line, as quiet mono text in the placeholder's color, not a keycap; it goes once the field has focus or words, it is hidden from assistive technology, and the field names that key in `aria-keyshortcuts`.
Send reply stays unlabeled.
It is the captain's own explicit revision ("when there's no thread yet, the reply input box should be at the very bottom of the card, below the action buttons").
A picture pasted into that row rides with the send the same way the main input does; a chip above the pill previews it.
A refused picture shows the composer's shared notice under the reply field.
The row takes files like the main input (`components/voice/VoiceInput.prompt.md`, "Files"): an "Add files to this reply" icon button beside send, the whole row (chips included, in the foot-of-card and thread-column layouts) as the drop target with an `--accent` inset border, named chips for supported files and an unsupported format as its path typed into the reply field.
A card whose author cannot be reached has no reply row at all: the host's own agent-down cards answer to nobody.
Neither has the welcome, the one card the host marks as taking no reply (FI3-1164): its words send a new person to the message box under it, and a second box on the card was too much.

The reply field is the composer's own field (`components/voice/VoiceInput.prompt.md`) at `--text-sm`: one line is a pill `--reply-height` tall, and it grows upward one line at a time to 5 lines inside the card, then scrolls; its radius stays `--reply-radius` (half the pill) at every height.
The send control sits beside it, centred on the field's last line.
The keys are the composer's: Enter sends, Shift+Enter or Option+Enter adds a line, Cmd+Enter always sends, Enter inside an open ``` code block adds a line, an Enter that confirms an input-method candidate neither sends nor adds a line, and the shell keys (Ctrl+U, Ctrl+K, Ctrl+W, Ctrl+Y) edit as they do in the task prompt.
Every paste over 20 lines or 2,000 characters becomes the same remove-only file chip as the task prompt, up to four files of 5 MB each.
Files are written only on send; previews and pointers appear as plain words in the thread.
The limit is a reply's 4,000 typed characters (file previews do not count), with the composer's count and refusal: from 80% the mono count ("3,200 / 4,000") sits under the field on the right; over it the count turns `--warn`, the send control is disabled, Enter does nothing, and "Too long to send.
Trim it, or paste the long part so it goes as a file." sits on the left in `--fg-2`.
A reply that did not send keeps its draft and file chips.
The field keeps the focus through a send, by Enter or by the send control, so the next reply is typed straight away; on send the words and chips clear immediately; while the core takes the reply, the empty field stays read-only and never goes disabled.
Right ⌥ does not record from the reply row.

**The first sent message opens the thread beside the card**, and the reply row moves into it, so the card returns to exactly its original footprint and never grows again.
It is the same field and the same card body, moved, never rebuilt: what the captain did in the body (a preview's state, an open disclosure, scrolling) is still there beside the thread.
A reply never moves the card (INF-770): it stays shown beside its thread whatever waits behind it, the pager and the arrows do not change, and the waiting line says who answers next and the way on.
Put aside and Close are the only ways a card leaves (`ResponseCard.prompt.md`, "Put aside" and "Close").

The pair is ONE container, not two (the captain's tweak: "the card and chat should feel like just one single container with a border in between, not two disconnected containers").
One opaque `--bg-2` (`--acrylic-bg`) with no blur (`--acrylic-blur`), one `--line-1` (`--acrylic-border`), one `--radius-l`, one `--acrylic-shadow`, and a single `--line-2` hairline dividing the two columns.
There is no gap between them and no second shadow.
The pair is centred on the window as one object, and it carries the card stack's pager under it exactly as a lone card does.

For card and thread sizing, stage width is the window minus twice the larger expanded rail, so one-sided panels never shift the pair.
Widths: thread `clamp(0.4 × stage, 288px, 360px)`, card `min(requested card width, stage − 32px − thread)` (normally 800px, or 560px for short plain notes).
When that card would fall under 400px the docked panels **fold** - the rails give their width back, the stage becomes the whole window, and the pair is placed again; a 4px `--accent` edge tab at each folded side says the panels are one click away, and clicking one collapses the thread so they return.
Collapsed panel headers stay visible but reserve no card clearance, except one the input would stand on, which steps aside while a card is up (`../voice/VoiceInput.prompt.md`, "Short windows").
The create-your-own-panel slot reserves it as an expanded panel does, so a wide card never covers it.
A maximized card (`ResponseCard.prompt.md`, "Maximize") keeps its open thread as the right column at the same width rule, on a stage that is the whole window, and the card takes the rest; there are no edge tabs while it is maximized.
Only if the pair still does not fit does the thread go **in place** - a segmented control in the card's head (`card` · `thread · N`) swaps the body for the message list - which needs a stage under 720px and is out of reach at the app's 960px window minimum.

The thread column, top to bottom: a mono micro-label head (`THREAD` alone, `--text-xs`, `.08em` tracking, uppercase, level with the card's head), the message list, and the reply row at its foot.
The head never repeats the card's author, model or close: the card beside it already carries them (the captain: "this thread panel should not repeat the task title and model name and the close button, because the attached card already has all of that"), and the card's own × closes the card and its thread.
Its one control is **Collapse thread** at the head's right end, a 28px `IconButton` that is never an ×: a 16px rounded square with a panel line on its right and a chevron pointing LEFT, into the card, because the arrow says where the thread goes (Lucide's `panel-right-open` glyph, whose name is the reverse of its meaning here; the captain found arrows the other way round "the opposite of what user would expect").
Its drawn label reads "Collapse thread" with the command's key (⌘\), and it names every key in `aria-keyshortcuts`.
While its author is actively working, the message list ends with the muted mono text `working` alone, without a crewmate glyph or author prefix; derive this from task activity, never reply-in-flight state.
While the captain's line is the newest on a crewmate's card and its author is not working, the list ends instead with the waiting line: one sentence in the host line's voice - `--fg-3` at `--text-xs`, body leading, sans, with no who and no accent - saying the reply is saved, what holds it and who goes next, and for a held account the way back ("Saved, not sent yet: your Claude plan's allowance is used up and resets 1:10pm.
It goes to crewmate 7 then, on its own.").
It is derived from the task's state, never a thread message, so it changes or leaves with that state and the card beside it does not change; `working` replaces it while a turn runs.

A message is a two-column grid: a mono `--fg-3` who at `34px`, then the text at `--text-sm` / `--leading-body` in `--fg-1`, its line breaks kept (`pre-wrap`), with the time trailing in mono `--fg-3` on one line.
The captain's who takes `--captain`, the author's `--accent`.
A host line - "revised: …", what the author changed instead of answering - is the whole row in `--fg-3` at one step down, with no accent: it is the app speaking, not a party to the conversation.
The settings a card sent with a captain's reply are never shown as the captain's words (the captain: "captain's message should not visibly show the appended settings value").
Under the captain's words sits one quiet line, collapsed by default: a mono `--fg-3` button at `--text-xs` with a right-pointing caret and "settings · N values", `--fg-2` on hover, the caret turning down when open.
It is a real button with `aria-expanded` and `aria-controls`.
Opened, it shows a boxed panel below it - `--bg-1`, a `--line-1` border, `--radius-s` - labelled "Settings sent with your reply at" its time.
The panel holds readable rows in mono `--text-xs`: the key in `--fg-3`, the value in `--fg-1`, and for a question " · changed" or " · as proposed" in `--fg-3`.
A staged JSON snapshot opens into one row per leaf, keyed by its dotted path; a picked option reads as its label, and words written under a question's Something else row follow in curly quotes.
Where the panel is under 250px wide each key stacks over its value.
The rows scroll past 240px, and a quiet `--fg-3` note closes the panel: "Sent to the author as context.
A reply never approves building."
Opening it near the foot of the list scrolls the panel into view only as far as keeps its own line visible.
The list scrolls, newest at the bottom, and holds its scroll at the bottom as messages arrive.

Nothing in the thread resolves the card.
The footer's buttons stay pinned and enabled while a thread is open and while a reply is in flight; a reply is not an answer to the decision.

**A collapsed thread** goes back into the card (the captain's FI3-1130 plan): the card returns to its lone width, and the same reply row, with its draft, pictures and chips, returns to the card's foot under the hairline, reading "reply to this card…".
It is the same field and the same body, moved, never rebuilt, and the cut is the move: no tween, as the thread opens.
Between the hairline and the reply pill sits the **latest line**, one button row that opens the thread again:

- who wrote last in the thread's 34px mono column, in the who's own color (`you` in `--captain`, `crew` or `mate` in `--accent`, `app` in `--fg-3`);
- the newest message on one line at `--text-sm` in `--fg-2`, cut with an ellipsis; a host line, or the waiting line's sentence in its place when it applies (with no who), is `--fg-3` at `--text-xs`;
- on the right in mono `--text-xs` `--fg-3`, "N messages", or `working` while the author's turn runs;
- a 14px icon ending the row whose chevron points RIGHT, toward where the thread opens (`panel-right-close`).

It is `--radius-s`, transparent, `--bg-3` on hover, and named "Show thread, N messages" (or ", author working").
A click or Enter on it, or ⌘\ ("Show or hide the card's thread", which command search lists), opens the thread; ⌘\ also collapses it.
A focused reply field keeps the focus through either move; otherwise collapsing focuses the latest line and opening focuses the collapse, ringed when a key moved it.
In a narrow window collapsing brings the folded panels back, and opening folds them again.
Any new line - the author's, the app's, or the captain's own reply sent from the collapsed row - opens the thread beside the card again, so nothing written goes unseen; a read that brings nothing new leaves it collapsed.
The collapse is this window's view of this card while it is up, like a dragged width: nothing is saved or sent to the author.

In the app this is `src/renderer/src/cards/CardThread.tsx` (`CardThread`, `ThreadCue` and `LatestLine` for the collapsed cue, styled in `cardThread.css`), with the ladder's arithmetic in `threadGeometry.ts` and the prototype the captain reviewed at `board/thread-prototype.html` of `fm3000-card-close-decision-model-s1`.

A newly born message and a newly appearing working row or waiting line fade in and rise 4px with `--dur-med` / `--ease-out`.
Persisted history is static even if fetched after the initial card paint, and re-pushing or remounting a message does not replay it.
The working row's busy state commits immediately; its removal is a cut.
No list-height tween, delay or transition-end listener.
The shared reduced-motion rule disables these entrances, including the drift.

Reply sharing and the 400px folding threshold stay unchanged.
A 750-unit drawing can shrink below its linted 11px size beside a thread; no new reply-folding policy is introduced.

## Revision links

Every revised row keeps its own ordered named-area links immediately below its existing title and timestamp, with no comparison caption.
A row compares its revision with the immediate predecessor, not the last-seen bars.
Links are `--text-sm` in `--fg-2`, underlined, with `--space-1` vertical and `--space-2` horizontal gaps; hover is `--accent`, and keyboard focus uses `--focus-ring`.
Three links show initially, then N more; Show fewer folds that row alone.
A removed count and an unavailable-area notice use the host row's quiet voice, with the notice under its originating row.
Legacy rows say Change links unavailable.

An area link opens ancestor disclosures and scrolls only the card's reading area, leaving `--space-6` of context above its first changed part.
Its destination briefly carries `--accent-dim` and the inset focus ring; reduced motion cuts the scroll.
Keyboard activation focuses the destination and Escape returns to the originating link without closing the card.
Unrelated disclosures, drafts, thread position and choices stay unchanged.
Older links locate their areas in the current card, preferring the surviving changed part and otherwise the same area's heading.
An unavailable or ambiguous area retains its link, says so quietly on activation, and moves nothing.
Whole card covers rewrites or excessive part counts, Preview updated covers interactive previews, and Title and Buttons target those actual regions.
Go to the next revised area is in command search without a default shortcut, follows the selected revision's list and defaults to the newest released list.
No incoming revision scrolls the card automatically; a collapsed thread keeps its existing opening control.
