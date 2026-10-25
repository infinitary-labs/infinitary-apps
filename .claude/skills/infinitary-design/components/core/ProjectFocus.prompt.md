The top bar's project pill: one pill, centred in the bar, that focuses the window on one project and opens into a row of project pills centred on the bar (`docs/project-focus.md`).
It shows only while there are two projects or more.

**The pill at rest.**
A 26px pill with `--radius-pill`, a `--line-1` border and no fill; its name at `--text-sm` weight 500 in `--fg-2`, All projects or the focused project's name.
After the name its counts in mono `--text-xs` `--fg-3`: the waiting ring in `--accent`, then the working dot in `--warn`, each with its number, and nothing for a zero; the marks are the Tasks panel's.
Last, a chevron pointing right in `--fg-3`, because the projects open to the right of All projects.
Its rest label reads the name and both counts in words, with the key of Focus on a project.
Focused on a project, the pill has an `--accent-dim` fill and an `--accent` border, the one accent in the bar, with a 22px icon button × beside it, Show all projects.
After that, a quiet mono `--text-xs` `--fg-3` tail, "2 waiting elsewhere", counts what waits on the captain in other projects; it shows only above zero, and a press opens the row.

**The open row.**
A radio group, "Focus on a project": All projects, then one pill per project in the task board's order, 6px apart, each with its counts.
The checked pill has the focused pill's accent; a project with nothing waiting and nothing working has its name in `--fg-3`.
The row is centred on the bar, the same line as the folded pill, and held 12px inside the room between the bar's two groups when it is wider.
A row too wide for that room ends in a +N pill with the hidden projects' waiting count, which opens a menu of the rest (`--bg-2`, a `--line-2` hairline, `--radius-m`); the focused project always keeps its pill in the row.
The row ends in a 26px icon button, the same chevron turned back to point left, Close the project row, with the key Esc.

**Motion.**
Opening, each pill glides from the pill's left edge to its place, so the row fans out both ways, over `--dur-med` (`--ease-out`), fading in, each one 24ms after the last up to 120ms, and its counts fade in a beat after.
Folding plays the glide back into the pill over `--dur-quick`, the checked pill staying solid.
Reduced motion makes both a cut.

**Keys and focus.**
The arrows, Home and End move along the row; Enter or Space picks and folds it.
Esc closes the menu first, then folds the row; a press outside, the window changing size or losing focus folds it too.
Focus on a project (⇧⌘P) opens the row with focus on the checked pill, and folding returns focus to the pill.

**Light.**
A pointer or the keyboard resting on a pill in the row lights that project's crew on the stage before anything is picked: every other project's crewmates keep a quarter of their light (`components/mate/Crewmate`).
