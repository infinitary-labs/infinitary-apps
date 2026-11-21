# Page start

A task browser's open fact may carry `starting: true` beside `unanswered: true`: nothing answers at its page, and Infinitary runs the start command its crewmate saved for that page while it waits for an answer.
`inf:work:browser-event`'s `unanswered` event may carry `start`: the saved command that ran on the computer that runs work, its exit code or that its wait ran out, and where its output is, for the crewmate's one wake.
An older view ignores `starting` and reads the outage as its crewmate being asked.
An older home ignores `start`, so its crewmate's wake says nothing answers without saying the saved command ran.
The order `inf:task-browser:turn` tells a computer that runs work when a turn of a task's crewmate begins or ends at the home, so a build Infinitary started there lives through that turn; a home sends it only to a computer that lists this change.
A computer without the change keeps no starts, so it is never told.
