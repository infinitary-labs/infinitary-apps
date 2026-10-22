# Knowledge browser

The knowledge browser shows your standing directions and your knowledge graph - concepts and findings, each with its evidence - as a 3D map of concepts and two structured lists, with one inspector beside them.
It is the captain's approved design (FI3-1110, with its camera and connection revision) and exists in every build, stable included.
In the app it is the Knowledge panel's card (`components/cards/PanelCard.prompt.md`), `src/panels/knowledge/cards/browser.tsx`; the behavior is the app's `docs/knowledge.md`, "The browser".
Browsing reads and never writes: rotating, selecting, filtering and opening evidence change no knowledge, record no use and approve nothing.
The app's other surfaces open the same inspector: a reference in an answer (`../cards/ResponseCard`, Knowledge references in a body) and a task record's Knowledge used row (`../cards/TaskRecord`).

## The Knowledge panel

A compact panel in the right rail, under Tasks (`components/panel/Panel.prompt.md`), titled Knowledge by the app's chrome.
It is there while a collection holds an entry or the collection cannot be read; with nothing recorded anywhere there is no Knowledge panel and no Open Knowledge, and the first direction, personal fact or requested reference brings both.

- Its header has one button, Open Knowledge (`open`, Lucide `maximize-2`), drawn in both header states, which puts the browser up at the front of the stack on the Directions tab.
- Its body lists up to four directions in their own words, directly under the Knowledge title with no inner heading.
  Captain-origin instructions come before agent advice, each group newest first.
  Each line is `--text-sm` `--fg-2`, ellipsized; cut words appear whole in the app's rest label for pointer and keyboard alike.
  A project direction ends with its project name as a quiet mono `--text-xs` `--fg-3` tag.
  A click or Enter opens that direction in the browser's inspector.
- Under a `--line-1` hairline, two quiet links say All N directions and Graph · N concepts, each only while it holds something.
  They open the Directions list across all projects or the Graph tab respectively.
  Lines and links share one Tab stop; ↑ ↓ Home End move and Enter opens, and F6 lands here.
- It starts collapsed and says one total at the header's right beside the Knowledge title, as the other panels' collapsed counts do, never in the title's place.
  The title and one count fill the rail: "5 directions" while it holds a direction, otherwise "2 concepts", and never finding counts.
- An unreadable collection is one quiet line in its body, the app's own words for why, and no counts.

Its command, Open Knowledge, is found by name in command search and has no default key; it opens the browser where it is, your graph when fresh.

## Where the browser opens

The browser is one wide card of `fill` height on the stack, as the task board is: up to 800px, giving way to the docks, as tall as a card may be, its own rows staying while its panes scroll.
There is only ever one: the card's name, `browser`, is its id, so a second press brings the open one forward.
The header's Open Knowledge and All N directions bring it forward on the Directions tab, and Graph · N concepts on the Graph tab, each starting that tab afresh.
Its title row is the app's: Knowledge and Hide.
While it is open it keeps its collection, Find, tab, selection, inspector section, camera, neighborhood and pages across paging; Hide or Esc lets all of it go, and the next browser starts fresh on your graph, the Graph tab and the neutral camera.
A reference or a Knowledge used row puts it up with the inspector on that entry - at the revision the row names - in the entry's collection, over whatever tab it shows, with the keyboard on the inspector's section; the live line says what opened.

## Anatomy

Under the title row, top to bottom:

- **Its row**, over a `--line-1` hairline: Find, a small input ("Concept, alias or finding", or "Direction") at the right.
  There is one captain-owned graph and no Collection picker or Older notes control.
- **The tabs**: Directions, Graph, Concepts and Findings, text buttons in `--text-sm` `--fg-2` as a `tablist`; the selected one is `--accent-dim` with an `--accent` border and `--fg-1`. ← → move between them.
  On Directions, a Project filter at the right offers All projects, Everywhere, and registered projects.
  It filters only directions and leaves the graph unchanged.
- **The body**: the tab's pane on the left and the inspector on the right, a `--line-1` rule between them; the inspector is 300px wide and both scroll on their own.
- **The live line** under the body: what the last selection or camera move did, `--text-sm` `--fg-3` (`role="status"`), with no height while empty.

Mono `--text-xs` `--fg-3` carries every count and revision number; sentence case everywhere; no emoji.
One accent per card: `--accent` marks the selected thing - a concept, a connection, a row - and nothing else.
`--warn` is for a finding that needs rechecking or has differing evidence; `--ok` for a finding checked with evidence.

## The graph

Concepts only, never findings or sources: a finding's evidence stays beside it in the inspector, not as hundreds of extra points.

- **Its head**: the count in mono `--text-xs` `--fg-3` ("9 concepts · 12 connections · 3D", or "75 of 140 concepts shown · 65 not shown" when the collection is larger than a view), then Focus nearby with its hops select (1 or 2 hops) and Reset view, small quiet buttons, at the right.
  Focus nearby shows the selected concept and its neighborhood; pressed again it shows the collection.
- **The drawing**: an SVG at the pane's width and 360px tall on `--bg-1`, a `--line-1` border and `--radius-m`; it is one Tab stop (`role="listbox"`, each concept an option) and draws the focus ring while it has focus.
  Each concept is a dot at its real 3D place, drawn back to front under perspective: a nearer dot is larger and stronger (`--fg-3` at 80% near, down to 40% far), a farther one smaller and fainter.
  The selected concept is `--accent` with a ring; its label and its neighbors' labels are drawn, and every other label only where it fits.
  A label is a `--bg-2` tag at 93% with `--radius-s`, the name in `--text-sm` `--fg-2` (`--fg-1` when selected), placed above or below its dot where it overlaps no other label, with a `--fg-3` leader back to its dot; a label that cannot be placed is not drawn.
  The layout is computed once from the collection and stays put while exploring: no idle rotation, no drift, no simulation running, no stars or decoration.
- **Under it**: the legend, "Solid arrow: recorded claim · Dashed line: read together · Depth is layout only", in `--text-xs` `--fg-3`; then Orbit left, Orbit right, Zoom in and Zoom out as small quiet buttons with the zoom in mono ("100%"); then the key hint, "Left or right drag: orbit · Scroll while focused: zoom" and "Arrows: select · Shift + arrows: orbit · Enter: inspect · Home: reset", in `--text-sm` `--fg-3`.
- At most 75 concepts and 200 connections are drawn; a larger collection draws its most connected concepts and says how many are not shown, and Focus nearby or Find narrows it.

### Connections

- A **recorded claim** is a solid line with an arrowhead, from its subject to its object, as a finding states it: its label is the finding's own predicate ("pins", "keeps"), never one the app infers from words or geometry.
  It is a claim, not a verification badge: its evidence status is its finding's.
- A **read together** link is a dashed line with no arrowhead: a suggestion to read two concepts together, with its reason in the inspector, never a claim.
- Disagreements and replacements between findings are not drawn: they are the History section's.
- Lines are `--fg-3`: 80% for the selected concept's own, 22% for the rest; a selected connection is `--accent` and 2.2 wide, its two ends lit, every other line dimmed.
- Predicates are drawn only for the selected connection, or the selected concept's own claims: a `--bg-2` tag with a `--line-2` border (`--accent` when selected) at the line's middle, moved along it or aside until it overlaps no other label, with a leader to the line; one that cannot be placed is left to the list below.
  Never every predicate at once.

### Connections for a concept

Under the graph, over a hairline: "Connections for [concept]", then one row per connection of the selected concept - the subject, the predicate in `--fg-1` weight 500 and an arrow, the object, or "[one] read with [other]" for a read-together link - and under it, in `--text-xs` `--fg-3`, "Recorded claim · [status]" or "Read together · not a claim".
It is the readable fallback when labels crowd or a point is outside the zoomed view: the rows are one Tab stop, ↑ ↓ move, and Enter or a click opens the connection in the inspector, selecting it on the graph too.

### The camera

The camera orbits the graph's fixed center, as a game camera orbits a character (the captain's words: "follow how popular video games do it - like WoW camera control"):

- A drag to the right moves the camera to the right, the opposite of dragging the scene: the view turns right, so the far side of the graph sweeps left and the near side right.
  A drag up or down tilts it, and the left and the right mouse button orbit alike.
  There is no inertia, no pointer lock and no recentering, and the browser's context menu is suppressed only over the graph.
- A drag never selects: a press that moves past 5px orbits, and the selection stays as it was.
- Orbit left and Orbit right, and Shift with ← →, move the camera the same way the pointer does; Shift with ↑ ↓ tilts it.
- Zoom in and Zoom out, + and −, and the wheel while the graph has focus zoom from 60% to 145%; the wheel before the graph has focus scrolls the card, and a wheel with ⌘ or Ctrl (the window's own zoom) is never taken.
- Reset view and Home return to the neutral camera, never a camera someone once chose.
- Under reduced motion nothing animates anyway: every camera move is a cut.

### Keys

← → ↑ ↓ choose the previous or next concept and select it; Enter opens it in the inspector, with the keyboard on its selected section.
Escape in the inspector goes back to the pane where the keyboard was (Back, in a narrow card), then clears Find, then hides the card.

## Concepts

A list of the collection's concepts, twenty a page, by name: each row is the name in `--text-base` `--fg-1`, its explanation under it on one line in `--text-sm` `--fg-3`, and its findings in mono `--text-xs` `--fg-3` at the right ("2 findings").
The head says the count ("9 concepts", or "3 of 9 match" with Find); a page past the first has Previous and Next with the range ("21–40 of 52") above and below the rows, as the task board's lists do.
The rows are one Tab stop: ↑ ↓ Home End move and select, Enter opens the inspector.

## Findings

A list of the collection's findings, twenty a page: on the left the finding and its context - the statement in `--text-base` `--fg-1`, and under it in `--text-sm` `--fg-3` the conditions where it holds; on the right its evidence and attention - a status chip and, under it in `--text-xs` `--fg-3`, its evidence ("2 sources · checked").
The status chip is mono `--text-xs` on `--bg-2` with `--radius-s`: Checked (`--ok`), Not yet checked (`--fg-3`), Needs rechecking (`--warn`, a cited source changed or is gone since it was kept), Differing evidence (`--warn`, a check with evidence or another finding contradicts it), Superseded and Retired (`--fg-3`).
Show, a select at the head's right, filters the list: All findings, Needs rechecking, Differing evidence.
Keys as Concepts.

## Directions

Directions is a read-only list across all registered projects plus Everywhere, using the same paged rows, Find, arrow keys and inspector.
Its Project filter narrows this list; removed projects stay out, and a same-name replacement never inherits their directions.
Each row shows the complete direction, its exact project applicability, and whether its recorded origin is the captain or advice from an agent or a crewmate report.
Neither a direction nor a saved claim grants permission.
The inspector shows current words, project, origin and lifecycle, then every Knowledge edit on paged History rows, including its evidence and date.
An imported active direction starts at Knowledge revision one; there is no old-note archive.
Ask about this still drafts a question with the direction identifier; there is no edit or delete control.
Directions lead the collapsed summary; concepts stand in only while there are no directions.
A profile holding only those records can open Knowledge.

## The inspector

One inspector for all tabs, showing the one selected thing; with nothing selected it says "Select a concept, a connection or a finding to read it here."

- **Its head**: an uppercase micro label naming what it is (`CONCEPT`, `FINDING · REVISION 2`, `FINDING · REVISION 1 OF 2` for an earlier one, `RECORDED CLAIM`, `READ TOGETHER · NOT A CLAIM`), the name or statement in `--text-md` `--fg-1` weight 500 as the shown revision says it, and for a finding or a claim its status chip at once - an `Earlier revision` chip in its place while an earlier revision is shown, since a status is the current revision's.
- **Its sections**: Overview, Evidence, History and Used in, small text tabs as the browser's own; Overview first each time something new is selected.
- **Overview**:
  - A concept: its explanation, "Also found as" with its aliases, Connected ideas (each other concept, the predicate or "read together" and the reason), and Supporting findings (each finding about it with its status), each row opening that thing.
  - A finding: its statement, whether it was observed or reasoned to, the conditions where it holds, its relationship as a sentence when it claims one, and its concepts.
  - A recorded claim: the whole relationship as a sentence ("Evidence pins Source versions"), its status at once, the supporting finding (a row that opens it, with "Open its evidence before relying on this relationship"), and its two concepts.
  - A read-together link: "[one] read with [other]", Why these connect (its reason), "This is a reading suggestion, not proof of a relationship or a causal claim.", and its two concepts.
- **Evidence**: each kept source - a file's path and lines with the commit it was captured at, a task's report by key, or a quotation's citation - with what it reads like now (unchanged, changed, missing, or not checked by the app), and its kept text in a `--line-1` panel in mono `--text-xs`; then each check with its verdict, method, conditions and the revision it checked.
  A concept's evidence is its own sources; a claim's is its finding's.
- **An earlier revision**, opened from a Knowledge used row or from History, reads as it was in every section, and Overview leads with **Compared with the current revision**: one quiet line that this is revision N, the current one is M and reading either changes nothing; then one panel each for what it says, where it holds (a concept's explanation in its place) and its kept sources, headed in mono `· unchanged` or `· changed` - a changed one on `--bg-2` with a `--line-2` border, both revisions' words under small `Revision N` labels; then `Now:` with the current status chip; then Show the current revision.
- **History**: the revisions, newest first, each with what changed and who - the one shown says so, every other has Read revision N (Read the current revision for the newest), a small quiet button that opens it here - and the disagreements - contradicts, supersedes, duplicates - with the other finding and the reason.
- **Used in**: the declared uses, each with the task, the revision it used and its purpose; "Declared use, not proof the reasoning was right."
  None reads "No work has declared it used this yet."
- Show on graph, under a finding or a concept, selects it on the Graph tab.
- **Ask about this**, a small quiet button under every section of every selection, over a `--line-1` hairline: it starts the captain's next message with one editable line about exactly what is shown - `What should I know about the finding “…” (f-ejtt2f, revision 1)? `, its words quoted short, its id and revision so the first mate reads that very record - and puts the keyboard there with the caret after it, keeping anything the captain had typed after it.
  It sends nothing, files nothing and writes nothing: only the captain's own send asks the first mate, and the live line says the question is ready.


## Empty and unavailable

A collection with nothing recorded says so in the pane, one quiet paragraph, without a secondary source: "Nothing is recorded yet.
Tell your first mate about yourself or share an article you want to keep."
A collection that cannot be read says the app's own words for why ("Knowledge could not be read, so this version leaves it untouched."), and never a zero.
A Find with no match says "Nothing here matches" with the words; a filter with none says so in its own words.

## Narrow windows

Under 720px of card - a narrow window, or a card beside the docks or drawn narrower - the browser is one column: the inspector replaces the pane when something is opened, with Back at its top, and Back or Esc returns to the pane where it was.
Text never shrinks to fit two columns, and the graph keeps its height.
