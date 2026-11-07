Settings' tabs: one vertical column on the left of the Settings page, the shown section beside it.

**The page.**
The page is one centred column the width of the widest section plus the tab column, and it stays the same width whichever tab is shown, so the tabs never move when the section changes.
The page keeps a scroll bar's room whether or not the shown section scrolls, so a scroll bar that takes room neither moves the column nor narrows the section when it comes and goes.
The tab column is 168 px wide at the column's left gutter, then 32 px of room, then the section, left-aligned and no wider than its own width (760 px standard, 1080 px wide).
A narrow window shrinks the section, never the tab column; at the smallest window the section still has 700 px.
The sharing ask, when it shows, spans both above them.

**The column.**
The tabs stack top to bottom in the registry's order with 2 px between them, and the column sticks to the top of the page while the section scrolls under the top bar.
Its first tab's top lines up with the section's first label.
There is no heading over the column and no line beside it: the chosen tab's fill and the room between them part the two.

**A tab.**
One row, 32 px tall, the column's full width, `--space-2` by `--space-3` of padding, `--radius-s`, its label at `--text-base` / 500, left-aligned on one line and cut with an ellipsis if a long label ever needs it.
At rest the label is `--fg-3` with no fill; under the pointer it lifts to `--fg-2` on `--bg-1`.
The chosen tab is `--fg-1` on `--bg-2` with a 2 px `--accent` bar on its left edge, inset 6 px top and bottom - the page's one accent.
Colour and fill change over `--dur-fast`; the bar is a cut.

**Keys.**
The column is one Tab stop on the chosen tab, and one of the parts F6 moves between. ↑ and ↓ move to the previous and next tab and show it, wrapping around; ← and → do the same, so the keys from the old row still work; Home and End go to the first and last.
The keyboard draws the focus ring around the whole tab row, over its fill.
