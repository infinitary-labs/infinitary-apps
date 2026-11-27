# A person's own color themes on the own-theme line

The second piece of the approved plan for color themes: a person makes a color theme of their own by asking the first mate in plain words.
The new `own-theme` action line (`asked`) mirrors `ambient-own-style`: `save` takes a name, an optional built-in theme to start from and the colors that differ as `#rrggbb`, and `remove` takes a saved theme's name or id.
Its words tell each color's job, say that the app keeps colors readable and that the answer names each color it moved, and that a theme with a fault is refused in words with nothing changed.
A save wears the theme at once in the window that asked, and saving again under the same name changes it.
The `theme` line now also takes an `own-` id the `own-theme` line names, and `app_state` gains the `theme.own-theme` read, one saved theme whole.
The rules' one home is the `own-theme` action line, with one clause on the `theme` line and the read's own description; nothing else the first mate is served changes.
It adds about 350 tokens where action lines are served.
