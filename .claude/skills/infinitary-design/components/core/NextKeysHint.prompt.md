The next-keys hint: once the window takes the first key of a two-key shortcut, a quiet strip at the bottom of the window lists each key that may follow and what the pair does (`docs/keyboard.md`, "Two-key shortcuts").
It replaces the old silent wait: the window waits with no time limit while the hint shows, so the hint is the one sign that a key is pending.
It is host chrome, never inside a card or a panel, and it shows on home and in Settings alike.

**The strip.**
Pinned to the window's bottom edge, `--space-4` in from each side and `--space-3` up from the bottom, over the rails, the cards and the main message, under command search.
`--bg-1` with a `--line-1` hairline, `--radius-m`, `--shadow-2`, and `--space-2` by `--space-3` of padding.
It takes no pointer: a click passes through it to what is underneath.
`role="status"`, named "Next keys", so a screen reader hears it once as it appears.

**What it reads.**
First the pressed key in one lit `KeyCap` (an `--accent-dim` fill and an `--accent` border, the strip's only accent), then "then" at `--text-sm` / `--fg-3`.
Then one entry per next key, in the catalog's order and then the panels': its key in a `KeyCap` and the command's words at `--text-sm` / `--fg-2`, wrapping onto more lines when they do not fit, `--space-2` by `--space-4` apart.
A two-key shortcut whose first key holds ⌘ reads that way (`⌘K` then `S`); a plain first key reads as itself (`G` then `T`), and an arrow as its glyph.
Last, at the strip's end, one hint at `--text-xs` / `--fg-3`: "Esc cancels · another key acts as usual".

**When it goes.**
A listed key runs its command and the strip goes; Escape ends the wait and the strip goes; any other key ends the wait and acts as it would have; the window losing focus, a navigation and recording a key end it too.
It appears and goes as a cut, with no motion.
