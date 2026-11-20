The key reminder: after a mouse click on a control whose action has a key, one quiet line at the bottom of the window names the action and its key, so a person who clicks learns the key without waiting on a label (`docs/keyboard.md`, "The key reminder").
It is host chrome, never inside a card or a panel's page, and it shows on home and in Settings alike.
A click on a control inside a panel's own page, such as the task board's Backlog, shows it too, at the same place at the bottom of the window.

**The line.**
Centred on the window's bottom edge, `--space-3` up from the bottom, sized to its words and never closer than `--space-4` to either side.
`--bg-1` with a `--line-1` hairline, `--radius-m`, `--shadow-2`, and `--space-2` by `--space-3` of padding, the next-keys hint's surface.
It takes no pointer and no focus: a click passes through it to what is underneath, and nothing on screen moves when it shows or goes.
Assistive technology skips it (`aria-hidden`): the control already names its key in `aria-keyshortcuts`.

**What it reads.**
First the key in one `KeyCap`, the key the control's own label shows (the command's first key in the installed map).
Then the action's words, the ones command search uses, at `--text-sm` / `--fg-1`.
A key that works only when not typing reads "when not typing" after the words, at `--text-sm` / `--fg-3`.
Last, `--space-3` after, "press it once and this stops" at `--text-xs` / `--fg-3`.
It has no accent: nothing on it waits for a press.

**When it shows and goes.**
Only a pointer's click shows it; Enter or Space on a button, a command's own key and command search never do, and a control with no key shows nothing.
It shows for `--hold-key-reminder` (5 seconds), then goes; any key or another press takes it away at once, a press inside a panel's page included, and a click on another control with a key shows that one instead.
It fades in as an in-place fade does, opacity only over `--dur-fast` on `--ease-out`, and when its time is up it fades out the same way; a key or a press still takes it away at once.
Reduced motion makes both a cut.
It stops for an action once the person pressed that action's key, until the key changes; the four card choice keys count as one.
Settings → Keyboard's one switch, "Show an action's key after I click it", turns every reminder off; it is on for a new profile.
