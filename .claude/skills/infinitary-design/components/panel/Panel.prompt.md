The panel primitives: the five looks every side panel is built from - `Row`, `FeedLine`, `MicroLabel`, `Empty`, `Disclosure`.
They are the now panel's and the activity feed's own vocabulary, named and separated so a panel that is neither can still read like both.
The app is the reference implementation (`src/renderer/src/design/panel/`), and it is what `@infinitary/ui` serves to a personal panel; `components/now/NowPanel` and `components/mate/ActivityFeed` remain the composed specs these came out of.

**Row** - one list row at a rail's width: a `StatusDot`, the title on one line (ellipsized, `--text-sm`, `--fg-2`), and one trailing datum in dim mono (`--text-xs`, `--fg-3`).
A blocked or held row carries exactly one dim word after the title; a child row indents one step (12px) per level.
Hover lifts the background one step (`--bg-3`); the row whose detail is open beside the panel is accent-tinted (`--accent-dim`) with the title at full strength and no border at all.
A click is a POINTING gesture - bring something to the front, open a record - never a write.

**FeedLine** - one line of a chromeless log: a semantic kind dot at the far left, the text (`--text-sm`, `--fg-2`, ellipsized on overflow), and relative age in dim mono (`--text-xs`, `--fg-3`) at the right.
The dot carries the only color: `--fg-3` by default, `--ok` / `--warn` / `--danger` for real state and `--captain` for the captain's own activity.
A line about a task leads with its key in dim mono.
Stack oldest to newest, newest at the bottom; no container or background.

**MicroLabel** - the uppercase tracked label that names a region (`--text-xs`, weight 500, `--tracking-label`, `--fg-3`), with an optional count beside it in dim mono.
It is how a panel labels a group without giving it a heading.

**Empty** - one quiet line where a list would be (`--text-sm`, `--fg-3`), in sentence case: "No open pull requests".
Never a box, never an illustration, never an exclamation.
It is for a SECTION that is empty inside a panel that is not - a panel with nothing at all to show is absent from the rail, which is data (its `presence`, or its own code's `rail.show`), not something drawn.

**Disclosure** - a region that shows only its count until it is clicked: a `MicroLabel` header with the mono count and a caret that turns a quarter on open, over `--dur-fast`.
Its body reveals with opacity and a 4 px settle down from the header over `--dur-fast`; an initially open snapshot is static, and closing unmounts immediately.
The shared reduced-motion durations cut the reveal.
The collapsed state is the calm default.
Everything richer hides behind a click.

```jsx
<MicroLabel count={3}>Working</MicroLabel>
<Row title="Refactor the auth middleware" tone="warn" trailing="FM3K-9" />
<Row title="Add the retry test" tone="ok" trailing="FM3K-10" depth={1} />
<Empty>Nothing working</Empty>
<Disclosure label="Landed" count={7}>{...}</Disclosure>
<FeedLine kind="report" tone="ok" time="4m" taskKey="FM3K-9">Test matrix green across three machines</FeedLine>
```

A panel's title, collapse and attribution are the HOST's chrome, rendered from the manifest - a panel never draws its own title bar, border or card.

**Header buttons.**
A panel may name up to three buttons for its header; the host draws them beside the chevron.
A button that names one of the panel's cards is drawn in the same place whether the panel is expanded or collapsed; one that names none is drawn only while the panel is expanded, so a collapsed header keeps its room for what the panel says.
Each is a 24 px `IconButton` at `--fg-3` wearing one of the app's own 14 px Lucide icons, never the panel's: `open` (maximize-2), `search`, `add` (plus), `list`, `note` (file-text), `filter`, `clock`, `chart` (bar-chart).
Its words and the key of the panel's command that does the same show on rest, as on every icon button.
A button that names one of the panel's cards puts it up at the front of the stack (`components/cards/PanelCard.prompt.md`) and leaves the panel as it was, collapsed or not; one that names none opens the panel and is pressed into it, which then puts focus where the button points.

**The collapsed summary.**
A collapsed panel keeps running and says what it holds, from its own code; the host draws it as its own chrome in the header, after the title and the maker's name and before the buttons, exactly where the Tasks panel's counts sit.
Mono `--text-xs` `--fg-3`, right-aligned, one line that gives way with an ellipsis, at most three short parts joined by ` · `, and the part that needs the captain in `--fg-1` - "2 waiting · 1 working", with the waiting count lit only while it is not zero.
A count or two, never a sentence; nothing at all rather than "0 items".
A panel whose news is a stream (Activity) may instead say its newest line, which takes the title's place: a `FeedLine` row - a 5 px dot in its tone, the task key in mono `--fg-3`, the words in `--text-sm` `--fg-2` cut with an ellipsis - and the short parts after it at the right.
The header stays one row tall; the line is a chromeless button that opens the panel, and resting the pointer reads it whole.
The title, the line's words, its age and the short parts each centre their letters on the dot and the chevron (readme, Type: one line beside a dot or an icon).
A new line rises in over `--dur-med` by `--move-stack` as the one it replaces lifts out over `--dur-fast`; with no line, the title is back.

**Pointing at a task.**
A panel that lists the captain's tasks draws each row with the app's own `TaskStatusMark` and status words, and its rows act as a Tasks row does: a click opens the task (its waiting card forward, or its record), and resting on it opens the crew summary beside the panel - or, in one of its cards on the stack, beside the row itself, as on the task board - joined by the same hairline, its beat and fade the Tasks row's.
A row whose task is open on the stack takes the open row's tint.
One accent per panel; `--ok` / `--warn` / `--danger` / `--idle` only for real state; numbers, keys and times in mono; sentence case; no emoji.
The tested subject panel in the lessons guide alone uses the lesson's warm voice: short praise for effort and strategy and exclamation points, never pressure, loss words or praise for being smart.
It puts the learner's goal above a fourteen-day practice strip, a protected practice run and banked rest days, skills as progress and one lit next-lesson pointer; it has no weekly target or achievements beyond learned skills.

**When a panel stops.**
A panel whose code throws, or will not load, is one quiet `--fg-3` / `--text-sm` line in its body, "This panel stopped drawing.", and the host's chrome stays.
A panel drawn in its own frame (one added from elsewhere) that stops answering altogether is torn down to "This panel stopped responding." with a `secondary` `sm` Retry Button on the same row - the card's stopped state, for a panel: no icon, no danger color, chrome unchanged.
A panel added from elsewhere is attributed by its maker's name in the header, the way the captain's own read "yours".

**The create-your-own-panel slot.**
The one place the app draws an EMPTY outline on a rail: the invitation to make a panel, at the top of the left rail, once three of the captain's crewmates have finished their tasks and while the captain has no panel of their own.
It is the app's chrome, not a panel - no title row, chevron or attribution - so it never reads as a panel with nothing in it.
A panel wide and 88 px tall, a 1 px dashed `--line-2` outline at `--radius-l`, no fill; centered, a 14 px plus in `--fg-3`, then "Create your own panel" (`--text-sm`, `--fg-2`) over "Tell your first mate what this should show" (`--text-xs`, `--fg-3`).
Hover lifts it to `--bg-2` and makes the outline solid; the keyboard draws the focus ring.
A 24 px `IconButton` Hide, an `--fg-3` x, sits in its top right corner and says "Hide" on rest.
It fades in with opacity over `--dur-med`, a cut under reduced motion, and leaves as a cut, so the panel it invited takes its place without a jump.
A click starts the ask in the message box; it never opens a card or a tip.
It reserves card room as an expanded panel does, so a card never covers it.

**When a rail runs out of room.**
Expanded bodies keep four list rows (`--rail-body-min-height`, 124 px, owned by `tokens/rails.css`); a body whose complete content is shorter needs only its content height.
When their shares would fall below that minimum, panels farthest from their anchored end fold to headers first: the lowest top panel or highest bottom panel, with top winning equal distances.
An explicit expand pins that panel after unpinned panels, using the existing false collapse record, not a new setting.
Folds are window state only and disappear when room returns.
A folded chevron reads “Expand [title] · folded for room”.
If headers alone cannot fit, the same middle-first order removes panels into one header-height More row at the rail’s foot, reserving room for that row too.
The row reads “[count] more”, followed by the hidden titles in dim mono, with a trailing chevron; it has no card background.
Its existing RowMenu lists titles and their last summaries, takes arrows and Escape, and stays inside the window with a scrolling menu when necessary.
Choosing an item moves it nearest its anchored end, persists the priority in the layout, and focuses its header; it does not change its collapse choice.
Tab reaches the More control and F6 treats it as part of the rail, with the usual focus ring.

The most recent More choice keeps a remaining header ahead of earlier pins, so choosing it really returns it to the rail.
