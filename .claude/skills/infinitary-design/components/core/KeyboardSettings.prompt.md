Settings → Keyboard: every command the keyboard runs, its keys, and the way to change them.
It is its own tab, after Appearance; a computer that controls another keeps it, because the keys are that computer's own.
Open Keyboard settings in command search, and Keyboard Settings… in the app menu, open it with the caret in its search.

**The head.**
The `SectionLabel` "Keyboard" at the tab's top.
Under it one line: an `Input` "Search keys" taking the room, and at its end a ghost `Button` sm "Reset all keys", disabled while nothing is changed.
A first click arms it as a danger `Button` reading "Confirm reset"; the second resets, and leaving it disarms it.
When saved keys could not be read, one line at `--text-sm` / `--warn` says so above the list.

**The list.**
One `--bg-1` panel with a `--line-1` hairline and `--radius-m`, its rows parted by `--line-1` hairlines, `--space-3` by `--space-4` of padding each.
A row reads left to right: the command's words at `--text-base` / `--fg-1` / 500, a neutral `Badge` "Changed" beside them when a person changed its keys, and under them where it works at `--text-sm` / `--fg-3` ("Anywhere in the window", "In the main message and a card's reply", "In the main message").
Then its keys, one `KeyCap` each, a two-key shortcut's two caps side by side with `--space-1` between, or "No key" at `--text-sm` / `--fg-3`.
Then a secondary `Button` sm "Record", and ghost `Button`s sm "Remove" (disabled with no key) and "Reset" (disabled unless changed).
Each button names its command for assistive technology ("Record a key for Show the next card").
A panel's own commands follow the app's in the same list, each saying where it works as its panel's title, then "anywhere in the window" ("Reading list · anywhere in the window"); the search finds them by the panel's title too.
The key a panel suggests is theirs only where no other command already uses it, and a key of a person's own is recorded on the row like any other.
A search that matches nothing leaves "No command matches" in the panel.
Commands a newer version saved keys for follow in a second panel: the id in mono, "Not in this version of Infinitary.
Its keys stay saved for the version that has it, and run nothing here.", and the keys, with no buttons.

**Recording.**
Record opens the recorder across the row's full width: `--bg-2`, a 1 px `--accent` border, `--radius-m`, `--space-3` of padding; it is the section's only accent.
In it, the keys pressed so far as key caps, or "Recording…" at `--fg-3`; then one line saying what saving would do, at `--text-sm`: "No other command uses it.", "That is already its key.", or the clash in full ("⌘L already runs “Go to the main message” anywhere in the window.
Saving moves it here, and “Go to the main message” will have no key.") at `--fg-2`, or the reason a key is refused at `--warn` ("⌘Q quits Infinitary").
Then the keys' hint at `--text-xs` / `--fg-3`: "Enter saves · ⇧Enter adds it beside the other keys · Esc cancels", with "Another key now makes it two keys" when it would.
Last, a primary `Button` sm "Save", a secondary "Add beside the others" and a ghost "Cancel", each disabled when it would do nothing.
While it records, every key goes to it and runs nothing else, the window's own keys and the menu's included; a click on Cancel, Escape, or the window losing focus stops it.
A refusal from saving stays under the row's words as a `SettingError`.

**Where a key works.**
A window command's saved key that holds Command, Control or Option, or is a function key, has a compact native select beside its caps: "Anywhere" or "When not typing".
It uses the shared Settings type, background, hairline, radius and focus ring; Tab reaches it and the arrows choose its value.
The selector stays outside the recorder, which intentionally consumes keys, and is disabled while that row records or saves.
A bare recorded key automatically works only when not typing and says "When not typing" in quiet text beside its caps, including while recording.
A plain or function key without Command or Control may answer or end a card.
When recording one for an answer, Done or Decline command, show a separate `--text-sm` / `--warn` line: "One press of this key can answer or close a card.
This can also happen while typing inside a card if Infinitary does not recognize its text field."
Keep the normal saving verdict and the existing availability rules for Save and Add beside the others; this warning adds no confirmation and never refuses the key.
A key held with Option alone works anywhere and stops typing its character in text fields, so recording one shows the same kind of `--warn` line, naming the character when the press typed one other than its own letter: "⌥X types “≈”, which no text field will take from this key once it is a shortcut.", otherwise "⌥X will no longer type in any text field once it is a shortcut."
Previously saved keys like these keep working and do not prevent other changes; the default answer keys stay Command+1 through Command+4.
