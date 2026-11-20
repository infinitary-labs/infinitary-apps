The window's commands by name, over everything in the window: the keyboard's way to anything the app does without a mouse.
It opens on its key (`⌘K`) from wherever focus is, a card's or a panel's frame included, and closes on the same key, Escape, or a click beside it.
It is host chrome, never inside a card, and nothing in a card can open it.

**The surface.**
The modal-level surface the picture viewer uses: `--bg-0` at 80% under `--blur-overlay`, over the whole window.
On it one panel, centred across the window and 18% down from its top: `--bg-2`, a `--line-2` hairline, `--radius-l`, `--shadow-2`, `--space-3` of padding, as wide as six `--space-9` or the window less `--space-6` at each side.
`role="dialog"`, `aria-modal`, named "Search commands".
It grows in like a popover, from `--scale-pop` over `--dur-quick`, and fades out over `--dur-popover-out`, inert while it fades; reduced motion makes both a cut.

**The field.**
An `Input` at `size="lg"`, placeholder "Search commands", with the caret in it on open.
It is a combobox: the field keeps focus the whole time and names the chosen row (`aria-activedescendant`).
What is typed narrows the list to the commands whose words hold every typed word, in any order and case: a command's label, and the other words it is found by (release notes find Show what's new).

**The rows.**
One row per command, in the catalog's order: its words at `--text-base`, `--fg-2`, and at the row's end its first key in one `KeyCap` (`⇧⌘L`), or nothing for a command chosen only by name.
The chosen row has an `--accent-dim` fill and its words in `--fg-1`; it is the panel's only accent.
A command that cannot run now stays on the list: its words in `--fg-3`, and under them, at `--text-sm` / `--fg-3`, the reason in a few plain words ("This is the only card", "A recording is running").
Choosing it runs nothing.
No match leaves one quiet line, "No command matches", at `--text-sm` / `--fg-3`.
A panel's own commands follow the app's, each panel's under its title: the title as the uppercase tracked micro label (`--text-xs`, weight 500, `--tracking-label`, `--fg-3`) above its rows, never a row itself, and typing the panel's title finds them.
Under the list one hint at `--text-xs` / `--fg-3`: "Arrow keys choose · Enter runs · Escape goes back".

**The keys.** ↑ and ↓ move the chosen row, wrapping at either end; Enter runs it; Escape closes the search and nothing else; Tab stays in the field.
While it is open its keys reach nothing underneath: the shell's Escape, the dictation key and the stack's paging never hear them.
A pointer resting on a row chooses it, and a click runs it.

**Where focus goes.**
Closing gives focus back at once to what had it: a field in the shell, or the field, link or picture inside the card or panel frame it was in, its caret where it was.
When that is gone, focus lands by the window's rule: the main message while the person was typing, otherwise the shown card.
Each opening starts with an empty field and the first row chosen.
A command chosen in it runs after focus is back, so a command that moves focus moves it from there.
