# Close routes for work delivered another way

INF-2626 found why a user's first mate held delivered tasks open, and the captain chose "File the checked fixes", fix 1: words in the first mate's close description.
A squash merge leaves a task's own commits outside the merged history, and a first mate could read that as a reason it could not close the task, though every close first keeps those commits on the task's kept ref.
A task whose own pull request closed unmerged while another task's merged pull request delivered its work had a working close, `carried_on` naming that other task, which the description did not name for this case.
`settle_task`'s description now says every close keeps unmerged commits, records and sessions, and squash merges never block closing, and that `carried_on` also closes work another task merged in its pull request.
To stay inside the fixed-context budget it says each of those once: "Records and sessions stay" and `carried_on`'s "commits are kept" fold into the every-close sentence, merge-pr's plain Git note drops "the default branch", and `carried_on`'s "as done through it" becomes "as done".
Its home is `settle_task`'s description; the words cost about 9 tokens of fixed context, net (`tests/firstmate-fixed-context.test.ts`).
