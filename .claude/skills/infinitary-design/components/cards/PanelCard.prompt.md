One of a panel's cards on the stage: a card a side panel puts up beside the captain's other cards, any number of them, whoever made the panel (the captain's plan FI3-1014; the app's `docs/ui-plugins.md`, "A panel's cards").
A panel's code puts one up with `cards.emit`, and a header button or a command the panel declares puts up one it names; the app draws the card's chrome and the panel's card view draws the rest.

**Where it sits.**
It is a shell-held entry on the card stack, like a task record (`CardStack.prompt.md`): it pages with the stack, is never persisted, never a card the first mate wrote and never a feed line.
The task board is one, the Tasks panel's.
Its width is the stack's own, `regular`, `wide` (the default) or `full`, as the panel asks, giving way to the docks first like any card.
Its height follows its view's own, or, for a card that asks to `fill`, is as tall as a card may be, the view's own rows staying while its body scrolls inside, as the task board's columns do.
A card put up from the captain's own click or key - on the app's header button, by its key, or inside the panel or a card - comes to the front and is shown at once.
One a panel puts up on its own waits behind the card the captain is reading, marked new like an arrived card, so it never takes the stage from the captain.
Putting up a card whose id is open revises it in place: its title, width and data change and nothing moves; a press that puts it up again is heard by its view, so the task board's Find on task board puts focus in Find each time.

**One row of chrome**: `--space-2` padding with `--space-4` at its start, a `--line-1` hairline under it.

- The card's title at `--text-md`, `--fg-1`, weight 500, on one line that gives way with an ellipsis.
- Who made the panel in mono `--text-xs` `--fg-3` right after it: `yours` for the captain's own, the maker's name for one the captain added, nothing for the app's own panels.
- Hide, the surface's own cross (`IconButton`, label `Hide`), at the row's end, with the size control right before it (`ResponseCard.prompt.md`, "Maximize").

**The body.**
Under the row, the card's view in the side panel body's type: `--text-sm`, `--leading-body`, `--fg-2`, on the stack's ordinary surface with the card's own scroll.
It is built from the same library as a panel (`components/panel/Panel.prompt.md`) and never draws its own title bar, border or close.
A view that throws or will not load is one quiet line, "This card stopped drawing.", inside the same chrome; a view drawn in a frame of its own that stops answering is the panel's stopped state with its Retry.

**Keys.**
F6 lands on it like any shown card; when its view runs in a frame of its own, the frame takes the focus with it.
Esc hides it unless something in the card used the key (a field clearing itself), and Hide does the same; a maximized card restores on that Esc first.
Only the shown card runs its view: a card waiting its turn draws nothing until it is shown.

**Where it was.**
A card the captain pages away from and back to comes back as the captain left it - its Find, its tab, where it was scrolled - because its view keeps its place on the card's entry; Hide lets that go, and the next card starts fresh, as the task board does.

**The turn's hint.**
A card that lists tasks may make one the subject of the captain's next message, as a shown record does: the row the captain selected takes the open row's tint, and while the card is shown, what the captain types is about that task.

**What takes it away.**
Hide or Esc, its panel's own code, removing the panel, or turning the panels off; a relaunch starts with none.
