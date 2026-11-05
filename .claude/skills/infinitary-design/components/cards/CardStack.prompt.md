Wraps the one visible ResponseCard; ghost edges peek above when more cards wait, with prev/next + "2 / 5".
```jsx
<CardStack index={i} count={5} unreadBefore={0} unreadAfter={1} onPrev={p} onNext={n}><div style={{position: 'relative'}}><CardPeeks count={5}/><ResponseCard …/></div></CardStack>
```
The default stack width is 800px; each card keeps its own width while paging.
The arrows' labels carry the keys that page the same way from anywhere in the window (`prevKeys`, `nextKeys`: `⇧⌘[` and `⇧⌘]`).
Cards are prioritized by importance; only one is ever shown.
The stack is as wide as the shown card (`ResponseCard.prompt.md`, widths): its peeks follow that card, while the stage pager occupies a stable lane below the maximum-height envelope, with separate room for the last turn above the input.
A maximized card stands without peeks, and the pager keeps a 40 px lane of its own under it (`ResponseCard.prompt.md`, "Maximize").
Its optional `envelopeHeight` supplies that stage-only envelope.
A replacement uses its final width immediately, with no width easing.

A new card never steals the shown one - it lands on the stack unseen, and the pager says so: an `--accent` dot (6px, `--radius-pill`, ringed in `--bg-0`) on the arrow that leads to it, and one accent mono Badge "1 new" beside the pager, positioned outside the centred arrow group so the arrows never move under the pointer.
A reply never moves a card (INF-770): the shown card stays in its place with its thread, and when its author answers it redraws there, with the released update marked new until a foreground view draws it.
An author leaves `holds_place` unset unless the use case requires continuous attention on the card.
With that declaration, a newly arriving marked card comes forward even over another card.
A choice still closes immediately, with no held page or working line; paging away is respected by subsequent revisions and thread answers.
Cards without the declaration keep the rules above.
The exact released update counts as seen only after it actually draws in a foreground view; the owner shares that mark with every updated desktop window, iPhone and iPad.
A released revision or final author answer is new again, even with the same body and offer; redraws and ordinary pushes are not.
Selection alone and a prepared successor never count, and reading changes neither membership nor another view's selection.
No animation on the badge; the page number slides only when an arrow pages, and a change of count is immediate.
While cards are up the character frame is hidden, so the pager’s dot and count are the notice; loops continue unseen.

Notes never hide automatically after reading, elapsed time or paging away.
Close, Put aside, restoration, author withdrawal and ordinary task lifecycle rules retain their meanings.
Project filters and selection remain local, while ordinary card status and exact-update seen marks are shared.
An older home retains legacy local unread behavior; older desktop windows can retain their old hiding rule until updated.

The shown surface (card or card-and-thread pair) fades from 0 to 1, rises `--move-arrive` (12px) and grows from `--scale-arrive` (98%) over `--dur-arrive` (420ms) with `--ease-out` only when it appears on an empty stage.
Boot's initial card snapshot is static.
A revision, resize or unread push never restarts it, and the shared reduced-motion token makes it a cut.

Replacing one shown entry with another is one move, never an empty card (FI3-596; the moves are FI3-747's).
While the captain reads, the stage prepares the card a close would bring up - invisibly, at its final width, its body only - and a close promotes that same drawn body in place.
Any other destination is drawn first while the previous card stays in sight, inert, in exactly the rectangle it had; a click on that leaving drawing does nothing.
Once the incoming card has drawn, it appears by the move that took the previous card away, and the shell height eases to the incoming card's natural height over `--dur-med` / `--ease-out`, centre fixed:

- An arrow: the incoming card slides in from the arrow's side as the leaving drawing slides out the other way, both `--move-page` (32px) over `--dur-page` (300ms), and the page number slides the same way.
- A card that left the stack (a close, a closing action, a withdrawal): the leaving drawing drops `--move-drop` (10px) to `--scale-stack` (97%) and fades over `--dur-quick` (200ms), drawn over the incoming card, which comes forward from `--move-stack` (8px) up and `--scale-stack` at half opacity over `--dur-page`, while the peeks move up one place.
  The last card drops away the same way before the stage is empty.
- Anything else (a jump to a record): one crossfade over `--dur-fast`.

Title and body arrive together; there is no separate surface or body entrance, and width never eases.
Selection, actions and drafts change at once; a close never waits for the drawing.
Measurement never consumes animated shell height; corrections share one deadline.
Same-entry growth is immediate.
Resize, drag, focus inside the card and reduced motion cancel geometry; a press while the height eases holds the card still until the release, so the control under the pointer stays put.
Reduced motion makes every move and the easing cuts.
Scripted previews, task records, past cards, browser views and panels' cards are drawn when shown, not prepared.
A card whose thread opens, closes or moves keeps its body, its scroll and its reply field: only the surface's columns change.

Task records join this same stack as shell-held front entries, one per task, shown at once on open.
Hide or Esc closes only a shown record, and an accepted Start closes the record it started; no other card closes on Esc.
New cards never steal it.
Past cards (`components/cards/ResponseCard`, "Past card") join the stack the same way, one per saved card; Hide or Esc closes only a shown past card.
A task's browser view (`TaskBrowser.prompt.md`) joins the same way, one per task; Hide or Esc closes only a shown view and the browser keeps running.
A panel's cards (`PanelCard.prompt.md`) join the same way, any number per panel: one the captain asked for at the front, one a panel raises on its own behind the shown entry, marked new; Hide or Esc closes only a shown one.
A view a card's live attachment opened (`ResponseCard.prompt.md`) returns to that card on Hide or Esc while the card is still on the stack.
Only the shown entry supplies the turn hint.
Any entry hides the character, crew and labels over `--dur-slow`, snapping under reduced motion; all loops keep running.

Peeks use the same solid surface at full opacity: depth comes from their offset and hairline, not transparency.
Each entry drawing owns its peeks, so they share its readiness, fade, movement and retirement; the pager's envelope paints no separate decoration.
A closed drawing drops away immediately with its peeks even when its successor cannot draw yet.

Cards sort by priority, oldest first within each band.
Whenever the shown card leaves (close, Put aside, closing action, merge, withdrawal or task closure), reveal the first unread card in that order, else the first card - the captain's FI3-711 rule; a reply moves nothing.
The initial stack restores unread cards from the card owner's saved seen observations, without an arrival pulse or a continuity jump.
Paging alone clears only a legacy window-local mark; an exact-update mark remains until the owner confirms its drawn foreground reading.
The badge includes the shown update while it remains unread, but arrow dots count only updates before and after it.
Hiding a record reveals the first card.
Open task records remain ahead of cards for paging; if only records remain, show the first record.
An unseen departure moves nothing.
Explicit jumps still show their target, and the arrows keep stack order.

## Cards put aside

Live messages put aside stay open but leave the stack, its pager count and new dot.
They leave by the put-away navigation rule without a confirmation or any message.
Their reading place, picked answers and reply draft stay for this run.
A revision or author answer returns one unread; a pointed-at card returns at the front, focused at the default size.
Their put-away state is saved and shared by desktop and native views.

## Held back by the project focus

While the window is focused on a project (`components/core/ProjectFocus`), cards about other projects' tasks are held back: they stay open but leave the stack, its pager count and new dot, with no marker of their own.
They leave by the put-away navigation rule without a confirmation or any message.
Cards about no task stay, and so does anything the captain opened: a task record, a past card, a task's browser, a panel's card.
The pill's tail is the one notice: it counts what waits on the captain in other projects, held cards among them.
A card that arrives while held back stirs nothing; picking its project or All projects returns it to its place, unread if it arrived while held, seen if it had been seen.
A pointed-at card returns at the front without moving the focus, and stays until the focus changes.
Holding is this window's view, never saved; another Mac's view holds by its own focus, and the phone list stays unchanged.
