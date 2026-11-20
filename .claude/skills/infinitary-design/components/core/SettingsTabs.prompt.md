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
On the see-through window the label rests at `--fg-2`, hover fills `--bg-1` at 35% and the chosen tab `--bg-1` at 55% (below).
The chosen tab is `--fg-1` on `--bg-2` with a 2 px `--accent` bar on its left edge, inset 6 px top and bottom - the page's one accent.
Colour and fill change over `--dur-fast`; the bar is a cut.

**Keys.**
The column is one Tab stop on the chosen tab, and one of the parts F6 moves between. ↑ and ↓ move to the previous and next tab and show it, wrapping around; ← and → do the same, so the keys from the old row still work; Home and End go to the first and last.
The keyboard draws the focus ring around the whole tab row, over its fill.

**On the see-through window.**
The Mac's see-through window (`html[data-window-material="translucent"]`, the app's `docs/translucent-window.md`) shows the desktop behind Settings, so Settings is retuned there and only there.
While Settings shows, the body's one tint rises to at least 65%, fading over `--dur-med` and back on leaving; a Window wash already stronger is kept.
Every box in the section fills with its `--bg-1` or `--bg-2` at 55%, so it takes the hue behind it instead of standing as an opaque slab.
Neighboring Settings rows join into one box per section: the rows keep their padding, lose the 12 px gap and their inner corners, and are parted by `--line-1` hairlines.
Quiet text - tab labels at rest, section labels and row descriptions - is `--fg-2` instead of `--fg-3`.
Opaque windows, Reduce transparency included, keep solid `--bg-1` boxes one per row, `--fg-3` quiet text and the chosen tab on `--bg-2`.
