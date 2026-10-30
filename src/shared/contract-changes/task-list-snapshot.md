# Task list snapshot

The `inf:work:tasks` request accepts optional `input.snapshot` and `input.ids`, and its answer may carry `order`.
With `snapshot`, a list that stops short also answers every matching task id in that read's order, one cut taken in the same read.
With `ids`, the home answers those tasks' rows in that order, so a crewmate reads later pages of the kept cut without a task that moved between pages dropping or repeating a row.
An older home lists neither: the computer that runs work sends a first page without `snapshot`, reads no later page, and the list names no next page.
