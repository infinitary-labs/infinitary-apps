# A reply line keeps its words as written

The `firstmate_reply` push and the reply of `inf:conversation:last-turn` admit an optional `words`: the first mate's closing words with their line breaks, sent only when they differ from the one-line `text` (INF-1103).
The window's reply note shows them; without them it shows `text`.
An older side drops the field, so its reply note, where it has one, shows the one line.
