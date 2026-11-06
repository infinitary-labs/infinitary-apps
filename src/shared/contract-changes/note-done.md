Live notes optionally carry `noteDone`, their one button: its label, its rest words and whether the click closes the note's task.
The label is "Done" when the click closes the task as answered and "Got it" otherwise; the core decides and every view draws what it sends.
The new `inf:cards:note-done` request presses that button: Done closes the answer task as answered, and Got it reads the note and tells its live author.
The close request now only puts any live card aside, notes included, and the corner's operation for a note is `aside`.
The core still sends `answerDone` on the marked answer note, so an older view keeps its Done there and ignores the new field.
A newer view with an older core draws the note's button only when `noteDone` is present, and keeps the older Done otherwise.
