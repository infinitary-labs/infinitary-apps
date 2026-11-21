# Page unanswered

A task browser's open fact may carry `unanswered: true`: nothing answers at the loopback address its page is on, since a connection to it was refused.
A stopped fact may carry `quit: true`: the browser was open when Infinitary quit and was read again after the restart from the page kept with its task; its `stopped` is then `gone`.
`inf:work:browser-event` takes a new event kind, `unanswered`, with the page's site, address and the outage's once-name, which wakes the task's crewmate once from the home.
An older view ignores both fields and reads a quit as a page that stopped working.
A computer that runs work sends `unanswered` only to a home that lists this change, so an older home hears nothing and its crewmate is not woken.
