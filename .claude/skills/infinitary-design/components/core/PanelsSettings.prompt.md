Settings → Panels: where each panel sits on the rails, in order, and whether it shows.
It is its own tab after Appearance; Arrange panels in command search opens it.

**The head.**
The `SectionLabel` "Panels", then one intro line at `--text-sm` / `--fg-3`: "Where each panel sits on your rails, in order."

**The rails.**
Two blocks, "Left rail" then "Right rail", each a `MicroLabel` over its two groups, "Top" and "Bottom", each group a quiet `--text-xs` / `--fg-3` label over one list box: a `--bg-1` panel with a `--line-1` hairline and `--radius-m`, rows parted by `--line-1` hairlines.
The blocks sit side by side when the section has room for two 300 px columns, and stack otherwise.
A group with no panel shows "No panels" at `--text-sm` / `--fg-3` inside its box.

**A row.**
Left to right: a 14 px grip (Lucide grip-vertical) at `--fg-3`; the panel's title at `--text-base` / `--fg-1` / 500, ellipsized, with an added panel's maker's name after it in dim mono as its header shows; then its state at `--text-sm` / `--fg-3`, right-aligned: "Shown", "Collapsed" or "Hidden".
A panel that would not be on the rail for a reason outside the arrangement says that reason instead, in the same place: "Nothing to show right now", "In the More row", "Shows when a rule is saved", "Shows once there is knowledge".
Its trailing control is a `Switch` named for it ("Show Tasks"), off while it is hidden; it takes the pointer, and the row answers Space for it, so it is no Tab stop of its own.
A hidden row's title drops to `--fg-3`, so the list reads as the rail does.
The row's height is 40 px, `--space-2` by `--space-3` of padding.

**Moving a row.**
Rows drag by the whole row as the rail's headers do (`components/panel/Panel.prompt.md`, "Moving a panel"), between rows, to the end of a group, or into an empty group of either rail; the landing line is the same 2 px `--accent`.
From the keyboard the rows are one roving Tab stop: ↑ and ↓ move focus between rows, crossing groups and rails in reading order, and Home and End go to the first and last; ⌥↑ and ⌥↓ move the focused panel one place, crossing between its rail's top and bottom; ⌥← and ⌥→ move it to the other rail's same group, at the end nearest the middle; Space shows or hides it, and Enter opens or collapses it.
Focus follows the panel it moved.
Under the rails, one line at `--text-xs` / `--fg-3` in `KeyCap`s: "⌥↑ ⌥↓ move · ⌥← ⌥→ other rail · Space show or hide · Enter open or collapse".

**Reset.**
A ghost `Button` sm "Reset to defaults" at the section's end, disabled while every panel already sits where it asks to be.
A first click arms it as a danger `Button` "Confirm reset", and leaving it disarms it; the second puts every panel back in the slot and order it asks for, and leaves each shown, hidden, open or collapsed as it was.
