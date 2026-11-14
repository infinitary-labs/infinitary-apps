Adds an optional `input` field to the shell's submission metadata (`CardSubmission`) on `inf:cards:act` and `inf:cards:note-done`, and to an `action` card observation's payload: what pressed the card's button - a pointer, Enter or Space on the button, or a window command by its key or from command search.
A home without the change reads the submission strictly, so a view leaves `input` out of what it sends there, and the press is recorded as before with no input.
A view or phone that sends no `input` is recorded without one, as unknown.
