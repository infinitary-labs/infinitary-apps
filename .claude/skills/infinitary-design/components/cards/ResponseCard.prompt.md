How the first mate communicates: a card, never a chat bubble.
ONE card shape; the chip is derived from what the card is, never declared: `decision` (chip "Decision", accent) has actions and asks the user to choose; `note` (chip "Note", neutral) has none and states a fact; `attention` (chip "Attention", danger) is the app's own card when no agent can answer - a provider needs sign in, the first mate is out of quota or hit an error, or a crewmate has stayed stuck through a nudge and two unanswered wakes (the stall card: "<task> has been stuck for 1h 20m", with Continue, Drop task and a danger Discard); plus `record` - a task's record (status pill in the task record card; body `TaskRecord`; never any card actions - its footer is the host's action bar, a lead sentence then Drop task and the one next step, Start / Continue / Show the card, and put in, discard and keep stay on cards).
A first mate card about a task names that task after its key, never only “first mate”.
A first mate card relaying an independent review carries the host-validated review task as `reviewTaskId`; the host draws a “Review finding” badge in `warn` beside the kind badge.
Its action row keeps the task facts beside the buttons, including the review verdict, reviewed version and risk, even while the review remains open.
A working preview is a decision whose body is interactive, not a kind of its own.
Every agent card is the head of a thread with its author and carries a reply row (but the welcome, which takes none, `CardThread.prompt.md`); the thread's own rules are `CardThread.prompt.md`, and a card with a thread open is one column of a single container rather than a surface of its own.
A card whose author ran on a model names it as the model chip (`ModelChip`, `../core/Badge.prompt.md`) right after the meta line: the meta line and the chip share the room between the kind chip and close, and the meta line is the one that gives way (ellipsis); the chip keeps its whole name, never cut and never pushed past close, wrapping inside itself only when the name is longer than all the room there is.
The model rides as its own field, never inside the meta text.
A card about a task leads its meta line with that task's key as a quiet key link, then a middle dot, then the meta words (`../core/TaskKey`, "The card's own key"): the key keeps its whole width and is a Tab stop between the kind chip and Maximize, the meta words beside it give way, and a click or Enter on it opens the task's record in front of the card, which Hide returns to.
Every card about a task has it the same way, and a card about no task draws none; the key rides as its own field too, never inside the meta text.
A card from a task that runs on another computer names where it runs right after the meta line, in the meta line's voice, "Fix the footer · on Mac mini" (`../devices/RunsOn.prompt.md`).
The place rides as its own field too: the meta line gives way first, and the place keeps its whole words, cut only when they are longer than all the room there is.
A card revised since the captain last saw it says so under its title, in one quiet line - `--font-mono` `--text-xs` `--fg-3`, the meta line's voice, `--space-1` under the title - reading "Revised 14:02 · 2 parts new · 1 removed": the time the shown version was written, then how many of its parts are new since then and how many parts of the version last seen are gone, each clause only when it is not zero.
A part is a paragraph, a list item, a table row, a figure or a question; the app compares the two versions itself and the author marks nothing.
Beside each new part the body draws a change bar: a 2 px `--accent` rule at `--radius-pill`, the part's height, in the margin 8 px left of the body's text, all bars in that one column whatever the part - nothing inside the part changes, so a figure, a table row and a question are marked the same way as a paragraph.
When more than half the parts are new the line reads "Rewritten 14:02" and nothing is marked: marking nearly everything says nothing.
A playable preview (a body with its own style sheet, canvas, or a script outside every figure) gets the line and no bars, since its own code draws it; a figure whose script sits inside it moves within a prose body, which is marked like any other.
Seen means shown on the stage while the window is visible and focused, so revisions that land while the captain is elsewhere accumulate - two unseen revisions are marked as one change from the version last seen - and a card never seen before it was revised is simply new, with no line.
The line and the bars stay until the next revision or until the card leaves; removed parts are only counted, there is no switch to read the previous version, and there is no setting.
The comparison ignores the host's own picture-copy names and the host's fact strip and follow-up rows, which the host rewrites on every call.
Every card has a top-right close control (IconButton, aria-label Close), with the size control, Maximize card, right before it ("Maximize", below).
Close dismisses the card; it is not a footer action.
Notes with no declared actions have no Done button.
Card actions acknowledge before the next paint: while the host accepts a request, the selected Button is pending and the entire action row is disabled.
Embedded body actions use the same request guard.
Acceptance closes the card before background work settles; the durable feed carries the outcome, including refusal reasons.
A close is a receipt for the choice, not proof of success.
See `../core/Button.prompt.md` for pending and inline request-error treatment.
A decision's footer reads left to right: the other choices (secondary; a destructive one such as Discard in `danger`), and the emitter's one default (primary) - the only primary on the card, unless the default is itself destructive, in which case danger wins.
The footer draws the default at the right edge whatever order a card lists its actions in, so a card the app writes itself, such as the stall card's Drop task, Discard and Continue, reads the same as an agent's.
Every action closes the card: the captain asks for a revision by replying, so there is no Revise or Explain more button, no automatic Later and no Keep button - closing the card is keep.
Keep `--space-3` above the action row so the body and buttons stay distinct.
The choices are one non-wrapping group in a right-aligned wrapping row: when the card is too narrow for one row they move down together, and the default never sits alone on a row.
Each live footer choice shows its direct key inside the button, after its label on the same line, the button six pixels wider than its label alone. ⌘1 is always the default, so a person learns one key for the recommended step; ⌘2 through ⌘4 take the other buttons from the right edge leftward, quiet actions included, and a footer with no default starts ⌘1 at its rightmost button.
The key is quiet mono at `--text-sm` in the button's own text color, set on the label's baseline near the button's right edge; the label moves left to make most of the room, the button widens by six pixels, and its height does not change (`Button.prompt.md`).
A key too long for that room, such as Ctrl+1 on Linux, widens the button only by what it still needs.
A fifth choice has no key.
Notes, past cards and buttons inside the body show none.
The drawn key is hidden from assistive technology; the button names it in `aria-keyshortcuts`.
Hints follow the installed keys and this computer's key words.
Migration 73 removes saved non-closing actions from open cards and returns cards left streaming to ready.
Every remaining footer action closes its card; changes come by reply.
A decision may ask several questions in its body, as ordinary named form controls the author presents as it likes (a radio group, checkboxes, a select, a text field; the question worded in its `fieldset`'s `legend`, or a lone field's bound `<label>`; short, stable names and values; radio, checkbox and select questions arriving unpicked - a select opening on an empty `Choose` option - with the recommended input or option marked `data-inf-recommended`, while a text field keeps its prefilled text and a preview its settings; `required` on a must-pick, a bound `<label>` per option; `docs/card-authoring.md` "Questions in the body").
A pick never sends anything: the footer's queue group - the first thing in the action row, pushed left, `--font-mono` `--text-xs` `--fg-3`, `aria-live="polite"` - counts them as "2 of 3 picked", with " · 1 changed" once an answer differs from the proposal, and is absent on a card whose body asks nothing.
Only the default closing choice waits until every required question has an answer: it is muted (`--bg-2`, `--fg-3`, `--line-1`) but focusable, and click or Enter focuses the first unpicked question without sending.
Other closing choices, and a saved card's ghost action, send what there is.
Options marked `data-inf-recommended` get an app-drawn Recommended tag (`--accent`, `--accent-dim`, `--radius-pill`, `--font-mono`, `--text-xs`); a select gets a Recommended label below it, leaving its value untouched.
Every radio group, select and group of two or more checkboxes outside a preview ends with the author's own row worded "Something else" and marked `data-inf-write-in` - a select's last option - and never carries the Recommended tag (FI3-1002).
Picking it opens a text field under it, focused: one line growing to three, `--text-sm`, indented to the row's words (full width under a select), placeholder "Say what you want instead", at most 500 characters.
Picking another option hides the field and keeps its words, which are sent only with the row; an empty field is no answer, so a required question's default still waits and its click focuses the field.
What the captain writes there counts as picked and changed, and reaches the author as the captain's own answer.
A question whose options are the only possible answers carries `data-inf-options-only` instead, a mark for the card check that the app does not draw.
After a thread reply or footer choice is accepted, the close warning compares current values with that send, not with the authored proposal; returning to the sent values needs no warning.
When the captain closes with any unsent picked answer, the × asks one question in a popover hung under it, right-aligned to it, and the action row stays as it is.
The popover is 296px of `--bg-2` with a `--line-2` hairline, `--radius-m`, `--shadow-2` and `--space-3` padding, and grows from the × like every popover: "You picked 2 answers.
Closing will discard them."
(`--text-sm`, `--fg-2`; a preview counts settings) above small `secondary` "Keep answering" and primary "Discard and close" on the right.
Escape, a click anywhere else or the × again keeps the card; a close from command search focuses Keep answering; nothing else asks.
The frame stylesheet dresses a plain `fieldset` as a hairline `--line-1` box at `--radius-m` with its `legend` in `--fg-1` weight 500, each radio or checkbox label a row with `--space-2` between control and text (`accent-color: --accent`, a checked row's text `--fg-1`), and a `textarea` full width under its label.
Every ready card body is semantic HTML in a sandboxed iframe.
The host owns the chip, title, size control, close, pager, and footer actions.
Follow the card contract the models read (`CARD_AUTHORING` in `src/core/prompts/cardContract.ts`, mirrored by the readme's Card bodies bullet): a card leads with its answer in one sentence (finished code-work completion cards are the exception: the title alone carries the answer, and the body opens at Why, then What changed, Before and After; `docs/card-authoring.md` owns that loose outline), and an answer that explains how something works, compares options, or shows state, shape or layout is drawn - that sentence, then the figures carrying it.
An explanation with several parts gets several figures, each beside the short sentence it illustrates, rather than one crowded drawing.
Keep prose needed to follow the answer in the open; reserve `<details>` for evidence, exact code paths, qualifications, and other material for a reader who digs.
Figures are free-form and all of SVG renders.
No shape is prescribed.
Give each SVG a `viewBox`, 750 units wide with `width="100%"` when it is full width, or its pixel width when it is smaller so the card only shrinks it; use theme tokens so it follows light and dark, `--accent` for the single most-current or lit element within each figure - one accent per figure, not one per card - non-accent tokens for everything else it draws, and `--ok`, `--warn`, or `--danger` only for real state.
A picture never reaches past the body's width; one that would stand taller than 360 px shrinks to fit 360 px, whole, letterboxed on `--bg-1` - never cropped.
Several in a `figure.inf-pictures` are a group, lead and strip: the first leads, the rest are 88 x 60 thumbnails cropped to their top, five shown and a mono `+N` tile for the rest, the `figcaption` under them; the frame stylesheet draws all of it, so a group of the body's own `data:` pictures looks the same.
A click on any picture, or on a group's `+N` tile, opens the picture viewer over the window, paging within that group (`PictureViewer.prompt.md`).

**A demo.**
A `figure[data-inf-demo]` is a recording of the app being used, where the motion is the point: a body shows only its poster, a still from the recording, sized like any picture, with its `figcaption` under it.
Between the two the frame draws one Play button: `Play · 12 s` with a small play triangle before it, in the body's own button look (`--text-sm` in `--fg-1`, a `--line-2` border, `--radius-m`) on `--bg-2`, `--space-2` under the poster, at its content's width, with the body's focus ring.
Its name says the length in words: "Play the demo, 12 seconds".
The button opens the viewer playing the recording; the poster, as a picture would, opens the viewer resting on the poster.
Nothing in the body moves: the recording plays only in the viewer, and only on that press.
A GIF demo, the fallback when no MP4 could be made, shows the same poster and the same Play button; the GIF itself never loads in the body.
A card carrying a settle effect or a validated review shows the host-rendered `.inf-facts` strip (project, crewmate model, posture, PR link, CI state, any round caps the host has counted, and the review on a reviewed task) that the body never repeats.
Its cells are the shape the task's own fact strip takes on its record and its crew summary (`../now/NowPanel.prompt.md`, Shared task facts), with the same state dot and words, and its pull request link is every pull request link's: `--accent`, underlined only while the pointer rests on it (`TaskRecord.prompt.md`, "Pull request links").
The strip is the first thing in the action row, pushed left of the buttons in a frame of its own, so it stays in view however long the body is; when the row cannot hold both it takes its own row above the buttons, and its hairline shows only where it follows a body, on a past card.
The completion card's merge says what a click does, and follows the strip's checks (INF-23): "Merge the pull request" while they passed; "Merge when checks pass" while they are still running, because a click then keeps the captain's merge and the app merges once they pass; and "Merge after fixing errors" once they failed, because the kept merge then waits for a fix, which brings a new version with fresh checks.
A card whose click keeps nothing, such as a first mate's, keeps its words.

**The risk chart.**
A crewmate's merge card carries its risk as a radar the app draws at the card's top right, level with the title's top and flush with its content edge (FI3-1127's plan; the app's `docs/card-authoring.md`, "The risk chart").
It is 128 px tall - from the title's top through What changed when each section has one line - and as wide as its labels need, 216 px for the seven names, with rings 80 px across; the box keeps each label's width at its axis end, so a label on the outer ring never leaves it.
Seven axes run clockwise from the top: Blast radius, Behavior, Undo, Evidence, Sensitivity, Novelty, Dependencies.
Three faint rings and the axes are `--line-1`; the shape of the seven levels is filled `--accent-dim` and stroked `--accent` at 1.25, and answers to nothing; each vertex is a 4 px dot in its own level's color from the checks - low `--ok`, medium `--warn`, high `--danger` - with a 1.5 `--bg-2` ring.
No word sums it up: no overall level on the chart, the strip, the record or the feed.
The title and the revised line give way by the chart's width plus `--space-4`; the body's first lines flow around its lower part, and from the body's third heading on - Before, After and below - everything clears it and takes the body's whole width.
It scrolls away with the top of the body, clipped at the title's top.
Each dot is a target of its own with a 20 px hit circle and a Tab stop, in the axes' order, right after close, drawing the focus ring.
Resting on a dot, or focusing it, grows it to 6 px, lights its label on the outer ring (`--font-mono` `--text-xs` `--fg-1`; hidden otherwise) and opens its note: 236 px of `--bg-2` with a `--line-1` hairline, `--radius-m`, `--shadow-2`, `--space-2` `--space-3` padding, 10 px left of the chart and level with the dot, never rising more than 8 px above the chart.
The note's title row reads in `--fg-1`: the dimension at weight 500, then its level in words after a `·`.
The crewmate's one line sits `--space-2` under it in `--fg-2`, so the two read as separate parts.
Leaving, Esc (which closes nothing else) or a scroll of the body closes it; a dot reached by the keyboard while the body is scrolled brings the chart back.
A past card draws the chart its version had, at its title's top right.

**A live attachment.**
A card may carry one live thing the app owns and its author labels: a crewmate's door to its task's own browser (`TaskBrowser.prompt.md`, "From a card"), which may open a page from its task's project, such as a finished game's `Play`.
It is a strip of host chrome between the body and the action row, on a decision and a note alike: a `--line-1` hairline above it, `--space-2` above and below, 16 px at its sides like the action row, `--text-xs`.
It reads the micro label `BROWSER`, then the line - the site in mono `--fg-1` (`localhost:5173`), then in `--fg-3` who is driving or what stopped it after `·`, the same words as the record's Browser line - then, pushed right, the author's label as a small `secondary` Button: `Try it`, `View search`, `View booking`.
The line is one line and gives way with an ellipsis; the button never does.
When the browser the card was emitted with has stopped and a newer one took its place, or Infinitary has quit since, the line reads `this card's browser has stopped` with no site, and the button still opens the view, which says the same.
A click opens the task's browser view at the front of the stack; the card stays behind it, unanswered, with its buttons, its answers and its merge as they were, and its author is told nothing.
It is navigation, never a card action: it runs no effect, the body's script can neither see nor press it, it stays enabled while the card's buttons wait on a request, and a past card does not draw it.
A browser button may instead open a page from the task's project, such as a finished game's `Play`: the same strip, the micro label `BROWSER`, then the file's path in mono `--fg-1` (`index.html`) and in `--fg-3` `· opens in this task's browser`, then the author's label as the small `secondary` Button.
It needs no browser open when the card goes up, and it stays on a note whose task has closed.
A click opens the task's browser view at the front of the stack with that page loaded and the captain already in control (`TaskBrowser.prompt.md`, "A page from the project"); the card stays behind it as it was, unanswered, its author told nothing.
When the app does not open it - the file is not in the project yet, its path goes through a link, the project is gone - the line reads why in `--fg-2` instead, one line with an ellipsis and the whole sentence on hover, until the next click.
A crewmate's card that asks the captain to take over its browser (`TaskBrowser.prompt.md`, "Asking for help") is an ordinary decision whose body names the site and why, with one action such as `Open browser and sign in` that opens the view with the captain taking control, and one such as `Leave waiting`; its strip is always drawn, with no button: that action is the card's one way into the browser.
When this computer has a sign-in saved for the card's site and the browser holds none of the captain's yet, the host adds `Use my saved <site> sign-in` as the card's default, last in the row, and the crewmate's open-browser action reads `Sign in myself` beside it (`TaskBrowser.prompt.md`, "Saved sign-ins").
A final payment is asked the same way, on a review card (`TaskBrowser.prompt.md`, "A final submission"): its title is the step and the amount on the site, `Ready to pay €312.00 on aurora.example`; its body leads with one sentence, then a two-column table of what the captain commits to - route, dates with time zones, passenger, seller, total and currency, baggage, fare rules, still uncertain - with the change since his last choice in a `<mark>`; its actions are `Stop here` and `Open browser and pay`, the default.
When the site never confirms, the crewmate's decision says the outcome is unknown and that it did not pay again, with `Treat as not booked` and `Open browser and check`, the default; its strip is the same request strip.
While that request stands the strip is attention: `--warn-dim` behind it with `--radius-m`, `--space-2` inside it, and the line reads `paused for your help`; while the captain has control it is his violet (`--captain-dim`) and reads `you have control`.
The card's action answers it at the press; when he took the browser from the task's record instead, his Return control takes the card down, so he never comes back to a request he has already answered.
At the end of the body on a card whose button merges, the host draws "Filed while working on this" (`.inf-followups`): one single-line row per open follow-up filed from the task - key in `--font-mono`, title cut with an ellipsis, and one word at the end (must merge first in `--warn` with the warning mark, starts once this merges, working, queued, backlog), the full sentence on hover.
At the end of the body on a card whose button sends something where the project lives, the host draws what the click sends, once (`.inf-call`): a `--line-1` / `--radius-m` panel with the `h6` micro label naming where it goes, the call in `--font-mono`, and one `--text-sm` line in `--fg-3`.
For a merge past the branch rules it reads the pull request, its version and squash, then one row per rule it may skip with its rule set in `--fg-3` and one `--warn` row per failed check, and the host names the button `Merge, skipping the rules`; the author's `Not now` stays beside it.
For a write a crewmate asks to send (`request_write`) it reads the method and path, then the JSON body in a `pre` on `--bg-1` with `--radius-s`, at most 240 px tall and scrolled inside, and the host names the button `Send it to GitHub` after the host's own name; the author's `Not now` stays beside it.
A body's own inline script may add behavior (a canvas, a toggle, a figure that moves on a press, `components/viz/Viz.prompt.md` Motion) but loads nothing; if it stops answering, the body becomes one `--fg-3` / `--text-sm` line, "This card stopped responding.", with a `secondary` `sm` Retry Button on the same row - no icon, no danger color, chrome unchanged.
A card defaults to wide (800 px).
Only a text-only body under 600 visible characters stays regular (560 px): paragraphs, lists, headings, links and folded details, with no drawing, picture, table, code block or question.
Full stays the stage up to 1040.
Width is decided from the resolved author's body on every emit and revision, excluding host facts.
Stored `regular` means short and plain; absent width means default-wide; explicit `wide` or `full` means content-required room.
Existing cards with no width become default-wide until revised.
A table of 4+ columns, a `<pre>` line over 60 characters, a picture 900 px or wider, a picture group or a preview requires wide; a picture 1,600 px or wider or a table of 6+ columns requires full.
Author hints only widen.
Settings → Appearance adds a Default card size row after Size, using GroupedPills: Usual, Wide, Full and Maximized.
Usual is the initial choice and keeps the content-based sizes above.
Wide and Full set a minimum opening width of 800 and 1040 px respectively, without narrowing content-required cards; available room still bounds them, and the captain's edge drag overrides them.
Maximized opens each card brought forward in the existing maximized view; Restore, Escape and Go to the main message still restore that visit, without changing the saved choice.
The setting belongs to this computer's persisted appearance, including on a computer controlling another computer's first mate.
Each card keeps its own width while paging.
A default-wide card gives way to docked panels, taking available room up to 800; panels fold only below 560 px of available room.
Regular cards fold panels when the stage cannot keep their requested width, including a drag of 560 px or less (FI3-489); folding is temporary and never changes saved panel choices.
The prompt remains 560 px.
The captain drags either edge, 480 to full, and the card grows from its centre by twice the pointer's travel; the drag holds while the card is up and through its revisions, and a double click returns the decided width.
Each edge is a 12 px `role="separator"` strip ("Resize card", arrow keys move 16 px, Home and End to the ends, Enter returns the decided width) whose grip - a 4 x 32 `--accent` pill, `--radius-pill` - shows only while the edge is hovered, held or focused.
A lone card stays centred on the window, reserving equal clearance on both sides from the larger expanded rail.
Collapsed panel headers reserve no card width; one the input would stand on steps aside while a card is up (`../voice/VoiceInput.prompt.md`, "Short windows").
When the docked stage cannot give a content-required or dragged card wider than regular 720 px (or what it asks, if less) and a dock is occupied, the docks fold as they do for a thread and unfold when the card leaves.
A lone card offers the Show panels edge tabs only when returning the card to regular would unfold the docks; otherwise it keeps its width without offering a dead action.
A tab click returns the lone card to regular.
Replacement width and rail folding resolve immediately before the body is born; width is never tweened.
A drag follows the pointer, and a resized window or dock is followed at once.
Only the presentation shell height interpolates on replacement after initialized first draw; its intrinsic iframe height stays immediate and independent.
Height: a card is at most the stage's room for it, and only its reading space gives way to a short window.
The body shrinks and scrolls first; when even the title and the body's box no longer fit together, the title scrolls up out of the body's way, so the head with close, the attachment, the action row and the reply row are never cut.
A card too short even for those scrolls as a whole rather than cutting them.
Inside the body, prose (paragraphs, lists, headings, captions, summaries) keeps a 66-character measure in any width while tables, code, picture groups and figures take the room, and a `width="100%"` drawing is capped at its own viewBox units, so a 750-unit figure draws 1:1 in a wide card rather than growing with it.
The body's document carries `data-width` (`regular`, `wide`, `full`) for the size it is shown at.

**Maximize.**
Every card on the stage - a decision, a note, an attention card, a task's record, a past card, a panel's card such as the task board, and a task's browser where the build offers it - carries one size control immediately before its Close or Hide: an `IconButton` with outward diagonal arrows (Lucide `maximize-2`), labelled `Maximize card`.
While the card is maximized the same control reads `Restore card`, with inward arrows (Lucide `minimize-2`); Close and Hide keep their meaning and their question.
Maximized, the card nearly fills the app's window: the window's width less 16 px at each side, with no width of its own and no drag, from 16 px under the top bar to 16 px above the window's bottom, less a 40 px lane for the pager when there is one.
Its surface fills that room however short its body; the window and its top bar do not change.
The side panels and the main message step aside, hidden and out of the keyboard's reach, with their panels running and their words kept; the stack's peeks and the edge grips go too, and the pager stays in its lane.
The head, title, body, attachment, facts strip, action row and reply keep their places, and the body scrolls inside as ever; prose keeps its 66-character measure while tables, code and wide drawings take the room.
A thread already open beside the card stays its right column at its own width and the card takes the rest (`CardThread.prompt.md`); maximizing opens no thread.
It is the same card, never a copy: its page, answers, open details, script and reply stay as they were through any number of changes of size, and the reading place in its body holds.
Restore, or an Escape nothing in the card used, gives it back its usual width, or the width the captain dragged, and the panels as they were; the card's own controls, the close question, the picture viewer and command search use their Escape first, and a record or a panel's card restores on Escape before a later Escape hides it.
A click outside the card does nothing.
The keyboard's focus lands on the size control after each change; while maximized, Tab and ⇧Tab go round the card, its thread and its pager, and the window's parts are the card alone.
Command search lists "Maximize or restore card", with no key of its own (`docs/keyboard.md`).
A manual maximize or restore belongs to the shown card alone and is never saved: a revision keeps it, a lone card's reply keeps it and opens its thread as usual, and an arrival waits on the pager as ever.
Paging, closing, a withdrawal, a reply that sends the card back, another card brought forward, Settings and a restart end that override, and the next shown card follows Default card size.
Going to the main message restores the current card until another card comes forward.
A change of size is a cut: no width tween, no scaled text, no blur.
```jsx
<ResponseCard kind="decision" title="Two ways to fix the flaky test" meta="just now" onClose={onClose}
  actions={<><Button variant="secondary">Mock the clock</Button><Button>Await the queue</Button></>}>
  <iframe title="Two ways to fix the flaky test body" sandbox="allow-scripts" srcDoc={bodyDocument} />
</ResponseCard>
```

The shared surface is opaque `--bg-2`, no backdrop blur, a `--line-1` border and the unchanged card shadow, in both themes.
Legacy `--acrylic-*` tokens alias these values.
A task record supplies its host header and lifecycle footer to the same surface and scroller, with no thread/reply row.

## Task keys in a body (FI3-594)

A task key a body writes as text - `FI3-572` in a sentence, in `inf-mono`, or in the "Filed while working on this" rows - is a link to that task, with no markup from the author, by the core rule (`../core/TaskKey`): which words link, how a key reads in words, the keyboard, closing and the click.
The same rule links the keys in a card's title, its action error line and every line of its thread, and leaves the card's own task's key as text in all of them.

- **Rest.**
  Resting on a key opens the crew summary for its task outside the card, level with the key, on the side facing the stage's middle, 14px clear of the card's edge, with the `--line-2` hairline running from the card's edge on the key's line - never across the card's words.
  A card with its thread open is one card for this: the summary sits outside the pair.
  It stays inside the window under the top bar with 8px of air and clear of the input and the rails' panels; where neither side of the card has room it sits 14px under the key's line, centred on the key (or over it, where under has no room), its hairline dropping from the key, so it may cover the card's other words but never the key.

## Knowledge references in a body (FI3-1150)

In a build with knowledge to show, a concept's or a finding's id a body writes as text - `f-ejtt2f`, usually in `inf-mono` beside the claim it backs - is a compact reference to that entry, with no markup from the author.
Which findings an answer relies on is the author's call: the app links what the body writes and adds nothing of its own.

- **How it reads.**
  The id stays as written, in mono, as a link in `--accent` with the body's underline, led by a 6px dot in its standing's state color: `--ok` for a finding checked with evidence, `--warn` for one that needs rechecking or has differing evidence, `--fg-3` for the rest and for a concept.
  Its name for a screen reader, and on hover, is what it is, its id, its words and its standing: `Finding f-ejtt2f: A retry keeps the original message identity · Checked`.
  Resting on it gives it the row hover surface (`--bg-3`, `--radius-s`); it opens no summary.
- **Which words.**
  Only an id that names an entry in a collection the window reads: an id-shaped word that names nothing, an uppercase one, or part of a longer word (`f-abc1234`) stays text, as do ids inside links, controls, drawings and `data-inf-action` elements.
  A stable build links none, and the body reads as written.
- **Click.**
  A click or Enter brings the Knowledge browser to the front with its inspector on that entry at its current revision and the keyboard on the inspector's section (`../knowledge/KnowledgeBrowser`); Hide returns to the card.
  It is navigation, never a card action: it records no use, checks nothing, sends nothing to the author, and works on a past card too.

## Pull request numbers in a body (FI3-1307)

A pull request a body names by its number is a link to its page, as every pull request the app names is (`TaskRecord.prompt.md`, "Pull request links").
The author writes the link - `<a class="inf-mono" href="its page">PR #N</a>` - with the page a tool answered; the app links no number on its own, and a number with no page stays plain mono.

- **How it reads.**
  The number stays in mono, in `--accent`, underlined only while the pointer rests on it, so it reads as the merge card's PULL REQUEST cell beside it.
  It is a Tab stop with the focus ring.
- **Click.**
  A click or Enter opens the pull request in the browser, through the same safe opener as every link in a body.

## Past card (FI3-579, direction A)

A closed card can be read again on the stage, exactly as the captain last saw it, and does nothing.
It is a shell-held entry like a task record: one per saved card, opened at the front and shown at once, paging with the stack, never persisted or emitted as a card, and gone on Hide or Esc (the top-right cross, label `Hide`).
Hide only hides; the saved card, its thread and its record keep everything.

- **PAST strip.**
  The first row, `--text-xs` mono `--fg-3`, uppercase: a `PAST` mark in `--accent`, the task key where the card has a task, then how it ended and when: `You chose Approve and build`, `Closed without choosing`, `Withdrawn by its author`, `Taken down when the task ended`, `Taken down by the app`, `Closed as a duplicate`; the time reads absolute (`2 Oct, 18:14`).
  The strip carries no button but Hide.
  Words: past card, never version, lifecycle or resolution.
- **The body is the version the captain last saw**, in the normal card frame, with its figures and pictures.
  A newer saved revision the captain never saw is not shown.
  The submitted answers to the body's own questions are filled back in and the controls are disabled; a body's script runs but every action it raises is refused, and nothing it does is saved.
- **Buttons are history, not controls** (the captain's 1A: read-only everywhere).
  The footer shows the actions the card offered, in their place, all `disabled` and dimmed to `--fg-3`; the one the captain chose is marked `✓` with the `--accent` hairline and stays at full contrast.
  A card that ended without a choice marks none.
  No button on a past card runs an effect, resolves, or asks the host anything; acting on it means talking to the first mate while it is shown.
- **The thread is read-only beside the card** when it has messages (the same pair placement as a live thread) and has no reply row; a card with no thread draws no column.
  Closing the thread column is not offered.
- **Keyboard.**
  Esc hides the shown past card; focus returns to the stage.
  Disabled buttons are not focusable; Hide is the card's one tab stop before the body, but for the risk chart's dots on a merge card, which only open their notes.
- **Turn context.**
  Only the shown entry supplies the turn hint: while a past card is shown, the captain's words reach the first mate with that card (its ending and task) as context.
- **Doors.**
  A task record's Cards row (`TaskRecord`), the Tasks filter's results and the first mate all open the same entry through the one shared show-card action.
  Nothing about a past card is a new stored card or a notification; its own opening is not a feed line either, except the first mate's pointing, which leaves one.

A completion card with required captain actions draws a host notice outside the body scroller, immediately above its buttons.
It reads “After merging, you need to…” and names every action, target and consequence in the normal body size.
Several actions have a visible count and a focusable disclosure with every requirement; the list may scroll but never truncates requirements.
The notice uses the existing neutral panel border, spacing and focus ring.
In a short card it uses compact spacing and a focusable list scroller, leaving the merge buttons wholly visible above the reply row.
After successful merging, each independent obligation gets a decision card with inert instructions, a specific confirmation and Not now.
Deferred obligations remain under Waiting on you in Tasks with Show the card; manual results read Confirmed by you and observed results Checked by your first mate.
